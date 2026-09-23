/**
 * Recognizes Redis commands and records each one as a storage access.
 *
 * A service rarely builds its client where it uses it, so a call counts
 * when the client library declares the method, whatever the receiver is
 * called. The container is the key's namespace, the fixed part before
 * the first `:`, so a writer and a reader of `session:{id}` pair on
 * `session`. The README covers the commands and what is left out.
 */

import { declaredBy, pack, storageCalls } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type { PatternPack, StorageMethod } from "@suss/recognize";

// All three use the Redis protocol, so a call through any of them is
// recorded as `redis` whatever server is on the other end.
const CLIENT_MODULES = ["ioredis", "redis", "iovalkey"];

const READ_KEY: StorageMethod = { kind: "read", selector: { at: 0 } };
const WRITE_KEY: StorageMethod = { kind: "write", selector: { at: 0 } };

const READ_KEYS: StorageMethod = { kind: "read", selector: { from: 0 } };
const WRITE_KEYS: StorageMethod = { kind: "write", selector: { from: 0 } };

const READ_FIELD: StorageMethod = {
  kind: "read",
  selector: { at: 0 },
  fields: { at: 1 },
};
const WRITE_FIELD: StorageMethod = {
  kind: "write",
  selector: { at: 0 },
  fields: { at: 1 },
};

// Keyed by lower-case name. node-redis writes `hGet` where ioredis writes
// `hget`, so the lookup ignores case.
const COMMANDS: Record<string, StorageMethod> = {
  get: READ_KEY,
  getdel: WRITE_KEY,
  mget: READ_KEYS,
  exists: READ_KEY,
  ttl: READ_KEY,
  strlen: READ_KEY,
  set: WRITE_KEY,
  setex: WRITE_KEY,
  setnx: WRITE_KEY,
  psetex: WRITE_KEY,
  append: WRITE_KEY,
  incr: WRITE_KEY,
  incrby: WRITE_KEY,
  decr: WRITE_KEY,
  decrby: WRITE_KEY,
  del: WRITE_KEYS,
  unlink: WRITE_KEYS,
  expire: WRITE_KEY,
  expireat: WRITE_KEY,
  persist: WRITE_KEY,
  rename: WRITE_KEY,
  hget: READ_FIELD,
  hmget: READ_FIELD,
  hgetall: READ_KEY,
  hexists: READ_FIELD,
  hset: WRITE_FIELD,
  hmset: WRITE_FIELD,
  hsetnx: WRITE_FIELD,
  hincrby: WRITE_FIELD,
  hdel: WRITE_FIELD,
  sadd: WRITE_KEY,
  srem: WRITE_KEY,
  smembers: READ_KEY,
  sismember: READ_KEY,
  scard: READ_KEY,
  zadd: WRITE_KEY,
  zrem: WRITE_KEY,
  zscore: READ_KEY,
  zrange: READ_KEY,
  zrevrange: READ_KEY,
  zrangebyscore: READ_KEY,
  zcard: READ_KEY,
  lpush: WRITE_KEY,
  rpush: WRITE_KEY,
  lpop: WRITE_KEY,
  rpop: WRITE_KEY,
  lrange: READ_KEY,
  llen: READ_KEY,
  lrem: WRITE_KEY,
};

const NAMESPACE_SEPARATOR = ":";

/**
 * Returns null when a call's keys fall in more than one namespace.
 * Taking the first key's namespace would pair the call with only part of
 * what it touches.
 */
function namespaceOf(keys: readonly string[]): string | null {
  const namespaces = new Set(
    keys.map((key) => key.split(NAMESPACE_SEPARATOR)[0] ?? key),
  );
  if (namespaces.size !== 1) {
    return null;
  }
  const [only] = [...namespaces];
  // A namespace built at run time gives no way to tell which keys go
  // together.
  return only === undefined || only.includes("{") ? null : only;
}

const COMMAND_CALLS = storageCalls({
  system: "redis",
  client: declaredBy(...CLIENT_MODULES),
})
  .methods(COMMANDS, { ignoringCase: true })
  .container(namespaceOf)
  .example('redis.get("user_online:42")');

/**
 * A command counts only when a Redis client library declares its method,
 * so a `get` on a cache wrapper the project wrote is ignored.
 */
export function redisFramework(): PatternPack {
  return pack("redis", [COMMAND_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-redis",
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-redis",
  dependencies: [
    { ecosystem: "npm", name: "ioredis" },
    { ecosystem: "npm", name: "iovalkey" },
    { ecosystem: "npm", name: "redis" },
  ],
  reads:
    "Redis, Valkey and node-redis commands. Each one becomes a storage-access interaction.",
};

export default redisFramework;
