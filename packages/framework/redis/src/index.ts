/**
 * Recognize Redis commands and emit `storage-access` effects.
 *
 * A Redis client is usually reached through something the source does
 * not spell out, so the anchor is the command's own type: `get`, `setex`
 * and the rest are declared by the client library, and a method declared
 * there is a command whatever the receiver was called.
 *
 * Keys carry their own structure. `user_online:{communityId}` puts every
 * online-user entry under one name, so the fixed part up to the first
 * separator becomes the container and the whole key becomes the
 * selector. That is what makes a writer and a reader of the same
 * namespace two ends of one boundary.
 */

import { declaredBy, pack, storageCalls } from "@suss/recognize";

import type { PatternPack, StorageMethod } from "@suss/recognize";

/**
 * The client libraries whose method declarations settle a call. All
 * three speak one protocol, so what they reach is recorded as redis
 * whichever server is answering.
 */
const CLIENT_MODULES = ["ioredis", "redis", "iovalkey"];

/** A command that takes one key, its first argument. */
const READ_KEY: StorageMethod = { kind: "read", selector: { at: 0 } };
const WRITE_KEY: StorageMethod = { kind: "write", selector: { at: 0 } };

/** A command that takes a list of keys. */
const READ_KEYS: StorageMethod = { kind: "read", selector: { from: 0 } };
const WRITE_KEYS: StorageMethod = { kind: "write", selector: { from: 0 } };

/** A hash command: one key, and the field inside it as the second argument. */
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

/**
 * The commands this reads, by the lower-cased method name. node-redis
 * spells `hGet` where ioredis spells `hget`, and they are the same
 * command, so the lookup ignores case.
 */
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

/** What separates a Redis key's namespace from the rest of it. */
const NAMESPACE_SEPARATOR = ":";

/**
 * The namespace a set of keys share. Keys of one call are the same
 * shape nearly every time, and one that is not leaves the container
 * unsettled rather than picking whichever came first.
 */
function namespaceOf(keys: readonly string[]): string | null {
  const namespaces = new Set(
    keys.map((key) => key.split(NAMESPACE_SEPARATOR)[0] ?? key),
  );
  if (namespaces.size !== 1) {
    return null;
  }
  const [only] = [...namespaces];
  // A namespace built at run time says nothing about which keys go
  // together, so it settles nothing.
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
 * Pack export. One declaration, gated on a file reaching a client
 * library, since that is where a command can come from.
 */
export function redisFramework(): PatternPack {
  return pack("redis", [COMMAND_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-redis",
  });
}

export default redisFramework;
