import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { type FactSource, factCallOps, factValueOps } from "./factOps.js";
import { anyOf, constructedFrom, declaredBy, returnedBy } from "./ops.js";

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
    nameOf: (key, unsettled) => (unsettled === "reference" ? `{${key}}` : null),
    computedKeyOf: (held) => (held === "yes" ? "orders" : null),
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
