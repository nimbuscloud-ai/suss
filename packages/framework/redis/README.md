# @suss/framework-redis

Says which Redis keys a TypeScript service reads and writes.

## What this package is

A pattern pack. It recognizes Redis commands and emits the same `storage-access` effects the other storage packs emit, so a writer and a reader of the same key become two ends of one boundary.

```ts
import { redisFramework } from "@suss/framework-redis";

const pack = redisFramework();
```

It covers `ioredis`, `node-redis` and `iovalkey`. All three speak one protocol, so what a call reaches is recorded as `redis` whichever server is on the other end. node-redis spells `hGet` where ioredis spells `hget`, and the lookup ignores case, so both are the same command.

## How it settles a call

A service rarely constructs its client where it uses it:

```ts
const redis = await this.getRedisClient();
const cached = await redis.get(cacheKey);
```

Nothing at that call site says the value came from ioredis. What the method resolves to does: `get` is declared by the client library, so the pack asks the type checker where the declaration lives. A `get` on a plain object, or on a cache wrapper somebody wrote, resolves somewhere else and is left alone.

## The namespace a key belongs to

Redis has no tables, and a key has its own structure instead:

```ts
await redis.setex(`session:${id}`, 900, token);   // container "session"
const cached = await redis.get(LAST_REFRESH_KEY); // "similarity:last_refresh" → container "similarity"
```

The fixed part up to the first `:` becomes the container, and the whole key becomes the selector, with a part built at run time written as a hole. That is what pairs a writer against a reader: two units that touch `session` are talking about the same thing, and the selector says whether they agree on the key shape underneath it.

A key built at run time (`redis.get(key)` on a parameter) settles nothing, so the container comes out null and the effect records the access without a key. A key whose front is a hole (`` `${prefix}:${id}` ``) settles nothing either, since a namespace built at run time says nothing about which keys go together. A command that reaches two namespaces at once, which `mget` can, records both keys and no container.

## What each command contributes

| Input | What it becomes |
| --- | --- |
| the key argument | the selector, and its namespace becomes the container |
| the field argument of a hash command | the fields the call touches |

Commands that read: `get`, `mget`, `exists`, `ttl`, `strlen`, `hget`, `hmget`, `hgetall`, `hexists`, `smembers`, `sismember`, `scard`, `zscore`, `zrange`, `zrevrange`, `zrangebyscore`, `zcard`, `lrange`, `llen`.

Commands that write: `set`, `setex`, `setnx`, `psetex`, `getdel`, `append`, `incr`, `incrby`, `decr`, `decrby`, `del`, `unlink`, `expire`, `expireat`, `persist`, `rename`, `hset`, `hmset`, `hsetnx`, `hincrby`, `hdel`, `sadd`, `srem`, `zadd`, `zrem`, `lpush`, `rpush`, `lpop`, `rpop`, `lrem`.

## Out of scope for now

- **A pipeline or a multi.** `redis.pipeline().get(a).set(b, c).exec()` chains commands off a builder, and the commands are the same ones, but the receiver is the pipeline rather than the client.
- **Lua scripts.** `eval` and `evalsha` take their keys as a count and a list, and what the script does with them is inside the script.
- **`keys` and `scan`.** Both take a glob rather than a key, and a glob says which keys a call might reach rather than which one it did.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the binding it builds and `@suss/adapter-typescript` for the declaration check and for asking what a key was written as. Nothing declares a Redis key the way CloudFormation declares a table, so what this pairs against is other code: the storage pass in `@suss/checker` puts a writer and a reader of one namespace on the two sides of a boundary.
