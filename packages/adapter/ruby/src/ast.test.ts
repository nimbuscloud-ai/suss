import { describe, expect, it } from "vitest";

import {
  bodyStatements,
  booleanLiteralValue,
  field,
  hashKeySymbolName,
  instanceMethodsByName,
  instanceMethodVisibility,
  isType,
  methodHasStatements,
  rangeOf,
  readCallArgs,
  runStatements,
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

  it("answers a line number, not tree-sitter's byte offset, for a declaration far down the file", async () => {
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

describe("runStatements", () => {
  /** The receiverless calls a body runs, which is what every DSL reader is after. */
  async function bareCallsIn(
    source: string,
    blockConfigures?: (call: RbNode) => boolean,
  ): Promise<string[]> {
    const tree = await parseRuby(source);
    return runStatements(tree.rootNode, blockConfigures)
      .filter(
        (node) => node.type === "call" && field(node, "receiver") === null,
      )
      .map((node) => must(field(node, "method")).text);
  }

  it("reaches a call inside an if, a block, a begin and a modifier if", async () => {
    expect(
      await bareCallsIn(
        "if flag\n  in_if :a\nend\n" +
          "[1].each { |n| in_block :b }\n" +
          "begin\n  in_begin :c\nrescue StandardError\n  in_rescue :d\nend\n" +
          "in_modifier :e if flag\n",
      ),
    ).toEqual(["in_if", "in_block", "in_begin", "in_rescue", "in_modifier"]);
  });

  it("stops at a body that belongs to what it declares", async () => {
    expect(
      await bareCallsIn(
        "def helper\n  in_method :a\nend\n" +
          "class Thing\n  in_class :b\nend\n" +
          "module Mod\n  in_module :c\nend\n",
      ),
    ).toEqual([]);
  });

  it("reads what a call is handed as values rather than as statements", async () => {
    expect(await bareCallsIn("outer(inner(1))\n")).toEqual(["outer"]);
  });

  it("leaves the block of a configuring call to that call", async () => {
    const source = "field :name do\n  argument :locale\nend\n";
    expect(await bareCallsIn(source)).toEqual(["field", "argument"]);
    expect(
      await bareCallsIn(
        source,
        (call) => field(call, "method")?.text === "field",
      ),
    ).toEqual(["field"]);
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

describe("instanceMethodVisibility", () => {
  it("leaves every method public when nothing narrows it", async () => {
    const body = await classBody(
      "class C\n  def a\n  end\n\n  def b\n  end\nend\n",
    );
    expect(instanceMethodVisibility(body).size).toBe(0);
  });

  it("marks everything after a bare private keyword, leaving what came before public", async () => {
    const body = await classBody(
      "class C\n  def a\n  end\n\n  private\n\n  def b\n  end\nend\n",
    );
    const visibility = instanceMethodVisibility(body);
    expect(visibility.get("a")).toBeUndefined();
    expect(visibility.get("b")).toBe("private");
  });

  it("marks a def wrapped in private def ... end alone, without narrowing what follows", async () => {
    const body = await classBody(
      "class C\n  private def a\n  end\n\n  def b\n  end\nend\n",
    );
    const visibility = instanceMethodVisibility(body);
    expect(visibility.get("a")).toBe("private");
    expect(visibility.get("b")).toBeUndefined();
  });

  it("marks methods already defined through private :a, :b", async () => {
    const body = await classBody(
      "class C\n  def a\n  end\n\n  def b\n  end\n\n  private :a, :b\nend\n",
    );
    const visibility = instanceMethodVisibility(body);
    expect(visibility.get("a")).toBe("private");
    expect(visibility.get("b")).toBe("private");
  });

  it("reads protected the same way as private, in all three spellings", async () => {
    const body = await classBody(
      "class C\n" +
        "  protected def a\n  end\n\n" +
        "  def b\n  end\n\n" +
        "  protected :b\n\n" +
        "  protected\n\n" +
        "  def c\n  end\nend\n",
    );
    const visibility = instanceMethodVisibility(body);
    expect(visibility.get("a")).toBe("protected");
    expect(visibility.get("b")).toBe("protected");
    expect(visibility.get("c")).toBe("protected");
  });

  it("returns to public after a bare public keyword", async () => {
    const body = await classBody(
      "class C\n  private\n\n  def a\n  end\n\n  public\n\n  def b\n  end\nend\n",
    );
    const visibility = instanceMethodVisibility(body);
    expect(visibility.get("a")).toBe("private");
    expect(visibility.get("b")).toBeUndefined();
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
