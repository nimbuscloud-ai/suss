import { describe, expect, it } from "vitest";

import { packUnderTest, storageOf } from "@suss/pack-harness";
import { runExamples } from "@suss/recognize";

import { redisFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

// The declaration settles a call by where the method is declared, so a
// fixture needs a client library on disk to resolve against.
const IOREDIS_TYPES = `
  export default class Redis {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<string>;
    setex(key: string, seconds: number, value: string): Promise<string>;
    del(...keys: string[]): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    hget(key: string, field: string): Promise<string | null>;
    hGet(key: string, field: string): Promise<string | null>;
    hset(key: string, field: string, value: string): Promise<number>;
    mget(...keys: string[]): Promise<Array<string | null>>;
    smembers(key: string): Promise<string[]>;
  }
`;

const redis = packUnderTest(redisFramework(), {
  library: { ioredis: IOREDIS_TYPES },
});

const effectsIn = (source: string): Effect[] => redis.effectsIn(source);

const CLIENT = `import Redis from "ioredis";\ndeclare const redis: Redis;`;

describe("a Redis command", () => {
  it("reads the namespace a key belongs to and the key itself", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function isOnline(communityId: string) {
        return redis.get(\`user_online:\${communityId}\`);
      }
    `);

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics).toMatchObject({
      storageSystem: "redis",
      scope: "default",
      container: "user_online",
      accessPath: null,
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "get",
      selector: ["user_online:{communityId}"],
      fields: [],
    });
  });

  it("reads a write as a write", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function remember(id: string, value: string) {
        await redis.setex(\`session:\${id}\`, 900, value);
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      operation: "setex",
      selector: ["session:{id}"],
    });
  });

  it("follows a key written into a const, which is how a writer and a reader share one", () => {
    const effects = effectsIn(`
      ${CLIENT}
      const LAST_REFRESH_KEY = "similarity:last_refresh";
      export async function lastRefresh() {
        return redis.get(LAST_REFRESH_KEY);
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBe("similarity");
    expect(storageOf(effects[0]).interaction).toMatchObject({
      selector: ["similarity:last_refresh"],
    });
  });

  it("reads the field a hash command asks for", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function seatCount(eventId: string) {
        return redis.hget(\`event:\${eventId}\`, "seats");
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      fields: ["seats"],
      selector: ["event:{eventId}"],
    });
  });

  it("reads the same command spelled the way node-redis spells it", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function seatCount(eventId: string) {
        return redis.hGet(\`event:\${eventId}\`, "seats");
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "read",
      fields: ["seats"],
    });
  });

  it("reads every key a command takes several of", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function forget(id: string) {
        await redis.del(\`session:\${id}\`, \`session:\${id}:refresh\`);
      }
    `);

    expect(storageOf(effects[0]).interaction).toMatchObject({
      kind: "write",
      selector: ["session:{id}", "session:{id}:refresh"],
    });
    expect(storageOf(effects[0]).semantics.container).toBe("session");
  });

  it("settles no namespace when one call reaches two of them", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function both(id: string) {
        return redis.mget(\`session:\${id}\`, \`profile:\${id}\`);
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBeNull();
  });

  it("says which parameter a key built at run time comes from", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function read(key: string) {
        return redis.get(key);
      }
    `);

    const { semantics, interaction } = storageOf(effects[0]);
    expect(semantics.container).toBeNull();
    expect(interaction).toMatchObject({ selector: ["{key}"] });
  });

  it("settles no namespace when the front of the key is built at run time", () => {
    const effects = effectsIn(`
      ${CLIENT}
      export async function read(prefix: string, id: string) {
        return redis.get(\`\${prefix}:\${id}\`);
      }
    `);

    expect(storageOf(effects[0]).semantics.container).toBeNull();
  });

  it("leaves a same-named method on something else alone", () => {
    expect(
      effectsIn(`
        declare const cache: { get(key: string): Promise<string> };
        export async function read() {
          return cache.get("user_online:1");
        }
      `),
    ).toEqual([]);
  });
});

describe("the pack itself", () => {
  it("fires only on a file that reaches a client library", () => {
    expect(redisFramework()).toMatchObject({
      name: "redis",
      protocol: "redis",
      requiresImport: ["ioredis", "redis", "iovalkey"],
    });
  });

  it("prices what it declared: every link but the namespace rule is data", () => {
    const declared = redisFramework().declarations?.declarations ?? [];

    expect(declared).toEqual([
      {
        name: "redis",
        dataLinks: 2,
        functionLinks: ["container"],
        astLinks: [],
        example: 'redis.get("user_online:42")',
      },
    ]);
  });

  it("emits the effect its example says it does", () => {
    const ran = runExamples(redisFramework(), (code) =>
      effectsIn(`
        ${CLIENT}
        export async function example() {
          return ${code};
        }
      `),
    );

    expect(ran).toHaveLength(1);
    expect(storageOf(ran[0].effects[0]).interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      operation: "get",
      selector: ["user_online:42"],
    });
    expect(storageOf(ran[0].effects[0]).semantics.container).toBe(
      "user_online",
    );
  });
});
