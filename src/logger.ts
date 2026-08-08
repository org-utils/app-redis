export type LogMeta = Record<string, unknown>;

export interface LoggerLike {
  trace(message: string, meta?: LogMeta): void;
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  fatal(message: string, meta?: LogMeta): void;

  child(bindings: LogMeta): LoggerLike;
}

function mergeMeta(
  bindings: LogMeta,
  meta?: LogMeta,
): LogMeta {
  return {
    ...bindings,
    ...(meta ?? {}),
  };
}

class ConsoleLogger implements LoggerLike {
  constructor(
    private readonly bindings: LogMeta = {},
  ) {}

  trace(message: string, meta?: LogMeta): void {
    console.trace(
      message,
      mergeMeta(this.bindings, meta),
    );
  }

  debug(message: string, meta?: LogMeta): void {
    console.debug(
      message,
      mergeMeta(this.bindings, meta),
    );
  }

  info(message: string, meta?: LogMeta): void {
    console.info(
      message,
      mergeMeta(this.bindings, meta),
    );
  }

  warn(message: string, meta?: LogMeta): void {
    console.warn(
      message,
      mergeMeta(this.bindings, meta),
    );
  }

  error(message: string, meta?: LogMeta): void {
    console.error(
      message,
      mergeMeta(this.bindings, meta),
    );
  }

  fatal(message: string, meta?: LogMeta): void {
    console.error(
      message,
      mergeMeta(this.bindings, meta),
    );
  }

  child(bindings: LogMeta): LoggerLike {
    return new ConsoleLogger({
      ...this.bindings,
      ...bindings,
    });
  }
}

export const defaultLogger: LoggerLike =
  new ConsoleLogger();

export function createConsoleLogger(
  bindings?: LogMeta,
): LoggerLike {
  return new ConsoleLogger(bindings);
}
