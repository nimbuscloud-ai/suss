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

import { type CallExpression, Node as N, type Node } from "ts-morph";

import { methodDeclaredIn, readName } from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type { InvocationRecognizer, PatternPack } from "@suss/extractor";

const RECOGNITION = "@suss/framework-redis";

/**
 * The client libraries whose method declarations settle a call. All
 * three speak one protocol, so what they reach is recorded as redis
 * whichever server is answering.
 */
const CLIENT_MODULES = ["ioredis", "redis", "iovalkey"];

/** How a command addresses what it touches. */
interface Command {
  kind: "read" | "write";
  /** Whether the command takes one key or a list of them. */
  keys: "first" | "all";
  /** The argument that says which field of a hash, when there is one. */
  fieldArg?: number;
}

const READ_KEY: Command = { kind: "read", keys: "first" };
const WRITE_KEY: Command = { kind: "write", keys: "first" };

/**
 * The commands this reads, by the lower-cased method name. node-redis
 * spells `hGet` where ioredis spells `hget`, and they are the same
 * command, so the lookup ignores case.
 */
const COMMANDS: Record<string, Command> = {
  get: READ_KEY,
  getdel: WRITE_KEY,
  mget: { kind: "read", keys: "all" },
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
  del: { kind: "write", keys: "all" },
  unlink: { kind: "write", keys: "all" },
  expire: WRITE_KEY,
  expireat: WRITE_KEY,
  persist: WRITE_KEY,
  rename: WRITE_KEY,
  hget: { kind: "read", keys: "first", fieldArg: 1 },
  hmget: { kind: "read", keys: "first", fieldArg: 1 },
  hgetall: READ_KEY,
  hexists: { kind: "read", keys: "first", fieldArg: 1 },
  hset: { kind: "write", keys: "first", fieldArg: 1 },
  hmset: { kind: "write", keys: "first", fieldArg: 1 },
  hsetnx: { kind: "write", keys: "first", fieldArg: 1 },
  hincrby: { kind: "write", keys: "first", fieldArg: 1 },
  hdel: { kind: "write", keys: "first", fieldArg: 1 },
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

interface RecognizerContext {
  resolveWrittenValue?: (value: Node) => Node | null;
}

export function redisRecognizer(call: unknown, ctx: unknown): Effect[] | null {
  const callNode = call as CallExpression;
  const resolve =
    (ctx as RecognizerContext).resolveWrittenValue ?? (() => null);

  const callee = callNode.getExpression();
  if (!N.isPropertyAccessExpression(callee)) {
    return null;
  }
  const method = callee.getName();
  const command = COMMANDS[method.toLowerCase()];
  if (command === undefined || !fromClientLibrary(callee)) {
    return null;
  }

  const args = callNode.getArguments();
  const keys = (command.keys === "all" ? args : args.slice(0, 1))
    .map((arg) => readName(arg, { resolve, unsettled: "reference" }))
    .filter((key): key is string => key !== null);
  const fields =
    command.fieldArg === undefined
      ? []
      : args
          .slice(command.fieldArg, command.fieldArg + 1)
          .map((arg) => readName(arg, { resolve, unsettled: "reference" }))
          .filter((field): field is string => field !== null);

  return [
    {
      type: "interaction",
      binding: storageBinding({
        recognition: RECOGNITION,
        storageSystem: "redis",
        scope: "default",
        container: namespaceOf(keys),
        accessPath: null,
      }),
      callee: callee.getText(),
      interaction: {
        class: "storage-access",
        kind: command.kind,
        fields,
        operation: method,
        ...(keys.length > 0 ? { selector: keys } : {}),
      },
    },
  ];
}

/**
 * The namespace a set of keys share. Keys of one call are the same
 * shape nearly every time, and one that is not leaves the container
 * unsettled rather than picking whichever came first.
 */
function namespaceOf(keys: string[]): string | null {
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

/** Whether a client library declares this command. */
function fromClientLibrary(callee: Node): boolean {
  return CLIENT_MODULES.some((module) => methodDeclaredIn(callee, module));
}

/**
 * Pack export. One recognizer, gated on a file reaching a client
 * library, since that is where a command can come from.
 */
export function redisFramework(): PatternPack {
  return {
    name: "redis",
    protocol: "redis",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    requiresImport: CLIENT_MODULES,
    invocationRecognizers: [redisRecognizer as InvocationRecognizer],
  };
}

export default redisFramework;
