import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { type FactSource, factCallOps, factValueOps } from "./factOps.js";
import {
  anyOf,
  constructedFrom,
  declaredBy,
  global,
  handedBy,
  imported,
  inherits,
  returnedBy,
  typed,
} from "./ops.js";

import type { ReceiverOrigin, ValueOps } from "@suss/extractor";

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
    importedAs: (key, module) =>
      key === "Redis" && module === "ioredis" ? ["Redis"] : [],
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

  it("gives the same site for every ops over one call, so a walk can tell it came back", () => {
    expect(opsAt("set").receiver()?.site?.()).toBe("new");
    expect(opsAt("new").site?.()).toBe("new");
  });

  it("reads a receiver the construction made in place, as in `new Redis().set(k)`", () => {
    const inPlace = source();
    const db = inPlace.db as Database;
    db.add("call", ["made", "Redis"]);
    db.add("call", ["setAtOnce", "made.set"]);
    db.add("readsProperty", ["made.set", "made", "set"]);

    expect(
      opsAt("setAtOnce", inPlace).receiverIsFrom(constructedFrom("ioredis")),
    ).toBe(true);
    expect(
      opsAt("setAtOnce", inPlace).receiverIsFrom(constructedFrom("redis")),
    ).toBe(false);
  });

  it("checks a callee by the module it was imported from and the export it names", () => {
    const put = opsAt("send").argument(0);

    expect(put?.isFrom(constructedFrom("@aws-sdk/lib-dynamodb"))).toBe(true);
    expect(
      put?.isFrom(
        constructedFrom({
          from: ["@aws-sdk/lib-dynamodb"],
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
    expect(opsAt("set", declares).receiverIsFrom(declaredBy("redis"))).toBe(
      true,
    );
  });

  it("checks what made the receiver when the adapter cannot read declarations", () => {
    expect(opsAt("set").receiverIsFrom(declaredBy("ioredis"))).toBe(true);
    expect(opsAt("set").receiverIsFrom(declaredBy("redis"))).toBe(false);
    expect(opsAt("send").isFrom(declaredBy("ioredis"))).toBe(false);
  });
});

/**
 * More facts, for:
 *
 *   aws.sqs.send(makeClient(), { [table]: true, plain: "q" }, "text");
 *   query();
 *
 * where makeClient is a project function that returns `new SQS()`.
 */
function moreSource(over: Partial<FactSource> = {}): FactSource {
  const base = source();
  const db = base.db as Database;
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("call", "sqsSend", "aws.sqs.send");
  add("readsProperty", "aws.sqs.send", "aws.sqs", "send");
  add("readsProperty", "aws.sqs", "aws", "sqs");
  add("callArg", "sqsSend", "0", "make");
  add("callArg", "sqsSend", "1", "bag");
  add("callArg", "sqsSend", "2", "str");
  add("call", "make", "makeClient");
  add("writtenValue", "make");
  add("call", "newSqs", "SQS");
  add("writtenValue", "newSqs");
  add("objectValue", "bag");
  add("holdsUnderKey", "bag", "yes");
  add("computedKeyAt", "bag", "0", "table");
  add("holdsProperty", "bag", "plain", "q");
  add("writtenEntryAt", "bag", "0", "yes", "value");
  add("writtenEntryAt", "bag", "1", "q", "value");
  add("writtenValue", "str");
  add("call", "bare", "query");
  return {
    ...base,
    db,
    textOf: (key) => key,
    literalOf: (key) =>
      ({ yes: true, q: "q", str: "text" })[key as "yes" | "q" | "str"] ?? null,
    nameOf: (key, unsettled) => {
      if (key === "table") {
        return "orders";
      }
      return unsettled === "reference" ? `{${key}}` : null;
    },
    namesOf: (key) => (key === "str" ? ["text"] : null),
    shapeOf: (key) => (key === "bag" ? "object" : base.shapeOf(key)),
    importedFrom: (key, module) =>
      (key === "aws" && module === "aws-sdk") ||
      (key === "SQS" && module === "aws-sdk"),
    returnedBy: (call) => (call === "make" ? "newSqs" : null),
    ...over,
  };
}

describe("factCallOps, further", () => {
  it("reads a call with no receiver, and a member read more than one level deep", () => {
    const send = opsAt("sqsSend", moreSource());

    expect(opsAt("bare", moreSource()).receiver()).toBeNull();
    expect(send.method()).toBe("send");
    expect(send.isFrom(constructedFrom("aws-sdk"))).toBe(true);
    expect(send.receiverIsFrom(constructedFrom("aws-sdk"))).toBe(true);
    expect(send.nameAt(2, "reference")).toBe("{str}");
    expect(send.nameAt(9, "nothing")).toBeNull();
    expect(send.callee()).toBeNull();
  });

  it("reads a construction a project function returns as the argument's call", () => {
    const made = opsAt("sqsSend", moreSource()).argument(0);

    expect(made?.calleeText()).toBe("makeClient");
    expect(
      opsAt("sqsSend", moreSource()).propertyAt(1, "plain", "nothing"),
    ).toBeNull();
    expect(
      opsAt("sqsSend", moreSource()).propertyAt(2, "plain", "nothing"),
    ).toBeNull();
  });

  it("says a call to a project method was not made by a library", () => {
    const project = moreSource({ callsProjectMethod: () => true });

    expect(
      opsAt("sqsSend", project).receiverIsFrom(constructedFrom("aws-sdk")),
    ).toBe(false);
    expect(opsAt("sqsSend", project).isFrom(declaredBy("aws-sdk"))).toBe(false);
  });

  it("follows a receiver a project function made to the construction it returns", () => {
    const fromProject = moreSource({
      writtenAs: (key) => (key === "client" ? "make" : null),
      importedFrom: (key, module) => key === "SQS" && module === "aws-sdk",
    });

    expect(
      opsAt("set", fromProject).receiverIsFrom(constructedFrom("aws-sdk")),
    ).toBe(true);
    expect(
      opsAt("set", fromProject).receiverIsFrom(constructedFrom("ioredis")),
    ).toBe(false);
  });
});

describe("factCallOps, over an adapter that spells a class's own method its own way", () => {
  /** `Order.create(...)`, stated once as the class's own method and once as an instance's. */
  function classCall(over: Partial<FactSource> = {}): FactSource {
    const base = source();
    const db = base.db as Database;
    db.add("call", ["create", "Order.create"]);
    db.add("readsProperty", ["Order.create", "Order", "::create"]);
    db.add("readsProperty", ["Order.create", "Order", "create"]);
    return { ...base, db, ...over };
  }

  it("reads the plain name back from the adapter's spelling", () => {
    const plain = classCall({
      memberName: (stated) => stated.replace(/^::/, ""),
    });

    expect(opsAt("create", plain).method()).toBe("create");
  });

  it("gives no method while two spellings disagree, and leaves out one the adapter drops", () => {
    expect(opsAt("create", classCall()).method()).toBeNull();
    expect(
      opsAt(
        "create",
        classCall({
          memberName: (stated) => (stated.startsWith("::") ? null : stated),
        }),
      ).method(),
    ).toBe("create");
  });
});

/**
 * The facts for `console.log(x)`, `out.write(x)` in a helper the given
 * streams reach, and `print(x)`, over an adapter that spells `console`
 * and calls `print` with no receiver.
 */
function globals(reaching: readonly string[]): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("call", "log", "console.log");
  add("readsProperty", "console.log", "console", "log");
  add("callArg", "log", "0", "x");
  add("call", "write", "out.write");
  add("readsProperty", "out.write", "out", "write");
  add("call", "print", "print");
  return {
    ...source(),
    db,
    textOf: (key) => key,
    spellsGlobal: (key, path) => key === "console" && path === "console",
    callsGlobal: (call, path) => call === "print" && path === "print",
    globalsReaching: (key) => (key === "out" ? reaching : []),
    typeShapeOf: (key) => (key === "x" ? { type: "text" } : null),
  };
}

describe("factCallOps, at the runtime's own globals", () => {
  const STREAMS = ["process.stdout", "process.stderr"];

  it("takes a receiver spelled as a path as that path", () => {
    const log = opsAt("log", globals([]));

    expect(log.receiverGlobal?.(["console"])).toBe("console");
    expect(log.receiverIsFrom(global("console"))).toBe(true);
    expect(log.receiverGlobal?.(STREAMS)).toBeUndefined();
    expect(log.valueAt(0)?.shape?.()).toEqual({ type: "text" });
  });

  it("takes the one path the rules followed into a receiver, and none when two did", () => {
    expect(
      opsAt("write", globals(["process.stdout"])).receiverGlobal?.(STREAMS),
    ).toBe("process.stdout");
    expect(
      opsAt("write", globals(STREAMS)).receiverGlobal?.(STREAMS),
    ).toBeNull();
    expect(
      opsAt("write", globals(["process.stdout"])).receiverGlobal?.(["console"]),
    ).toBeUndefined();
  });

  it("reads a call of the global with no receiver through the adapter", () => {
    const print = opsAt("print", globals([]));

    expect(print.isFrom(global("print"))).toBe(true);
    expect(print.isFrom(global("puts"))).toBe(false);
    expect(print.receiverGlobal?.(["print"])).toBeUndefined();
    expect(opsAt("set").valueAt(0)?.shape?.()).toBeNull();
  });
});

describe("factCallOps, where nothing settles", () => {
  it("finds no receiver construction for a bare call, or for a receiver written as nothing", () => {
    const unwritten = source({ writtenAs: () => null });

    expect(
      opsAt("bare", moreSource()).receiverIsFrom(constructedFrom("aws-sdk")),
    ).toBe(false);
    expect(opsAt("set", unwritten).receiver()).toBeNull();
    expect(
      opsAt("set", unwritten).receiverIsFrom(constructedFrom("ioredis")),
    ).toBe(false);
  });

  it("checks the export a receiver was made from when the origin lists some", () => {
    expect(
      opsAt("set").receiverIsFrom(
        constructedFrom({ from: ["ioredis"], named: ["Cluster"] }),
      ),
    ).toBe(false);
    expect(
      opsAt("set").receiverIsFrom(
        constructedFrom({ from: ["ioredis"], named: ["Redis"] }),
      ),
    ).toBe(true);
  });

  it("reads no property off an argument the call does not pass", () => {
    expect(opsAt("send").propertyAt(5, "TableName", "nothing")).toBeNull();
    expect(opsAt("send").valueAt(5)).toBeNull();
    expect(opsAt("send").argument(5)).toBeNull();
  });
});

describe("factValueOps, of a value an encoder was handed", () => {
  it("asks the adapter what the value a name was written as encodes", () => {
    const encoding = source({
      writtenAs: (key) => (key === "line" ? "put" : null),
      encodedOf: (key) =>
        key === "put" ? { codec: "json", value: "input" } : null,
    });
    const encoded = factValueOps("line", encoding).encoded?.();

    expect(encoded?.codec).toBe("json");
    expect(encoded?.value.property("TableName")?.name("nothing")).toBe(
      "orders",
    );
    expect(factValueOps("opts", encoding).encoded?.()).toBeNull();
    expect(factValueOps("put", source()).encoded?.()).toBeNull();
  });
});

describe("factValueOps, further", () => {
  it("reads a computed key through the adapter, and a flag the source wrote", () => {
    const bag = opsAt("sqsSend", moreSource()).valueAt(1);
    const entries = bag?.entries("nothing") ?? [];

    expect(entries.map((entry) => entry.key)).toEqual(["orders", "plain"]);
    expect(entries[0]?.value.flag()).toBe(true);
    expect(bag?.property("plain")?.text()).toBe("q");
    expect(bag?.text()).toBeNull();
    expect(bag?.parts()).toBeNull();
  });

  it("tells a computed key from a written one by position when both entries hold the same name", () => {
    // `{ key: x, "e": x, other: x }`, with `x` keyed by its scope.
    const facts = moreSource();
    const db = facts.db as Database;
    db.add("objectValue", ["shared"]);
    db.add("holdsUnderKey", ["shared", "x"]);
    db.add("computedKeyAt", ["shared", "0", "table"]);
    db.add("holdsProperty", ["shared", "e", "x"]);
    db.add("holdsUnderKey", ["shared", "x"]);
    db.add("computedKeyAt", ["shared", "2", "table"]);
    db.add("computedKeyAt", ["shared", "2", "other"]);
    for (const position of ["0", "1", "2"]) {
      db.add("writtenEntryAt", ["shared", position, "x", "value"]);
    }
    const shared = factValueOps("shared", {
      ...facts,
      shapeOf: (key) => (key === "shared" ? "object" : facts.shapeOf(key)),
    });

    expect(shared.entries("nothing").map((entry) => entry.key)).toEqual([
      "orders",
      "e",
      null,
    ]);
    expect(shared.property("e")?.source?.()).toBe("x");
  });

  it("leaves unsettled a computed key no expression is stated for, and leaves out a value under no key", () => {
    // `{ [k]: x, y }` where the adapter states no key for either entry.
    const facts = moreSource();
    const db = facts.db as Database;
    db.add("objectValue", ["bare"]);
    db.add("holdsUnderKey", ["bare", "x"]);
    db.add("writtenEntryAt", ["bare", "0", "x", "value"]);
    db.add("writtenEntryAt", ["bare", "1", "y", "value"]);
    const bare = factValueOps("bare", {
      ...facts,
      shapeOf: (key) => (key === "bare" ? "object" : facts.shapeOf(key)),
    });

    expect(bare.entries("reference").map((entry) => entry.key)).toEqual([null]);
  });

  it("reads a string as one piece, and asks the adapter for its name and its strings", () => {
    const text = factValueOps("str", moreSource());

    expect(text.parts()).toEqual(["text"]);
    expect(text.name("reference")).toBe("{str}");
    expect(text.names?.(4)).toEqual(["text"]);
    expect(text.entries("nothing")).toEqual([]);
    expect(text.property("plain")).toBeNull();
    expect(text.flag()).toBeNull();
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

/**
 * The facts for, in source order, with `x` keyed by its name the way
 * Python and Ruby key one, so two entries share it:
 *
 *   base = { table: "drafts", id: 1 }
 *   row = { ...base, table: "orders", name: x, alias: x, ...make() }
 *   ring = { ...ring, own: 2 }
 *   put(row)
 */
function spreads(): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("objectValue", "base");
  add("holdsProperty", "base", "table", "drafts");
  add("holdsProperty", "base", "id", "one");
  add("writtenEntryAt", "base", "0", "drafts", "value");
  add("writtenEntryAt", "base", "1", "one", "value");
  add("objectValue", "row");
  add("writtenEntryAt", "row", "0", "baseName", "spread");
  add("holdsProperty", "row", "table", "orders");
  add("writtenEntryAt", "row", "1", "orders", "value");
  add("holdsProperty", "row", "name", "x");
  add("holdsProperty", "row", "alias", "x");
  add("writtenEntryAt", "row", "2", "x", "value");
  add("writtenEntryAt", "row", "3", "x", "value");
  add("call", "made", "make");
  add("writtenEntryAt", "row", "4", "made", "spread");
  add("objectValue", "ring");
  add("writtenEntryAt", "ring", "0", "ringName", "spread");
  add("holdsProperty", "ring", "own", "two");
  add("writtenEntryAt", "ring", "1", "two", "value");
  add("call", "put", "put");
  add("callArg", "put", "0", "rowName");

  const written: Record<string, string> = {
    baseName: "base",
    ringName: "ring",
    rowName: "row",
  };
  const literal: Record<string, string | number> = {
    drafts: "drafts",
    orders: "orders",
    one: 1,
    two: 2,
  };
  return {
    db,
    read: () => undefined,
    writtenAs: (key) => written[key] ?? null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: () => [],
    shapeOf: (key) => (["base", "row", "ring"].includes(key) ? "object" : null),
    textOf: (key) => key,
    literalOf: (key) => literal[key] ?? null,
    nameOf: (key) => {
      const stated = literal[key];
      return typeof stated === "string" ? stated : null;
    },
    argOf: (key) => ({ kind: "identifier", name: key }),
  };
}

describe("factValueOps over a spread", () => {
  it("puts the entries a spread unpacks in its place, a key written again keeping its place and taking the later value", () => {
    const row = factValueOps("rowName", spreads());
    const entries = row.entries("nothing");

    expect(entries.map((entry) => entry.key)).toEqual([
      "table",
      "id",
      "name",
      "alias",
    ]);
    expect(entries[0]?.value.text()).toBe("orders");
    expect(entries[1]?.value.flag()).toBe(true);
  });

  it("reads a property through a spread, the last one written winning", () => {
    const row = factValueOps("rowName", spreads());

    expect(row.property("table")?.text()).toBe("orders");
    expect(row.property("id")?.flag()).toBe(true);
    expect(row.property("alias")?.asArg()).toEqual({
      kind: "identifier",
      name: "x",
    });
    expect(row.property("missing")).toBeNull();
    expect(opsAt("put", spreads()).propertyAt(0, "table", "nothing")).toBe(
      "orders",
    );
  });

  it("reads an object that spreads itself once", () => {
    const ring = factValueOps("ring", spreads());

    expect(ring.entries("nothing").map((entry) => entry.key)).toEqual(["own"]);
    expect(ring.property("own")?.flag()).toBe(true);
    expect(ring.property("missing")).toBeNull();
  });

  it("reads an object written here by its own keys, a spread and a name left out", () => {
    const row = factValueOps("row", spreads());

    expect(row.ownProperty?.("table")?.text()).toBe("orders");
    expect(row.ownProperty?.("id")).toBeNull();
    expect(factValueOps("rowName", spreads()).ownProperty?.("table")).toBe(
      null,
    );
  });

  it("reads every value as other where the adapter says nothing of its form", () => {
    expect(factValueOps("row", spreads()).form?.()).toBe("other");
    expect(
      factValueOps("row", { ...spreads(), formOf: () => "object" }).form?.(),
    ).toBe("object");
  });
});

/**
 * The facts for, with makeRow a project function returning `{ made: 1 }`:
 *
 *   toRow = (u) => ({ name: u })
 *   pick = (u) => { if (u) return { a: u }; return { b: u } }
 *   users.map(toRow); users.map(pick); users.map(String)
 *   [{ name: u } for u in users]
 *   { ...makeRow(), d: 4 }
 *   save(makeRow())
 *   send(new PutCommand({ TableName: "orders" }))
 */
function mapped(): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("func", "toRow");
  add("returnsValue", "toRow", "rowObject");
  add("objectValue", "rowObject");
  add("holdsProperty", "rowObject", "name", "u");
  add("writtenEntryAt", "rowObject", "0", "u", "value");
  add("func", "pick");
  add("returnsValue", "pick", "aObject");
  add("returnsValue", "pick", "bObject");
  for (const [call, callback] of [
    ["byName", "toRowName"],
    ["byPick", "pickName"],
    ["byString", "String"],
  ] as const) {
    add("call", call, "users.map");
    add("callArg", call, "0", callback);
    add("eachElement", call, callback);
  }
  add("eachElement", "comprehension", "rowObject");
  add("objectValue", "spreading");
  add("writtenEntryAt", "spreading", "0", "makeInSpread", "spread");
  add("holdsProperty", "spreading", "d", "four");
  add("writtenEntryAt", "spreading", "1", "four", "value");
  for (const call of ["makeInSpread", "makeInPlace"]) {
    add("call", call, "makeRow");
    add("writtenValue", call);
  }
  add("objectValue", "madeObject");
  add("holdsProperty", "madeObject", "made", "one");
  add("writtenEntryAt", "madeObject", "0", "one", "value");
  add("call", "save", "save");
  add("callArg", "save", "0", "makeInPlace");
  add("call", "send", "send");
  add("callArg", "send", "0", "put");
  add("call", "put", "PutCommand");
  add("callArg", "put", "0", "input");
  add("objectValue", "input");
  add("holdsProperty", "input", "TableName", "orders");
  add("writtenEntryAt", "input", "0", "orders", "value");

  const shapes: Record<string, "object"> = {
    rowObject: "object",
    spreading: "object",
    madeObject: "object",
    input: "object",
  };
  const comesTo: Record<string, string[]> = {
    toRowName: ["toRow"],
    pickName: ["pick"],
  };
  return {
    db,
    read: () => undefined,
    writtenAs: (key) =>
      key === "makeInSpread" || key === "makeInPlace" ? "madeObject" : null,
    comesTo: (key) => comesTo[key] ?? [],
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: () => [],
    shapeOf: (key) => shapes[key] ?? null,
    textOf: (key) => key,
    literalOf: (key) => (key === "orders" ? "orders" : null),
    nameOf: (key) => names[key] ?? null,
    argOf: (key) => ({ kind: "identifier", name: key }),
  };
}

const names: Record<string, string> = { orders: "orders", one: "first" };

describe("factValueOps over a mapped list and a project call", () => {
  const keysOf = (value: ValueOps | undefined) =>
    value?.entries("nothing").map((entry) => entry.key);

  it("reads a list built by map as one item, what its callback returns", () => {
    const [item, ...more] = factValueOps("byName", mapped()).items();

    expect(more).toEqual([]);
    expect(keysOf(item)).toEqual(["name"]);
  });

  it("reads a comprehension's one item as the element it writes in place", () => {
    const [item] = factValueOps("comprehension", mapped()).items();

    expect(keysOf(item)).toEqual(["name"]);
  });

  it("reads no item for a callback with two returns, or one that comes to no function", () => {
    expect(factValueOps("byPick", mapped()).items()).toEqual([]);
    expect(factValueOps("byString", mapped()).items()).toEqual([]);
  });

  it("reads an object off what a project call returns, in place or spread", () => {
    const made = factValueOps("makeInPlace", mapped());

    expect(keysOf(made)).toEqual(["made"]);
    expect(made.property("made")?.source?.()).toBe("one");
    expect(keysOf(factValueOps("spreading", mapped()))).toEqual(["made", "d"]);
    expect(
      factCallOps("save", mapped())?.propertyAt(0, "made", "nothing"),
    ).toBe("first");
  });

  it("keeps a construction as written, so a command is read off the object it was made with", () => {
    const send = factCallOps("send", mapped());

    expect(send?.propertyAt(0, "TableName", "nothing")).toBe("orders");
    expect(factValueOps("put", mapped()).entries("nothing")).toEqual([]);
  });
});

/**
 * The facts for, with TypeScript's reference, declaration and value rows,
 * and a Ruby name bound to its value:
 *
 *   const users = db.users;   users.find(1)
 *   const again = users;      again.find(2)
 *   const client = new Client();   client.find(3)
 *   models = db.models        models.find(4)
 */
function heldFirst(): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  const callOn = (call: string, object: string, method: string) => {
    add("call", call, `${object}.${method}`);
    add("readsProperty", `${object}.${method}`, object, method);
  };
  callOn("find1", "usersRef", "find");
  add("binds", "usersRef", "usersDecl");
  add("binds", "usersDecl", "db.users");
  add("readsProperty", "db.users", "db", "users");
  callOn("find2", "againRef", "find");
  add("binds", "againRef", "againDecl");
  add("binds", "againDecl", "usersCopied");
  add("binds", "usersCopied", "usersDecl");
  callOn("find3", "clientRef", "find");
  add("binds", "clientRef", "clientDecl");
  add("binds", "clientDecl", "newClient");
  add("call", "newClient", "Client");
  callOn("find4", "models", "find");
  add("binds", "models", "db.models()");
  callOn("db.models()", "db", "models");

  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: () => [],
    shapeOf: () => null,
    textOf: (key) => key,
    literalOf: () => null,
    nameOf: () => null,
    argOf: (key) => ({ kind: "identifier", name: key }),
  };
}

describe("the ops over a member kept in a name", () => {
  it("reads the member a name was set to through its declaration", () => {
    const member = opsAt("find1", heldFirst()).member?.() ?? null;

    expect(member?.method()).toBe("users");
    expect(member?.calleeText()).toBe("db.users");
  });

  it("follows one declaration and no further, and leaves a name set to a construction alone", () => {
    expect(opsAt("find2", heldFirst()).member?.()).toBeNull();
    expect(opsAt("find3", heldFirst()).member?.()).toBeNull();
  });

  it("reads a name set to a call made on a receiver with no arguments, which is how Ruby reads a member", () => {
    expect(opsAt("find4", heldFirst()).member?.()?.method()).toBe("models");
  });
});

describe("the block a call is written with", () => {
  it("is the function the call states as its block, and null for a call without one", () => {
    const facts = spreads();
    const db = facts.db as Database;
    db.add("call", ["each", "items.each"]);
    db.add("callBlock", ["each", "block"]);

    expect(factCallOps("each", facts)?.block?.()?.source?.()).toBe("block");
    expect(factCallOps("put", facts)?.block?.()).toBeNull();
  });
});

/**
 * The facts for, in source order:
 *
 *   hook = Hook()
 *   hook.get_client().query(sql="SELECT 1")
 *   conn = PG::Connection.new
 *   conn.exec("SELECT 2")
 */
function clients(): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("call", "mk", "Hook");
  add("writtenValue", "mk");
  add("call", "gc", "hook.get_client");
  add("readsProperty", "hook.get_client", "hook", "get_client");
  add("call", "q", "gc.query");
  add("readsProperty", "gc.query", "gc", "query");
  add("callKeywordArg", "q", "sql", "stmt");
  add("writtenValue", "stmt");
  add("call", "pg", "PG::Connection.new");
  add("readsProperty", "PG::Connection.new", "PG::Connection", "new");
  add("writtenValue", "pg");
  add("call", "ex", "conn.exec");
  add("readsProperty", "conn.exec", "conn", "exec");

  const made: Record<string, string> = { hook: "mk", conn: "pg" };
  return {
    db,
    read: () => undefined,
    writtenAs: (key) => made[key] ?? null,
    anchorCalls: () => [],
    importedFrom: (key, module) =>
      (key === "Hook" && module === "airflow") ||
      (key === "PG::Connection" && module === "PG"),
    importedAs: () => [],
    shapeOf: () => null,
    constructedClass: (callee) =>
      callee === "PG::Connection.new" ? "Connection" : null,
    textOf: (key) => key,
    literalOf: (key) => (key === "stmt" ? "SELECT 1" : null),
    nameOf: () => null,
    argOf: (key) => ({ kind: "identifier", name: key }),
  };
}

describe("the ops over a keyword, a client a method returned and a class made by its constructor method", () => {
  const hook = constructedFrom("airflow");

  it("reads an argument passed under a keyword, and nothing under another", () => {
    const query = opsAt("q", clients());

    expect(query.keywordAt?.("sql")?.text()).toBe("SELECT 1");
    expect(query.keywordAt?.("query") ?? null).toBeNull();
  });

  it("takes a receiver a library method returned when that method was called on the origin it names", () => {
    const query = opsAt("q", clients());

    expect(query.receiverIsFrom(returnedBy("get_client", hook))).toBe(true);
    expect(query.receiverIsFrom(returnedBy("get_conn", hook))).toBe(false);
    expect(
      query.receiverIsFrom(returnedBy("get_client", constructedFrom("other"))),
    ).toBe(false);
    expect(opsAt("gc", clients()).isFrom(returnedBy("get_client", hook))).toBe(
      true,
    );
  });

  it("takes a receiver any one of several origins accepts", () => {
    const query = opsAt("q", clients());

    expect(
      query.receiverIsFrom(
        anyOf(constructedFrom("other"), returnedBy("get_client", hook)),
      ),
    ).toBe(true);
    expect(query.receiverIsFrom(anyOf(constructedFrom("other")))).toBe(false);
    expect(
      opsAt("gc", clients()).isFrom(
        anyOf(constructedFrom("other"), returnedBy("get_client", hook)),
      ),
    ).toBe(true);
  });

  it("names a construction written through the class's constructor method after the class", () => {
    const exec = opsAt("ex", clients());

    expect(
      exec.receiverIsFrom(
        constructedFrom({ from: ["PG"], named: ["Connection"] }),
      ),
    ).toBe(true);
    expect(
      exec.receiverIsFrom(constructedFrom({ from: ["PG"], named: ["new"] })),
    ).toBe(false);
  });
});

/**
 * The facts for, in source order:
 *
 *   to.dispatch("orders", body);    // `to` a parameter
 *   ledger.publish("ledger", body); // `ledger` the module, imported whole
 *   publish("ledger", body);        // `publish` imported by name
 */
function dispatches(over: Partial<FactSource> = {}): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("call", "dispatch", "to.dispatch");
  add("readsProperty", "to.dispatch", "to", "dispatch");
  add("call", "viaModule", "ledger.publish");
  add("readsProperty", "ledger.publish", "ledger", "publish");
  add("call", "bare", "publish");
  const imports: Record<string, readonly string[]> = {
    ledger: ["*"],
    publish: ["publish"],
  };
  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: (key, module) =>
      module === "ledger" ? (imports[key] ?? []) : [],
    shapeOf: () => null,
    textOf: (key) => key,
    literalOf: () => null,
    nameOf: () => null,
    argOf: (key) => ({ kind: "identifier", name: key }),
    ...over,
  };
}

describe("the ops over a typed or an imported receiver", () => {
  const relay = typed({ from: ["relay"], named: ["Dispatcher"] });

  it("asks the adapter whether a receiver is declared as one of the types", () => {
    const asked: string[] = [];
    const declaring = dispatches({
      typedAs: (call, origin) => {
        asked.push(call);
        return origin.named?.includes("Dispatcher") === true;
      },
    });

    expect(opsAt("dispatch", declaring).receiverIsFrom(relay)).toBe(true);
    expect(
      opsAt("dispatch", declaring).receiverIsFrom(
        typed({ from: ["relay"], named: ["Other"] }),
      ),
    ).toBe(false);
    expect(opsAt("bare", declaring).isFrom(relay)).toBe(false);
    expect(asked).toEqual(["dispatch", "dispatch"]);
  });

  it("checks what made the receiver where the language declares no types", () => {
    expect(
      opsAt("set").receiverIsFrom(
        typed({ from: ["ioredis"], named: ["Redis"] }),
      ),
    ).toBe(true);
    expect(
      opsAt("set").receiverIsFrom(
        typed({ from: ["ioredis"], named: ["Cluster"] }),
      ),
    ).toBe(false);
  });

  it("takes a receiver or a callee the file imported under a name the origin asks for", () => {
    const ops = dispatches();

    expect(
      opsAt("viaModule", ops).receiverIsFrom(
        imported({ from: ["ledger"], named: ["*"] }),
      ),
    ).toBe(true);
    expect(
      opsAt("viaModule", ops).receiverIsFrom(
        imported({ from: ["ledger"], named: ["publish"] }),
      ),
    ).toBe(false);
    expect(
      opsAt("bare", ops).isFrom(
        imported({ from: ["ledger"], named: ["publish"] }),
      ),
    ).toBe(true);
    expect(opsAt("bare", ops).isFrom(imported({ from: ["ledger"] }))).toBe(
      true,
    );
    expect(
      opsAt("bare", ops).receiverIsFrom(imported({ from: ["ledger"] })),
    ).toBe(false);
    expect(opsAt("dispatch", ops).isFrom(imported({ from: ["ledger"] }))).toBe(
      false,
    );
  });

  it("says a call to a name has a named callee, and a method call does not", () => {
    expect(opsAt("bare", dispatches()).namedCallee?.()).toBe(true);
    expect(opsAt("viaModule", dispatches()).namedCallee?.()).toBe(false);
  });
});

/**
 * The facts for, in source order, with `L` imported as ledger's `Ledger`,
 * and `Send` a parameter that a caller passes the same import to:
 *
 *   const book = new L();
 *   book.append("entry");
 *   new Send();
 *
 * Every key the ops ask `importedAs` about goes into `asked`.
 */
function aliased(asked: string[] = []): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("call", "made", "L");
  add("writtenValue", "made");
  add("imports", "L", "ledger", "Ledger");
  add("call", "append", "book.append");
  add("readsProperty", "book.append", "book", "append");
  add("call", "relayed", "Send");
  add("binds", "Send", "relay#Send");
  add("paramOf", "relay", "0", "relay#Send");
  const imports: Record<string, readonly string[]> = {
    L: ["Ledger"],
    ns: ["*"],
    Send: ["Ledger"],
  };
  return {
    db,
    read: () => undefined,
    writtenAs: (key) => (key === "book" ? "made" : null),
    anchorCalls: () => [],
    importedFrom: (key, module) =>
      (key === "L" || key === "Send") && module === "ledger",
    importedAs: (key, module) => {
      asked.push(key);
      return module === "ledger" ? (imports[key] ?? []) : [];
    },
    shapeOf: () => null,
    textOf: (key) => key,
    literalOf: () => null,
    nameOf: () => null,
    argOf: (key) => ({ kind: "identifier", name: key }),
  };
}

describe("the ops over a name imported under another name", () => {
  it("matches `named` against the export the constructor was imported as", () => {
    const ledger = (named: string) =>
      constructedFrom({ from: ["ledger"], named: [named] });

    expect(opsAt("append", aliased()).receiverIsFrom(ledger("Ledger"))).toBe(
      true,
    );
    expect(opsAt("append", aliased()).receiverIsFrom(ledger("Other"))).toBe(
      false,
    );
    expect(opsAt("made", aliased()).isFrom(ledger("Ledger"))).toBe(true);
  });

  it("gives the export a callee was imported as, and nothing for a callee no import made", () => {
    expect(opsAt("made", aliased()).calleeImportedAs?.(["ledger"])).toBe(
      "Ledger",
    );
    expect(opsAt("made", aliased()).calleeImportedAs?.(["other"])).toBeNull();
    expect(
      opsAt("append", aliased()).calleeImportedAs?.(["ledger"]),
    ).toBeNull();
  });

  it("never asks what a parameter was imported as, whatever its callers pass", () => {
    const asked: string[] = [];
    const relayed = opsAt("relayed", aliased(asked));

    expect(relayed.calleeImportedAs?.(["ledger"])).toBeNull();
    expect(
      relayed.isFrom(constructedFrom({ from: ["ledger"], named: ["Ledger"] })),
    ).toBe(false);
    expect(asked).toEqual([]);
  });
});

/**
 * The facts for, in source order, where `keep` returns its argument and
 * `factory` returns a function it writes:
 *
 *   const made = keep({ label: TITLE });
 *   const either = cond ? made : () => null;
 *   const both = cond ? made : other;
 *   const row = { ...made, own: 1 };
 *   const items = [made];
 *   factory();
 */
function members(
  reads: "every member" | "no member" = "every member",
): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("objectValue", "obj");
  add("holdsProperty", "obj", "label", "TITLE");
  add("writtenEntryAt", "obj", "0", "TITLE", "value");
  add("objectValue", "other");
  add("func", "arrow");
  add("objectValue", "row");
  add("writtenEntryAt", "row", "0", "made", "spread");
  add("holdsProperty", "row", "own", "one");
  add("writtenEntryAt", "row", "1", "one", "value");
  add("objectValue", "items");
  add("call", "factoryCall", "factory");
  add("func", "inner");

  const comesTo: Record<string, readonly string[]> = {
    made: ["obj"],
    either: ["obj", "arrow"],
    both: ["obj", "other"],
  };
  const shape: Record<string, "object" | "list"> = {
    obj: "object",
    other: "object",
    row: "object",
    items: "list",
  };
  const base: FactSource = {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: () => [],
    shapeOf: (key) => shape[key] ?? null,
    textOf: (key) => `text of ${key}`,
    literalOf: () => null,
    nameOf: () => null,
    argOf: (key) => ({ kind: "identifier", name: key }),
  };
  if (reads === "no member") {
    return base;
  }
  return {
    ...base,
    evaluatedOf: (key) => (key === "TITLE" ? "Orders" : null),
    comesTo: (key) => comesTo[key] ?? [],
    givesBack: (key) => (key === "factoryCall" ? "inner" : null),
    importSpecifierOf: (key) => (key === "TITLE" ? "./titles" : null),
  };
}

/** The source text of the object a value comes to, or null for none. */
const objectText = (key: string, from = members()) =>
  factValueOps(key, from).object?.()?.source?.() ?? null;

/** The source text of the function a value is, or null for none. */
const functionText = (key: string, from = members()) =>
  factValueOps(key, from).function?.()?.source?.() ?? null;

describe("the value members over the facts", () => {
  it("gives the one object a value comes to, leaving out a function it may also come to", () => {
    expect(objectText("made")).toBe("text of obj");
    expect(objectText("either")).toBe("text of obj");
    expect(objectText("obj")).toBe("text of obj");
  });

  it("gives no object for a value that comes to two, to a list, or to nothing", () => {
    expect(objectText("both")).toBeNull();
    expect(objectText("items")).toBeNull();
    expect(objectText("factoryCall")).toBeNull();
    expect(objectText("made", members("no member"))).toBeNull();
  });

  it("gives the function a value is, comes to, or a factory call gives back", () => {
    expect(functionText("arrow")).toBe("text of arrow");
    expect(functionText("either")).toBe("text of arrow");
    expect(functionText("factoryCall")).toBe("text of inner");
    expect(functionText("made")).toBeNull();
  });

  it("reads what the evaluator settles a value to and where a name was imported from, as the adapter says", () => {
    const label = factValueOps("made", members()).object?.()?.property("label");

    expect(label?.evaluated?.()).toBe("Orders");
    expect(label?.importedFrom?.()).toBe("./titles");
    expect(label?.source?.()).toBe("text of TITLE");
    expect(factValueOps("one", members()).evaluated?.()).toBeNull();
    expect(factValueOps("one", members()).importedFrom?.()).toBeNull();
  });

  it("gives nothing for a member the adapter does not read", () => {
    const bare = members("no member");

    expect(factValueOps("TITLE", bare).evaluated?.()).toBeNull();
    expect(functionText("factoryCall", bare)).toBeNull();
    expect(factValueOps("TITLE", bare).importedFrom?.()).toBeNull();
  });

  it("unpacks a spread of an object a name only comes to through a call that returns its argument", () => {
    const row = factValueOps("row", members());

    expect(row.entries("nothing").map((entry) => entry.key)).toEqual([
      "label",
      "own",
    ]);
    expect(row.property("label")?.evaluated?.()).toBe("Orders");
  });
});

/**
 * The facts for, in `/app/models.ts`:
 *
 *   const db = new Client();
 *   db.user.find();
 *   class Db extends Client {}
 *   const sub = new Db();
 *   sub.post.find();
 *   db.run((tx) => tx.order.find());
 *   db.run(handler);  // function handler(tx2) { tx2.item.find(); }
 *   db.run { |tx3| tx3.line.find }  // a Ruby block, with no paramOf row
 *   db.users.find  // Ruby's member read, a call with no arguments
 */
function models(
  over: Partial<FactSource> = {},
  more: readonly (readonly [string, ...string[]])[] = [],
): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  for (const [relation, ...row] of more) {
    add(relation, ...row);
  }
  const at = (name: string) => `/app/models.ts:${name}`;
  const callOn = (call: string, object: string, member: string) => {
    add("call", at(call), `${object}.${member}.find`);
    add(
      "readsProperty",
      `${object}.${member}.find`,
      `${object}.${member}`,
      "find",
    );
    add("readsProperty", `${object}.${member}`, object, member);
  };
  add("call", "new", "Client");
  add("writtenValue", "new");
  callOn("user", "db", "user");
  add("extends", "DbClass", "ClientBase");
  add("call", "newDb", "Db");
  add("writtenValue", "newDb");
  callOn("post", "sub", "post");
  add("call", "run", "db.run");
  add("readsProperty", "db.run", "db", "run");
  add("callArg", "run", "0", "arrow");
  add("func", "arrow");
  add("paramOf", "arrow", "0", "txParam");
  add("binds", "tx", "txParam");
  callOn("order", "tx", "order");
  add("call", "runByName", "db.run");
  add("callArg", "runByName", "0", "handlerRef");
  add("binds", "handlerRef", "handler");
  add("func", "handler");
  add("paramOf", "handler", "0", "tx2Param");
  add("binds", "tx2", "tx2Param");
  callOn("item", "tx2", "item");
  add("call", "runBlock", "db.run");
  add("callBlock", "runBlock", "block");
  add("func", "block");
  callOn("line", "block#tx3", "line");
  add("call", "users", "db.users");
  add("readsProperty", "db.users", "db", "users");
  add("call", at("rubyUsers"), "users.find");
  add("readsProperty", "users.find", "users", "find");
  return {
    db,
    read: () => undefined,
    writtenAs: (key) => ({ db: "new", sub: "newDb" })[key] ?? null,
    anchorCalls: () => [],
    importedFrom: (key, module) => key === "Client" && module === "kvcache",
    importedAs: (key, module) =>
      key === "ClientBase" && module === "kvcache" ? ["Client"] : [],
    shapeOf: () => null,
    textOf: (key) => key,
    literalOf: () => null,
    nameOf: () => null,
    argOf: (key) => ({ kind: "identifier", name: key }),
    comesTo: (key) => (key === "Db" ? ["DbClass"] : []),
    parameterOf: (key) =>
      key === "block#tx3" ? { func: "block", position: 0 } : null,
    ...over,
  };
}

const CLIENT = constructedFrom({ from: ["kvcache"], named: ["Client"] });

/** Whether the client one member read along from the call is from the origin. */
function memberFrom(call: string, origin: ReceiverOrigin, from = models()) {
  return (
    opsAt(`/app/models.ts:${call}`, from).member?.()?.receiverIsFrom(origin) ??
    false
  );
}

describe("the member a call is made on, over the facts", () => {
  it("gives ops for the member read, named after the member and asking about its object", () => {
    const find = opsAt("/app/models.ts:user", models());
    const member = find.member?.() ?? null;

    expect(member?.method()).toBe("user");
    expect(member?.calleeText()).toBe("db.user");
    expect(member?.argumentCount()).toBe(0);
    expect(member?.receiverIsFrom(CLIENT)).toBe(true);
    expect(find.receiverIsFrom(CLIENT)).toBe(false);
  });

  it("gives a call with no arguments as the member, the way Ruby writes one", () => {
    const member =
      opsAt("/app/models.ts:rubyUsers", models()).member?.() ?? null;

    expect(member?.method()).toBe("users");
    expect(member?.receiverIsFrom(CLIENT)).toBe(true);
  });

  it("gives nothing for a call made on a name", () => {
    expect(opsAt("run", models()).member?.()).toBeNull();
    expect(opsAt("new", models()).member?.()).toBeNull();
  });

  it("says which file the call is in, off its key", () => {
    expect(opsAt("/app/models.ts:user", models()).file?.()).toBe(
      "/app/models.ts",
    );
  });
});

describe("a receiver of a class that reaches a library base, over the facts", () => {
  const BASE = inherits({ from: ["kvcache"], named: ["Client"] });

  it("reads the class the receiver was made from, up to the base it extends", () => {
    expect(memberFrom("post", BASE)).toBe(true);
    expect(memberFrom("user", BASE)).toBe(false);
    expect(
      memberFrom("post", inherits({ from: ["kvcache"], named: ["Other"] })),
    ).toBe(false);
  });

  it("reads the class the facts say the receiver is one of", () => {
    const said = models({}, [["instanceOf", "tx", "DbClass"]]);

    expect(memberFrom("order", BASE, said)).toBe(true);
    expect(memberFrom("order", BASE)).toBe(false);
  });

  it("gives up on a project base that leads back to the class it started from", () => {
    const looped = models({
      importedAs: () => [],
      comesTo: (key) =>
        key === "Db" || key === "ClientBase" ? ["DbClass"] : [],
    });

    expect(memberFrom("post", BASE, looped)).toBe(false);
  });

  it("reads nothing for a call that is made on no member read", () => {
    const made = opsAt("new", models());

    expect(made.receiverIsFrom(BASE)).toBe(false);
    expect(made.receiverIsFrom(handedBy("run", CLIENT, { parameter: 0 }))).toBe(
      false,
    );
  });

  it("asks the adapter instead, where it reads declared types", () => {
    const asked: string[] = [];
    const typedSource = models({
      typedInherits: (call, spec) => {
        asked.push(call);
        return spec.named.includes("Client");
      },
    });

    expect(memberFrom("user", BASE, typedSource)).toBe(true);
    expect(asked).toEqual(["db.user"]);
  });
});

describe("the receiver a library method hands its callback, over the facts", () => {
  const HANDED = handedBy("run", CLIENT, { parameter: 0 });

  it("reads a callback written at the call", () => {
    expect(memberFrom("order", HANDED)).toBe(true);
  });

  it("reads a callback passed by the name bound to it", () => {
    expect(memberFrom("item", HANDED)).toBe(true);
  });

  it("reads a Ruby block through the adapter's read of its variables", () => {
    expect(memberFrom("line", HANDED)).toBe(true);
  });

  it("reads nothing for another method, another parameter, or a client from elsewhere", () => {
    expect(
      memberFrom("order", handedBy("transaction", CLIENT, { parameter: 0 })),
    ).toBe(false);
    expect(memberFrom("order", handedBy("run", CLIENT, { parameter: 1 }))).toBe(
      false,
    );
    expect(
      memberFrom(
        "order",
        handedBy("run", constructedFrom("other"), { parameter: 0 }),
      ),
    ).toBe(false);
    expect(memberFrom("user", HANDED)).toBe(false);
  });

  it("asks the same of the call itself", () => {
    const tx = opsAt("/app/models.ts:order", models()).member?.() ?? null;

    expect(tx?.isFrom(HANDED)).toBe(true);
    expect(tx?.isFrom(inherits({ from: ["kvcache"], named: ["Client"] }))).toBe(
      false,
    );
  });
});

/**
 * The facts for, in source order:
 *
 *   records.update(t).set(v).where(and(
 *     eq(t.id, x), t.a.gt(1), `${t.b}`, flag ? t.c : t.d, t.e ?? 0,
 *     [t.f], { k: t.g }, t.h == y, other.i, (r) => t.j, helper(), eq(t.id, 2),
 *   ));
 *   const kept = eq(t.k, x);
 *   records.delete(t).where(kept);
 */
function builder(
  over: Partial<FactSource> = {},
  more: readonly (readonly string[])[] = [],
): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  const read = (key: string, object: string, name: string) =>
    add("readsProperty", key, object, name);
  const call = (key: string, callee: string, ...args: string[]) => {
    add("call", key, callee);
    args.forEach((arg, at) => add("callArg", key, String(at), arg));
  };
  call("update", "records.update", "t");
  read("records.update", "records", "update");
  call("set", "update.set", "v");
  read("update.set", "update", "set");
  call("where", "set.where", "cond");
  read("set.where", "set", "where");
  call(
    "cond",
    "and",
    "eq1",
    "gt",
    "tpl",
    "ternary",
    "fallback",
    "list",
    "obj",
    "cmp",
    "other.i",
    "arrow",
    "helper()",
    "eq2",
  );
  call("eq1", "eq", "t.id", "x");
  read("t.id", "t", "id");
  call("gt", "t.a.gt", "one");
  read("t.a.gt", "t.a", "gt");
  read("t.a", "t", "a");
  add("holeAt", "tpl", "0", "t.b");
  read("t.b", "t", "b");
  add("conditionalBranch", "ternary", "t.c");
  add("conditionalBranch", "ternary", "t.d");
  read("t.c", "t", "c");
  read("t.d", "t", "d");
  add("fallbackBranch", "fallback", "t.e");
  add("fallbackBranch", "fallback", "zero");
  read("t.e", "t", "e");
  add("writtenEntryAt", "list", "0", "t.f", "value");
  read("t.f", "t", "f");
  add("writtenEntryAt", "obj", "0", "t.g", "value");
  read("t.g", "t", "g");
  add("compares", "cmp", "t.h", "y");
  read("t.h", "t", "h");
  read("other.i", "other", "i");
  add("func", "arrow");
  add("returnsValue", "arrow", "t.j");
  read("t.j", "t", "j");
  call("helper()", "helper");
  call("eq2", "eq", "t.id2", "two", "t.l");
  read("t.id2", "t", "id");
  read("t.l", "t", ".l");
  call("kept", "eq", "t.k", "x");
  read("t.k", "t", "k");
  call("delete", "records.delete", "t");
  read("records.delete", "records", "delete");
  call("whereKept", "delete.where", "keptName");
  read("delete.where", "delete", "where");
  for (const [relation = "", ...row] of more) {
    add(relation, ...row);
  }
  return {
    db,
    read: () => undefined,
    writtenAs: (key) => (key === "keptName" ? "kept" : null),
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: () => [],
    shapeOf: () => null,
    textOf: (key) => key,
    literalOf: () => null,
    nameOf: () => null,
    argOf: (key) => ({ kind: "identifier", name: key }),
    ...over,
  };
}

describe("the calls chained on a result, over the facts", () => {
  it("gives the call whose callee reads a method off this one's result, one hop at a time", () => {
    const set = opsAt("update", builder()).chainedOn?.() ?? null;

    expect(set?.method()).toBe("set");
    expect(set?.chainedOn?.()?.method()).toBe("where");
    expect(set?.chainedOn?.()?.chainedOn?.()).toBeNull();
  });
});

describe("the columns a condition reads, over the facts", () => {
  /** What the `where` call's condition reads off the table the first call took. */
  function columns(first: string, where: string, from = builder()) {
    const table = opsAt(first, from).valueAt(0);
    const condition = opsAt(where, from).valueAt(0);
    return table === null ? null : (condition?.readsOff?.(table) ?? null);
  }

  it("reads them through calls, a method on a column, holes, branches, entries and comparisons, each once", () => {
    expect(columns("update", "where")).toEqual([
      "id",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      ".l",
    ]);
  });

  it("reads a keyword argument and a block the way it reads a positional one", () => {
    // Python passes `eq(t.id, two, t.l, key=t.m)`, and Ruby a block, `{ t.n }`.
    const from = builder({}, [
      ["callKeywordArg", "eq2", "key", "t.m"],
      ["readsProperty", "t.m", "t", "m"],
      ["callBlock", "eq2", "t.n"],
      ["readsProperty", "t.n", "t", "n"],
    ]);

    expect(columns("update", "where", from)).toEqual([
      "id",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      ".l",
      "m",
      "n",
    ]);
  });

  it("goes into no function written in the condition, no helper and no name it was kept in", () => {
    expect(columns("delete", "whereKept")).toEqual([]);
  });

  it("reads a class's own spelling back as the column, and leaves out one the adapter drops", () => {
    const spelled = builder({
      memberName: (stated) =>
        stated === "h" ? null : stated.replace(/^\./, ""),
    });

    expect(columns("update", "where", spelled)).toEqual([
      "id",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "l",
    ]);
  });

  /**
   * The builder's facts, with two more columns in the condition: `z` off
   * `alias`, and `q` off another name spelled `t` that is not the table.
   */
  function withAliases(settledTo: Record<string, string>): FactSource {
    return builder(
      {
        writtenAs: (key) => settledTo[key] ?? null,
        textOf: (key) => (key === "t#inner" ? "t" : key),
      },
      [
        ["readsProperty", "alias.z", "alias", "z"],
        ["callArg", "eq2", "4", "alias.z"],
        ["readsProperty", "inner.q", "t#inner", "q"],
        ["callArg", "eq2", "5", "inner.q"],
      ],
    );
  }

  const SPELLED_T = ["id", "a", "b", "c", "d", "e", "f", "g", "h", ".l"];

  it("reads off a name that settles to what the table settles to, and not off one spelled the same that settles elsewhere", () => {
    const from = withAliases({
      t: "tableCall",
      alias: "tableCall",
      "t#inner": "otherCall",
    });

    expect(columns("update", "where", from)).toEqual([...SPELLED_T, "z"]);
  });

  it("reads off a spelling only where neither side settles", () => {
    const from = withAliases({ "t#inner": "otherCall" });

    expect(columns("update", "where", from)).toEqual(SPELLED_T);
  });

  it("reads nothing off an object that cannot say how it was written", () => {
    const condition = opsAt("where", builder()).valueAt(0);
    const unspelled: ValueOps = {
      text: () => null,
      name: () => null,
      flag: () => null,
      entries: () => [],
      items: () => [],
      property: () => null,
      asArg: () => null,
      parts: () => null,
      holes: () => [],
    };

    expect(condition?.readsOff?.(unspelled)).toEqual([]);
  });
});
