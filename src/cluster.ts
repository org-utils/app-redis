import type { RedisClientWrapper } from './client.js';

/* -------------------------------------------------------------------------- */
/* Slot-aware multi-key primitives for Redis Cluster.                          */
/*                                                                             */
/* These helpers are the ONLY place where cluster topology is handled for      */
/* multi-key operations. Higher layers (cache, session, ...) must consume      */
/* these instead of reimplementing slot grouping or reaching into ioredis      */
/* internals.                                                                  */
/*                                                                             */
/* MOVED/ASK handling is left to ioredis: every command below is issued        */
/* through the client's own command routing, so slot migrations and            */
/* resharding are retried transparently by ioredis.                            */
/* -------------------------------------------------------------------------- */

/** A single queued pipeline command. */
export interface PipelineCommand {
  /** ioredis command name, e.g. `'get'`, `'del'`. */
  command: string;
  /** Arguments for the command (key first for routed commands). */
  args: unknown[];
  /** Slot for the key this command targets (computed by the caller). */
  slot: number;
}

/** Result of one pipelined command: `[error, value]` like ioredis. */
export type PipelineCommandResult = [Error | null, unknown];

/** Options for {@link executeBySlot}. */
export interface ExecuteBySlotOptions {
  /**
   * Maximum number of slot pipelines to run concurrently.
   * Default: 8.
   */
  concurrency?: number;

  /**
   * When a whole slot pipeline fails at the network level (rejected promise,
   * e.g. connection loss), how many times it may be retried before the error
   * is reported per command. Command-level errors are never retried.
   * Default: 1. Pass `false` to disable retries.
   *
   * Only safe for idempotent command batches; the caller decides.
   */
  retry?: number | false;
}

/**
 * Executes a batch of commands grouped by Redis hash slot.
 *
 * For every distinct slot the commands are collected into one pipeline and
 * executed on the node owning that slot. Pipelines run with bounded
 * concurrency (default 8 slots at a time) so a fan-out over many slots cannot
 * exhaust sockets or event-loop resources.
 *
 * Result ordering is preserved: the returned array mirrors the input array.
 * Command-level failures do NOT reject the whole call; each entry is reported
 * as `[error, null]` so callers can implement partial-failure handling.
 * Network-level pipeline failures are retried once per slot pipeline before
 * being reported per command.
 *
 * @param client - The Redis client wrapper.
 * @param commands - Commands to run, each with a resolved slot.
 * @param options - Concurrency and retry tuning.
 * @returns One result per input command, in input order.
 */
export async function executeBySlot(
  client: RedisClientWrapper,
  commands: PipelineCommand[],
  options: ExecuteBySlotOptions = {},
): Promise<PipelineCommandResult[]> {
  if (commands.length === 0) return [];

  const concurrency = Math.max(1, options.concurrency ?? 8);
  const results: PipelineCommandResult[] = new Array<PipelineCommandResult>(commands.length);
  const missing: boolean[] = new Array(commands.length).fill(false);

  // Group by slot, remembering the original indexes so ordering is preserved.
  const groups = new Map<number, Array<{ index: number; command: PipelineCommand }>>();

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]!;
    const group = groups.get(command.slot);
    if (group) {
      group.push({ index: i, command });
    } else {
      groups.set(command.slot, [{ index: i, command }]);
    }
  }

  const entries = Array.from(groups.entries());

  // Bounded concurrency: run at most `concurrency` slot pipelines at once.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (cursor < entries.length) {
      const [slot, group] = entries[cursor++]!;
      await runSlotPipeline(client, slot, group, results, missing, options);
    }
  });

  await Promise.all(workers);

  for (let i = 0; i < missing.length; i++) {
    if (missing[i]) {
      results[i] = [new Error('Command did not produce a pipeline result'), null];
    }
  }

  return results;
}

async function runSlotPipeline(
  client: RedisClientWrapper,
  slot: number,
  group: Array<{ index: number; command: PipelineCommand }>,
  results: PipelineCommandResult[],
  missing: boolean[],
  options: ExecuteBySlotOptions,
): Promise<void> {
  const retries = options.retry === false ? 0 : Math.max(0, options.retry ?? 1);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const pipeline = client.pipeline();

      for (const { command } of group) {
        // `args` are formatted for the ioredis pipeline method signature.
        const fn = (pipeline as unknown as Record<string, (...a: unknown[]) => unknown>)[
          command.command
        ];
        fn!.call(pipeline, ...command.args);
      }

      const raw = await pipeline.exec();
      const resultsArray: PipelineCommandResult[] = Array.isArray(raw) ? (raw as PipelineCommandResult[]) : [];

      for (let i = 0; i < group.length; i++) {
        const item = group[i]!;
        const result = resultsArray[i];
        if (Array.isArray(result) && result.length === 2) {
          results[item.index] = result;
        } else {
          missing[item.index] = true;
        }
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Network-level failure: retry the whole slot pipeline.
    }
  }

  // All retries exhausted: report the network error on every command.
  for (const item of group) {
    results[item.index] = [lastError, null];
  }
}

/**
 * Inspects ioredis pipeline results and throws a structured error if any
 * command failed. Returns the values (without errors) on success.
 *
 * Pipeline `exec()` resolves with `[error, value][]` per command; a resolved
 * promise does NOT mean every command succeeded. Use this helper to enforce
 * command-level error handling.
 *
 * @param results - The `exec()` result array.
 * @param describe - Optional per-index description used in the error message
 *   (must not contain sensitive data).
 * @throws {Error} Listing the failed command indexes.
 */
export function assertPipelineOk(
  results: PipelineCommandResult[] | null,
  describe?: (index: number) => string,
): unknown[] {
  if (!results) {
    throw new Error('Pipeline returned no results (connection likely lost).');
  }

  const failures: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const error = Array.isArray(result) ? result[0] : undefined;
    if (error) {
      const label = describe ? `"${describe(i)}"` : `index ${i}`;
      failures.push(`${label}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Pipeline failed for ${failures.length} command(s): ${failures.join('; ')}`);
  }

  return results.map((r) => (Array.isArray(r) ? r[1] : undefined));
}

/**
 * Runs an async map over a list with bounded concurrency.
 *
 * Do NOT use `Promise.all(list.map(fn))` for cross-slot fan-out; use this to
 * keep the number of in-flight Redis operations bounded.
 *
 * @param items - Input list.
 * @param limit - Maximum concurrent workers.
 * @param fn - Async mapper.
 * @returns Results in input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, limit);
  const results: R[] = new Array<R>(items.length);

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Chunks an array into bounded batches. Yields nothing for an empty array.
 */
export function chunk<T>(items: readonly T[], size: number): Generator<T[]> {
  return (function* () {
    for (let i = 0; i < items.length; i += size) {
      yield items.slice(i, i + size);
    }
  })();
}
