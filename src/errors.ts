export class RedisError extends Error {
  public code: string;
  public details?: Record<string, any>;

  constructor(message: string, code: string = 'UNKNOWN_ERROR', details?: Record<string, any>) {
    super(message);
    this.name = 'RedisError';
    this.code = code;
    this.details = details as Record<string, any>;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RedisError);
    }
  }
}

export class ConnectionError extends RedisError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'CONNECTION_ERROR', details);
    this.name = 'ConnectionError';
  }
}

export class TimeoutError extends RedisError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'TIMEOUT_ERROR', details);
    this.name = 'TimeoutError';
  }
}

export class LockError extends RedisError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'LOCK_ERROR', details);
    this.name = 'LockError';
  }
}

export class SerializationError extends RedisError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'SERIALIZATION_ERROR', details);
    this.name = 'SerializationError';
  }
}

export class CompressionError extends RedisError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'COMPRESSION_ERROR', details);
    this.name = 'CompressionError';
  }
}

export class ConfigurationError extends RedisError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'CONFIGURATION_ERROR', details);
    this.name = 'ConfigurationError';
  }
}

export class ClusterError extends RedisError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'CLUSTER_ERROR', details);
    this.name = 'ClusterError';
  }
}
