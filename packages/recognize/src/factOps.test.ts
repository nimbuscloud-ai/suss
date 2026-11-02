import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { type FactSource, factCallOps, factValueOps } from "./factOps.js";
import { constructedFrom, declaredBy } from "./ops.js";

/**
 * The facts for, in source order:
 *
 *   const client = new Redis();
 *   client.set(`user:${id}`, { ttl: 5, tags: ["a", "b"] });
 *   send(new PutCommand({ TableName: TABLE }));
 */
function source(over: Partial<FactSource> = {}): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("call", "new", "Redis");
  add("writtenValue", "new");
  add("call", "set", "client.set");
  add("readsProperty", "client.set", "client", "set");
  add("callArg", "set", "0", "tpl");
  add("callArg", "set", "1", "opts");
  add("partAt", "tpl", "0", "user:");
  add("holeAt", "tpl", "1", "id");
  add("writtenValue", "tpl");
  add("objectValue", "opts");
  add("holdsProperty", "opts", "ttl", "five");
  add("holdsProperty", "opts", "tags", "tags");
  add("writtenEntryAt", "opts", "0", "five", "value");
  add("writtenEntryAt", "opts", "1", "tags", "value");
  add("objectValue", "tags");
  add("holdsProperty", "tags", "0", "a");
  add("holdsProperty", "tags", "1", "b");
  add("writtenEntryAt", "tags", "0", "a", "value");
  add("writtenEntryAt", "tags", "1", "b", "value");
  add("call", "send", "send");
  add("callArg", "send", "0", "put");
  add("call", "put", "PutCommand");
  add("writtenValue", "put");
  add("callArg", "put", "0", "input");
  add("objectValue", "input");
  add("holdsProperty", "input", "TableName", "TABLE");
  add("writtenEntryAt", "input", "0", "TABLE", "value");

  const text: Record<string, string> = {
    "client.set": "client.set",
    Redis: "Redis",
    send: "send",
    PutCommand: "PutCommand",
  };
  const literal: Record<string, string | number> = {
    five: 5,
    a: "a",
    b: "b",
  };
  const shape: Record<string, "object" | "list"> = {
    opts: "object",
    input: "object",
    tags: "list",
  };
  return {
    db,
    read: () => undefined,
    writtenAs: (key) => (key === "client" ? "new" : null),
    anchorCalls: (key) => (key === "client" ? ["new"] : []),
    importedFrom: (key, module) =>
      (key === "Redis" && module === "ioredis") ||
      (key === "PutCommand" && module === "@aws-sdk/lib-dynamodb"),
    shapeOf: (key) => shape[key] ?? null,
    textOf: (key) => text[key] ?? key,
    literalOf: (key) => literal[key] ?? null,
    nameOf: (key) =>
      key === "TABLE"
        ? "orders"
        : typeof literal[key] === "string"
          ? String(literal[key])
          : null,
    argOf: (key) => ({ kind: "identifier", name: key }),
    ...over,
  };
}

const opsAt = (key: string, from = source()) => {
  const ops = factCallOps(key, from);
  if (ops === null) {
    throw new Error(`no call at ${key}`);
  }
  return ops;
};

describe("factCallOps", () => {
  it("gives nothing for a key no call is stated at", () => {
    expect(factCallOps("opts", source())).toBeNull();
  });

  it("reads the method, the callee and the arguments off the call", () => {
    const set = opsAt("set");

    expect(set.method()).toBe("set");
    expect(set.calleeText()).toBe("client.set");
    expect(set.argumentCount()).toBe(2);
    expect(opsAt("send").method()).toBeNull();
  });

  it("follows a receiver kept in a name to the construction it was written as", () => {
    const receiver = opsAt("set").receiver();

    expect(receiver?.calleeText()).toBe("Redis");
    expect(opsAt("set").receiverIsFrom(constructedFrom("ioredis"))).toBe(true);
    expect(opsAt("set").receiverIsFrom(constructedFrom("redis"))).toBe(false);
  });

  it("checks a callee by the module it was imported from and the export it names", () => {
    const put = opsAt("send").argument(0);

    expect(put?.isFrom(constructedFrom("@aws-sdk/lib-dynamodb"))).toBe(true);
    expect(
      put?.isFrom(
        constructedFrom({
          from: "@aws-sdk/lib-dynamodb",
          named: ["GetCommand"],
        }),
      ),
    ).toBe(false);
  });

  it("reads a property of the object a construction is handed", () => {
    expect(opsAt("send").propertyAt(0, "TableName", "nothing")).toBe("orders");
    expect(opsAt("send").propertyAt(0, "Key", "nothing")).toBeNull();
  });

  it("gives the one anchor call the origin accepts", () => {
    const anchor = opsAt("set").anchorCall?.(constructedFrom("ioredis"));

    expect(anchor?.calleeText()).toBe("Redis");
    expect(opsAt("set").anchorCall?.(declaredBy("ioredis"))).toBeNull();
  });

  it("asks the adapter whether a library declared the method", () => {
    const declares = source({ declares: (call) => call === "set" });

    expect(opsAt("set", declares).receiverIsFrom(declaredBy("ioredis"))).toBe(
      true,
    );
    expect(opsAt("set").receiverIsFrom(declaredBy("ioredis"))).toBe(false);
  });
});

describe("factValueOps", () => {
  it("reads an object entry by entry, and a list item by item", () => {
    const options = opsAt("set").valueAt(1);
    const entries = options?.entries("nothing") ?? [];

    expect(entries.map((entry) => entry.key)).toEqual(["ttl", "tags"]);
    expect(entries[0]?.value.flag()).toBe(true);
    expect(
      options
        ?.property("tags")
        ?.items()
        .map((item) => item.text()),
    ).toEqual(["a", "b"]);
    expect(options?.items()).toEqual([]);
  });

  it("reads a template as its pieces, with a part for each side of a hole", () => {
    const template = factValueOps("tpl", source());

    expect(template.parts()).toEqual(["user:", ""]);
    expect(template.interpolated?.().map((hole) => hole.asArg())).toEqual([
      { kind: "identifier", name: "id" },
    ]);
    expect(template.holes()).toEqual([null]);
  });
});
