import { RedisClientWrapper } from '../../src/client.js';
import { defaultLogger, LoggerLike } from '../../src/logger.js';

interface StoreEntry {
  type: 'string' | 'zset' | 'hash';
  value: string | Buffer;
  zset: Map<string, number>;
  hash: Map<string, string>;
  expireAt: number | null;
}

const now = () => Date.now();

const CRC16_TABLE = (() => {
  const table = new Array<number>(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    table[i] = crc;
  }
  return table;
})();

export const silentLogger: LoggerLike = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

export class FakeRedis {
  private store = new Map<string, StoreEntry>();
  private failingMethods = new Set<string>();
  public callLog: string[] = [];

  fail(...methods: string[]): void {
    methods.forEach((m) => this.failingMethods.add(m));
  }

  private checkFail(method: string): void {
    if (this.failingMethods.has(method)) {
      throw new Error(`Simulated Redis failure: ${method}`);
    }
  }

  private getEntry(key: string): StoreEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expireAt !== null && now() >= entry.expireAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private assertString(entry: StoreEntry | undefined): StoreEntry | undefined {
    if (entry && entry.type !== 'string') return undefined;
    return entry;
  }

  async get(key: string): Promise<string | null> {
    this.checkFail('get');
    this.callLog.push(`get ${key}`);
    const entry = this.assertString(this.getEntry(key));
    return entry ? String(entry.value) : null;
  }

  async set(key: string, value: string | Buffer, ttl?: number): Promise<'OK' | null> {
    this.checkFail('set');
    this.callLog.push(`set ${key}`);
    this.store.set(key, {
      type: 'string',
      value,
      zset: new Map(),
      hash: new Map(),
      expireAt: ttl ? now() + ttl * 1000 : null,
    });
    return 'OK';
  }

  async setexnx(key: string, value: string | Buffer, ttl?: number): Promise<'OK' | null> {
    this.checkFail('setexnx');
    this.callLog.push(`setexnx ${key}`);
    if (this.getEntry(key)) return null;
    await this.set(key, value, ttl);
    return 'OK';
  }

  async setnx(key: string, value: string | Buffer, ttl?: number): Promise<number> {
    this.checkFail('setnx');
    this.callLog.push(`setnx ${key}`);
    if (this.getEntry(key)) return 0;
    await this.set(key, value, ttl);
    return 1;
  }

  async del(...keys: string[]): Promise<number> {
    this.checkFail('del');
    this.callLog.push(`del ${keys.join(',')}`);
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) deleted++;
    }
    return deleted;
  }

  async exists(key: string): Promise<number> {
    this.checkFail('exists');
    this.callLog.push(`exists ${key}`);
    return this.getEntry(key) ? 1 : 0;
  }

  async expire(key: string, ttl: number): Promise<number> {
    this.checkFail('expire');
    this.callLog.push(`expire ${key}`);
    const entry = this.getEntry(key);
    if (!entry) return 0;
    entry.expireAt = now() + ttl * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    this.checkFail('ttl');
    this.callLog.push(`ttl ${key}`);
    const entry = this.getEntry(key);
    if (!entry) return -2;
    if (entry.expireAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expireAt - now()) / 1000));
  }

  async incr(key: string): Promise<number> {
    this.checkFail('incr');
    this.callLog.push(`incr ${key}`);
    const entry = this.assertString(this.getEntry(key));
    const current = entry ? Number(entry.value) || 0 : 0;
    const next = current + 1;
    this.store.set(key, {
      type: 'string',
      value: String(next),
      zset: new Map(),
      hash: new Map(),
      expireAt: entry ? entry.expireAt : null,
    });
    return next;
  }

  async decr(key: string): Promise<number> {
    this.checkFail('decr');
    this.callLog.push(`decr ${key}`);
    const entry = this.assertString(this.getEntry(key));
    const current = entry ? Number(entry.value) || 0 : 0;
    const next = current - 1;
    this.store.set(key, {
      type: 'string',
      value: String(next),
      zset: new Map(),
      hash: new Map(),
      expireAt: entry ? entry.expireAt : null,
    });
    return next;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.checkFail('mget');
    this.callLog.push(`mget ${keys.join(',')}`);
    return Promise.all(keys.map((key) => this.get(key)));
  }

  async mgetClusterAware(keys: string[]): Promise<(string | null)[]> {
    this.checkFail('mget');
    this.callLog.push(`mgetClusterAware ${keys.join(',')}`);
    return this.mget(...keys);
  }

  calculateSlot(key: string): number {
    const start = key.indexOf('{');
    if (start !== -1) {
      const end = key.indexOf('}', start + 1);
      if (end !== -1 && start + 1 < end) {
        key = key.substring(start + 1, end);
      }
    }
    let crc = 0;
    for (let i = 0; i < key.length; i++) {
      crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ key.charCodeAt(i)) & 0xff]!;
    }
    return crc % 16384;
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.checkFail('hget');
    this.callLog.push(`hget ${key}`);
    const entry = this.getEntry(key);
    if (!entry || entry.type !== 'hash') return null;
    return entry.hash.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string | Buffer): Promise<number> {
    this.checkFail('hset');
    this.callLog.push(`hset ${key}`);
    const entry = this.getEntry(key);
    if (!entry || entry.type !== 'hash') {
      const fresh: StoreEntry = {
        type: 'hash',
        value: '',
        zset: new Map(),
        hash: new Map([[field, String(value)]]),
        expireAt: null,
      };
      this.store.set(key, fresh);
      return 1;
    }
    const existed = entry.hash.has(field);
    entry.hash.set(field, String(value));
    return existed ? 0 : 1;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.checkFail('hgetall');
    this.callLog.push(`hgetall ${key}`);
    const entry = this.getEntry(key);
    if (!entry || entry.type !== 'hash') return {};
    return Object.fromEntries(entry.hash);
  }

  pipeline() {
    const ops: Array<{ key: string; value: string | Buffer; ttl?: number }> = [];
    const api = {
      set: (key: string, value: string | Buffer, _ex?: string, ttl?: number) => {
        ops.push({ key, value, ...(ttl !== undefined ? { ttl } : {}) });
        return api;
      },
      exec: async (): Promise<Array<[Error | null, unknown]>> => {
        for (const op of ops) {
          await this.set(op.key, op.value, op.ttl);
        }
        return ops.map(() => [null, 'OK']);
      },
    };
    return api;
  }

  async *scanIterator(pattern: string): AsyncIterable<string> {
    const regex = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
    );
    for (const key of this.store.keys()) {
      if (regex.test(key)) yield key;
    }
  }

  async eval(script: string, numKeys: number, key: string, ...args: unknown[]): Promise<unknown> {
    this.checkFail('eval');
    this.callLog.push(`eval ${key}`);
    const [rawNow, rawWindow, rawLimit, member] = args;
    const t = Number(rawNow);
    const window = Number(rawWindow);
    const limit = Number(rawLimit);

    let entry = this.getEntry(key);
    if (!entry || entry.type !== 'zset') {
      entry = { type: 'zset', value: '', zset: new Map(), hash: new Map(), expireAt: null };
      this.store.set(key, entry);
    }

    for (const [m, score] of Array.from(entry.zset)) {
      if (score <= t - window) entry.zset.delete(m);
    }

    const count = entry.zset.size;

    const retryAfterFor = (): number => {
      if (count === 0) return 0;
      const oldest = Math.min(...entry.zset.values());
      return Math.max(1, Math.ceil((oldest + window - t) / 1000));
    };

    const consume = script.includes('ZADD');
    if (consume) {
      if (count >= limit) {
        return [0, count, -1, retryAfterFor()];
      }
      entry.zset.set(String(member), t);
      entry.expireAt = t + window;
      return [1, count + 1, limit - count - 1, 0];
    }
    return [count, retryAfterFor()];
  }

  raw = this;
  getRawClient(): this {
    return this;
  }
}

export function fakeClient(): FakeRedis {
  return new FakeRedis();
}

export function asWrapper(fake: FakeRedis): RedisClientWrapper {
  return fake as unknown as RedisClientWrapper;
}

export const testLogger = defaultLogger;