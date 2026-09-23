# @suss/framework-redis

This pack records which Redis keys a TypeScript service reads and writes.

## What this package is

A pattern pack. It matches Redis commands and records the same `storage-access` effects the other storage packs do, so a writer and a reader of the same key become two ends of one boundary.

```ts
import { redisFramework } from "@suss/framework-redis";

const pack = redisFramework();
```

It covers `ioredis`, `node-redis` and `iovalkey`. All three use one protocol, so the pack records the system as `redis` whichever server is on the other end. node-redis writes `hGet` where ioredis writes `hget`, and the lookup ignores case, so both are the same command.

## How it settles a call

A service rarely builds its client where it uses it:

```ts
const redis = await this.getRedisClient();
const cached = await redis.get(cacheKey);
```

Nothing at that call site shows the value came from ioredis. The method's declaration does: the client library declares `get`, so the pack asks the type checker where the declaration lives. A `get` on a plain object, or on a cache wrapper the project wrote, resolves somewhere else and is ignored.

## The namespace a key belongs to

Redis has no tables. Instead, a key has its own structure:

```ts
await redis.setex(`session:${id}`, 900, token);   // container "session"
const cached = await redis.get(LAST_REFRESH_KEY); // "similarity:last_refresh" → container "similarity"
```

The fixed part up to the first `:` becomes the container. The whole key becomes the selector, with any part built at run time written as a hole. The container is how a writer pairs with a reader: two units that touch `session` are using the same data, and the selector shows whether they agree on the key pattern within it.

A key built at run time (`redis.get(key)` on a parameter) cannot be settled, so the container comes out null and the effect records the access without a key. The same happens when the key starts with a hole (`` `${prefix}:${id}` ``), since a namespace built at run time gives no way to tell which keys go together. A command that reaches two namespaces at once, as `mget` can, records both keys and no container.

## What each command contributes

| Input | What it becomes |
| --- | --- |
| the key argument | the selector, and its namespace becomes the container |
| the field argument of a hash command | the fields the call touches |

Commands that read: `get`, `mget`, `exists`, `ttl`, `strlen`, `hget`, `hmget`, `hgetall`, `hexists`, `smembers`, `sismember`, `scard`, `zscore`, `zrange`, `zrevrange`, `zrangebyscore`, `zcard`, `lrange`, `llen`.

Commands that write: `set`, `setex`, `setnx`, `psetex`, `getdel`, `append`, `incr`, `incrby`, `decr`, `decrby`, `del`, `unlink`, `expire`, `expireat`, `persist`, `rename`, `hset`, `hmset`, `hsetnx`, `hincrby`, `hdel`, `sadd`, `srem`, `zadd`, `zrem`, `lpush`, `rpush`, `lpop`, `rpop`, `lrem`.

## Out of scope for now

- **A pipeline or a multi.** `redis.pipeline().get(a).set(b, c).exec()` chains the same commands off a builder, but the receiver is the pipeline instead of the client.
- **Lua scripts.** `eval` and `evalsha` take their keys as a count and a list, and what happens to them is inside the script.
- **`keys` and `scan`.** Both take a glob instead of a key, and a glob only shows which keys a call might reach.

## Where it fits in suss

The pack depends on `@suss/behavioral-ir` for the binding it builds, and on `@suss/adapter-typescript` for the declaration check and for looking up what a key was written as. Nothing declares a Redis key the way CloudFormation declares a table, so this pack pairs against other code. The storage pass in `@suss/checker` puts a writer and a reader of one namespace on the two sides of a boundary.
