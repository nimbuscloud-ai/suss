import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { type FactSource, factCallOps, factValueOps } from "./factOps.js";
import {
  anyOf,
  constructedFrom,
  declaredBy,
  imported,
  returnedBy,
  typed,
} from "./ops.js";

import type { ValueOps } from "@suss/extractor";

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
        return origin.named.includes("Dispatcher");
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
 * The facts for, in source order, with `L` imported as ledger's `Ledger`:
 *
 *   const book = new L();
 *   book.append("entry");
 */
function aliased(): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("call", "made", "L");
  add("writtenValue", "made");
  add("call", "append", "book.append");
  add("readsProperty", "book.append", "book", "append");
  const imports: Record<string, readonly string[]> = {
    L: ["Ledger"],
    ns: ["*"],
  };
  return {
    db,
    read: () => undefined,
    writtenAs: (key) => (key === "book" ? "made" : null),
    anchorCalls: () => [],
    importedFrom: (key, module) => key === "L" && module === "ledger",
    importedAs: (key, module) =>
      module === "ledger" ? (imports[key] ?? []) : [],
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
