import { describe, expect, it } from "vitest";

import {
  bodyStatements,
  booleanLiteralValue,
  field,
  hashKeySymbolName,
  instanceMethodsByName,
  isType,
  methodHasStatements,
  rangeOf,
  readCallArgs,
  symbolValue,
} from "./ast.js";
import { parseRuby } from "./parser.js";

import type { RbNode } from "./parser.js";

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected a value, got null/undefined");
  }
  return value;
}

async function firstCall(source: string): Promise<RbNode> {
  const tree = await parseRuby(source);
  const stmt = bodyStatements(tree.rootNode)[0];
  if (stmt === undefined || stmt.type !== "call") {
    throw new Error(
      `expected the first statement to be a call, got ${stmt?.type}`,
    );
  }
  return stmt;
}

describe("rangeOf", () => {
  it("counts lines from one, the way the rest of the IR does", async () => {
    const call = await firstCall("field :id, ID, null: false\n");
    expect(rangeOf(call)).toEqual({ start: 1, end: 1 });
  });

  it("stays inside the file for a declaration far down it", async () => {
    // tree-sitter counts bytes. Handing the byte offset back put
    // `line 348` on a 12-line file, because `suss inspect` reads this
    // as a line number and every other adapter fills it with one.
    const call = await firstCall(
      `${"\n".repeat(20)}field :id, ID, null: false\n`,
    );
    expect(rangeOf(call).start).toBe(21);
  });
});

describe("isType", () => {
  it("matches when the node's type is one of the given names", async () => {
    const call = await firstCall("field :id, ID, null: false\n");
    expect(isType(call, "call")).toBe(true);
    expect(isType(call, "class", "module")).toBe(false);
  });
});

describe("bodyStatements", () => {
  it("returns each direct statement, skipping absent slots", async () => {
    const tree = await parseRuby("field :id, ID\nfield :name, String\n");
    expect(bodyStatements(tree.rootNode).map((n) => n.type)).toEqual([
      "call",
      "call",
    ]);
  });
});

describe("symbolValue", () => {
  it("strips the leading colon from a simple_symbol", async () => {
    const call = await firstCall("field :campaign_id\n");
    const symbolNode = must(field(call, "arguments")).namedChild(0);
    expect(symbolValue(must(symbolNode))).toBe("campaign_id");
  });

  it("is null for anything but a simple_symbol", async () => {
    const call = await firstCall("field String\n");
    const node = must(field(call, "arguments")).namedChild(0);
    expect(symbolValue(must(node))).toBeNull();
  });
});

describe("hashKeySymbolName", () => {
  it("reads a pair's key with no leading colon", async () => {
    const call = await firstCall("field :id, ID, null: false\n");
    const args = must(field(call, "arguments"));
    const pair = must(args.namedChildren.find((n) => n?.type === "pair"));
    const key = must(field(pair, "key"));
    expect(hashKeySymbolName(key)).toBe("null");
  });
});

describe("booleanLiteralValue", () => {
  it("reads true and false literals", async () => {
    const call = await firstCall("field :id, ID, null: false\n");
    const args = must(field(call, "arguments"));
    const pair = must(args.namedChildren.find((n) => n?.type === "pair"));
    const value = must(field(pair, "value"));
    expect(booleanLiteralValue(value)).toBe(false);
  });

  it("is null for anything else", async () => {
    const call = await firstCall("field :id, ID\n");
    const node = must(field(call, "arguments")).namedChild(1);
    expect(booleanLiteralValue(must(node))).toBeNull();
  });
});

describe("readCallArgs", () => {
  it("splits positional arguments from pair keyword arguments", async () => {
    const call = await firstCall(
      "field :campaign, Types::CampaignType, null: true\n",
    );
    const { positional, keyword } = readCallArgs(field(call, "arguments"));
    expect(positional.map((n) => n.text)).toEqual([
      ":campaign",
      "Types::CampaignType",
    ]);
    expect(Object.keys(keyword)).toEqual(["null"]);
    expect(keyword.null?.type).toBe("true");
  });

  it("returns empty results for a null argument list", () => {
    expect(readCallArgs(null)).toEqual({ positional: [], keyword: {} });
  });
});

async function classBody(source: string): Promise<RbNode> {
  const tree = await parseRuby(source);
  const klass = must(bodyStatements(tree.rootNode)[0]);
  return must(field(klass, "body"));
}

describe("instanceMethodsByName", () => {
  it("keys every instance method by the name it is defined under", async () => {
    const body = await classBody(
      "class C\n  def one\n  end\n\n  def two\n  end\nend\n",
    );
    expect([...instanceMethodsByName(body).keys()]).toEqual(["one", "two"]);
  });

  it("keeps the later of two definitions of the same name", async () => {
    const body = await classBody(
      "class C\n  def a\n    1\n  end\n\n  def a\n  end\nend\n",
    );
    const method = must(instanceMethodsByName(body).get("a"));
    expect(methodHasStatements(method)).toBe(false);
  });

  it("leaves out a method defined on the class rather than its instances", async () => {
    const body = await classBody("class C\n  def self.build\n  end\nend\n");
    expect([...instanceMethodsByName(body).keys()]).toEqual([]);
  });
});

describe("methodHasStatements", () => {
  it("is true for a method with work in it", async () => {
    const body = await classBody("class C\n  def a\n    b\n  end\nend\n");
    expect(
      methodHasStatements(must(instanceMethodsByName(body).get("a"))),
    ).toBe(true);
  });

  it("is true for an endless method, whose body is the expression itself", async () => {
    const body = await classBody("class C\n  def a = 1\nend\n");
    expect(
      methodHasStatements(must(instanceMethodsByName(body).get("a"))),
    ).toBe(true);
  });

  it("is false for a method with nothing in it", async () => {
    const body = await classBody("class C\n  def a\n  end\nend\n");
    expect(
      methodHasStatements(must(instanceMethodsByName(body).get("a"))),
    ).toBe(false);
  });
});
