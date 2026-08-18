import { readFileSync } from 'node:fs';

import type { RedisClientWrapper } from '../client.js';
import { SessionConfigurationError } from './session-errors.js';

/* -------------------------------------------------------------------------- */
/* Lua script registry.                                                        */
/*                                                                             */
/* Scripts live as versioned .lua files (src/session/scripts/) and are         */
/* loaded at construction. The registry handles SCRIPT LOAD + EVALSHA with    */
/* NOSCRIPT fallback, so scripts survive server script-cache eviction and     */
/* cluster node restarts.                                                      */
/*                                                                             */
/* Script contract (enforced by review, not by machinery):                     */
/*   - every key is declared in KEYS and shares the user's hash slot          */
/*   - no cross-slot keys, no KEYS/SCAN, no dynamic Lua construction          */
/*   - stable integer result codes (documented in each script header)         */
/*   - bounded loops (batch sizes passed in ARGV)                             */
/* -------------------------------------------------------------------------- */

export const SCRIPT_NAMES = [
  'create',
  'touch',
  'touchEncrypted',
  'rotate',
  'rotateEncrypted',
  'delete',
  'revoke',
  'conditionalUpdate',
  'conditionalUpdateEncrypted',
  'deleteByUser',
  'cleanupIndex',
  'enforceLimit',
  'validate',
] as const;

export type ScriptName = (typeof SCRIPT_NAMES)[number];

const SCRIPT_FILE: Record<ScriptName, string> = {
  create: 'create.lua',
  touch: 'touch.lua',
  touchEncrypted: 'touch-encrypted.lua',
  rotate: 'rotate.lua',
  rotateEncrypted: 'rotate-encrypted.lua',
  delete: 'delete.lua',
  revoke: 'revoke.lua',
  conditionalUpdate: 'conditional-update.lua',
  conditionalUpdateEncrypted: 'conditional-update-encrypted.lua',
  deleteByUser: 'delete-by-user.lua',
  cleanupIndex: 'cleanup-index.lua',
  enforceLimit: 'enforce-limit.lua',
  validate: 'validate.lua',
};

/** Loads a script source from disk relative to this module. */
export function loadScriptSource(name: ScriptName): string {
  const url = new URL(`./scripts/${SCRIPT_FILE[name]}`, import.meta.url);
  try {
    return readFileSync(url, 'utf8');
  } catch (error) {
    throw new SessionConfigurationError(
      `Failed to load Lua script "${SCRIPT_FILE[name]}" (${url.pathname}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface SessionScriptRegistryOptions {
  /** Override script sources (used by tests to inject fixtures). */
  sources?: Partial<Record<ScriptName, string>>;
}

/**
 * Loads and executes the session Lua scripts through a single client.
 * Stateless besides the script sources and SHA digests.
 */
export class SessionScriptRegistry {
  private readonly sources: Record<ScriptName, string>;
  private readonly client: RedisClientWrapper;
  private shas: Partial<Record<ScriptName, string>> = {};
  private loaded = false;

  constructor(client: RedisClientWrapper, options: SessionScriptRegistryOptions = {}) {
    this.client = client;

    const sources = {} as Record<ScriptName, string>;
    for (const name of SCRIPT_NAMES) {
      sources[name] = options.sources?.[name] ?? loadScriptSource(name);
    }
    this.sources = sources;
  }

  /** Returns the raw source of a script (for tests and audits). */
  source(name: ScriptName): string {
    return this.sources[name];
  }

  /**
   * Pre-loads every script with SCRIPT LOAD. Best-effort: when loading
   * fails (e.g. Redis briefly unavailable at startup), the EVALSHA +
   * NOSCRIPT fallback keeps working, so authentication is never blocked
   * by a failed preload.
   */
  async preload(): Promise<void> {
    if (this.loaded) return;

    const results = await Promise.allSettled(
      SCRIPT_NAMES.map((name) =>
        this.client
          .scriptLoad(this.sources[name])
          .then((sha) => {
            this.shas[name] = sha;
          }),
      ),
    );

    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      // Scripts will still work via the EVAL fallback path.
      this.loaded = false;
      return;
    }
    this.loaded = true;
  }

  /**
   * Executes a script by name with EVALSHA, falling back to EVAL on
   * NOSCRIPT (script cache evicted / node restarted).
   */
  async eval(
    name: ScriptName,
    numKeys: number,
    ...args: Array<string | number | Buffer>
  ): Promise<unknown> {
    const sha = this.shas[name];
    const source = this.sources[name];

    if (sha) {
      try {
        return await this.client.evalsha(sha, source, numKeys, ...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('NOSCRIPT')) throw error;
        // Fall through to EVAL and refresh the cached SHA.
      }
    }

    const result = await this.client.eval(source, numKeys, ...args);
    if (sha) {
      // EVAL succeeds only when the server has the script; update the SHA.
      this.shas[name] = sha;
    }
    return result;
  }

  /** Marks the registry dirty (e.g. after tests replaced the client). */
  invalidate(): void {
    this.loaded = false;
    this.shas = {};
  }
}