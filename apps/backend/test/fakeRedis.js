// Minimal in-memory stand-in for an ioredis client, covering what RedisStore uses.
// The custom commands mirror the Lua scripts in rateLimit.js; test/rate-limit-redis.test.js
// runs the real scripts against a live Redis when REDIS_URL is set.
export const createFakeRedis = ({ now = Date.now } = {}) => {
  const zsets = new Map();
  const strings = new Map();

  const readString = (key) => {
    const entry = strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      strings.delete(key);
      return null;
    }
    return entry.value;
  };

  const commands = {
    orbitSlidingWindow: async (key, at, windowMs, limit, member) => {
      const entries = (zsets.get(key) ?? []).filter(([score]) => score > at - windowMs);
      let allowed = 0;
      if (entries.length < limit) {
        entries.push([at, member]);
        entries.sort((a, b) => a[0] - b[0]);
        allowed = 1;
      }
      zsets.set(key, entries);
      return [allowed, entries.length, entries.length ? String(entries[0][0]) : ''];
    },
    orbitIncrTtl: async (key, ttlMs) => {
      const next = Number(readString(key) ?? 0) + 1;
      strings.set(key, { value: String(next), expiresAt: now() + Number(ttlMs) });
      return next;
    },
  };

  const client = {
    calls: [],
    failing: false,
    defineCommand(name) {
      client[name] = async (...args) => {
        client.calls.push(name);
        if (client.failing) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
        return commands[name](...args);
      };
    },
    async mget(...keys) {
      if (client.failing) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      return keys.map(readString);
    },
    async set(key, value, ...args) {
      if (client.failing) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      const pxIndex = args.indexOf('PX');
      const ttl = pxIndex >= 0 ? Number(args[pxIndex + 1]) : null;
      if (args.includes('NX') && readString(key) !== null) return null;
      strings.set(key, { value: String(value), expiresAt: ttl === null ? null : now() + ttl });
      return 'OK';
    },
    async scan(cursor, match, pattern) {
      const prefix = pattern.replace(/\*$/, '');
      const keys = [...zsets.keys(), ...strings.keys()].filter((key) => key.startsWith(prefix));
      return ['0', keys];
    },
    async del(...keys) {
      for (const key of keys) {
        zsets.delete(key);
        strings.delete(key);
      }
      return keys.length;
    },
  };
  return client;
};
