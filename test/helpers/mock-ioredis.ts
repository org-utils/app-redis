export class MockRedisClient {
  static Cluster = class MockCluster extends MockRedisClient {};

  __store = new Map<string, { value: string | Buffer; expireAt: number | null }>();
  __calls: string[] = [];

  constructor(..._args: unknown[]) {}

  nodes() {
    return [];
  }

  getSlot() {
    return undefined;
  }

  on(_event: string, _cb: (...args: unknown[]) => void) {
    return this;
  }

  async ping() {
    return 'PONG';
  }

  async quit() {
    return 'OK';
  }

  async get(key: string) {
    this.__calls.push(`get ${key}`);
    const entry = this.__store.get(key);
    if (!entry) return null;
    if (entry.expireAt !== null && Date.now() >= entry.expireAt) {
      this.__store.delete(key);
      return null;
    }
    return String(entry.value);
  }

  async set(key: string, value: string | Buffer, ...args: unknown[]) {
    this.__calls.push(`set ${key}`);
    let ttl: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'EX') {
        ttl = args[i + 1] as number;
      }
      if (args[i] === 'NX') {
        nx = true;
      }
    }
    if (nx && this.__store.has(key)) return null;
    this.__store.set(key, {
      value,
      expireAt: ttl !== null ? Date.now() + ttl * 1000 : null,
    });
    return 'OK';
  }

  async setnx(key: string, value: string | Buffer) {
    this.__calls.push(`setnx ${key}`);
    if (this.__store.has(key)) return 0;
    this.__store.set(key, { value, expireAt: null });
    return 1;
  }

  async expire(key: string, ttl: number) {
    this.__calls.push(`expire ${key} ${ttl}`);
    const entry = this.__store.get(key);
    if (!entry) return 0;
    entry.expireAt = Date.now() + ttl * 1000;
    return 1;
  }

  async ttl(key: string) {
    const entry = this.__store.get(key);
    if (!entry) return -2;
    if (entry.expireAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expireAt - Date.now()) / 1000));
  }

  async del(...keys: string[]) {
    this.__calls.push(`del ${keys.join(',')}`);
    let deleted = 0;
    for (const key of keys) {
      if (this.__store.delete(key)) deleted++;
    }
    return deleted;
  }

  async exists(key: string) {
    return this.__store.has(key) ? 1 : 0;
  }

  async incr(key: string) {
    this.__calls.push(`incr ${key}`);
    const current = this.__store.has(key) ? Number(this.__store.get(key)!.value) || 0 : 0;
    const next = current + 1;
    const entry = this.__store.get(key);
    this.__store.set(key, { value: String(next), expireAt: entry?.expireAt ?? null });
    return next;
  }

  async decr(key: string) {
    const current = this.__store.has(key) ? Number(this.__store.get(key)!.value) || 0 : 0;
    const next = current - 1;
    const entry = this.__store.get(key);
    this.__store.set(key, { value: String(next), expireAt: entry?.expireAt ?? null });
    return next;
  }

  async mget(...keys: string[]) {
    return Promise.all(keys.map((key) => this.get(key)));
  }

  async mset(flat: Array<string | Buffer>) {
    for (let i = 0; i < flat.length; i += 2) {
      this.__store.set(String(flat[i]), { value: flat[i + 1]!, expireAt: null });
    }
    return 'OK';
  }

  async hget(key: string, field: string) {
    const entry = this.__store.get(key);
    if (!entry) return null;
    const hash = JSON.parse(String(entry.value)) as Record<string, string>;
    return hash[field] ?? null;
  }

  async hset(key: string, field: string, value: string | Buffer) {
    const entry = this.__store.get(key);
    const hash = entry ? (JSON.parse(String(entry.value)) as Record<string, string>) : {};
    const existed = Object.prototype.hasOwnProperty.call(hash, field);
    hash[field] = String(value);
    this.__store.set(key, { value: JSON.stringify(hash), expireAt: entry?.expireAt ?? null });
    return existed ? 0 : 1;
  }

  async hgetall(key: string) {
    const entry = this.__store.get(key);
    return entry ? (JSON.parse(String(entry.value)) as Record<string, string>) : {};
  }

  async hdel(key: string, ...fields: string[]) {
    const entry = this.__store.get(key);
    if (!entry) return 0;
    const hash = JSON.parse(String(entry.value)) as Record<string, string>;
    let deleted = 0;
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(hash, field)) {
        delete hash[field];
        deleted++;
      }
    }
    this.__store.set(key, { value: JSON.stringify(hash), expireAt: entry.expireAt });
    return deleted;
  }

  async info() {
    return 'redis_version:7.0.0\r\n';
  }

  async select() {
    return 'OK';
  }

  async scan() {
    return ['0', []];
  }

  async defineCommand() {
    return this;
  }

  pipeline() {
    return {
      set: (key: string, value: string | Buffer) => {
        this.__store.set(key, { value, expireAt: null });
      },
      exec: async () => [],
    };
  }
}