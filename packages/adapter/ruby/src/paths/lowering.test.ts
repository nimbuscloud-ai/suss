import { describe, expect, it } from "vitest";

import { enumerateStructuredPaths } from "@suss/extractor";

import { field } from "../ast.js";
import { parseRuby } from "../parser.js";
import { lowerRubyBody } from "./lowering.js";

import type { RbNode } from "../parser.js";

const CAPTURES = new Set(["method", "lambda", "class", "module"]);

/** Every return written for this method, which is what the engine keys paths by. */
function returnsOf(body: RbNode): RbNode[] {
  const found: RbNode[] = [];
  const walk = (node: RbNode) => {
    for (const child of node.namedChildren) {
      if (child === null || CAPTURES.has(child.type)) {
        continue;
      }
      if (child.type === "return") {
        found.push(child);
      }
      walk(child);
    }
  };
  walk(body);
  return found;
}

async function pathsFor(source: string) {
  const tree = await parseRuby(source);
  const method = tree.rootNode.namedChildren[0] as RbNode;
  const body = field(method, "body");
  const returns = returnsOf(body as RbNode);
  const lowered = lowerRubyBody(body, returns);
  const result = enumerateStructuredPaths({
    statements: lowered.statements,
    terminalsByStmt: lowered.terminalsByStmt,
  });
  return { returns, result };
}

describe("ruby lowering feeds the shared path engine", () => {
  it("gives each return of an if/else its own condition set", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get",
        "  if missing",
        "    return 404",
        "  end",
        "  return 200",
        "end",
      ].join("\n"),
    );
    expect(returns).toHaveLength(2);
    expect(
      result.byTerminal
        .get(returns[0] as RbNode)?.[0]
        ?.map((c) => [c.sourceText, c.polarity]),
    ).toEqual([["missing", "positive"]]);
    expect(
      result.byTerminal
        .get(returns[1] as RbNode)?.[0]
        ?.map((c) => [c.sourceText, c.polarity]),
    ).toEqual([["missing", "negative"]]);
  });

  it("walks an elsif chain as nested else arms", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get",
        "  if a",
        "    return 1",
        "  elsif b",
        "    return 2",
        "  end",
        "  return 3",
        "end",
      ].join("\n"),
    );
    expect(
      result.byTerminal
        .get(returns[2] as RbNode)?.[0]
        ?.map((c) => [c.sourceText, c.polarity]),
    ).toEqual([
      ["a", "negative"],
      ["b", "negative"],
    ]);
  });

  it("keeps a return written in a do block, because it returns from the method", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get",
        "  items.each do |i|",
        "    return 1",
        "  end",
        "  return 2",
        "end",
      ].join("\n"),
    );
    expect(returns).toHaveLength(2);
    expect(result.byTerminal.has(returns[0] as RbNode)).toBe(true);
  });

  it("leaves a lambda's return to the lambda", async () => {
    const { returns } = await pathsFor(
      ["def get", "  g = -> { return 1 }", "  return 2", "end"].join("\n"),
    );
    expect(returns).toHaveLength(1);
  });

  it("reads raise as a throw even though it is an ordinary call", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get",
        "  if bad",
        "    raise ArgumentError",
        "  end",
        "  return 1",
        "end",
      ].join("\n"),
    );
    expect(
      result.byTerminal.get(returns[0] as RbNode)?.[0]?.map((c) => c.polarity),
    ).toEqual(["negative"]);
  });

  it("lowers begin, rescue and ensure, and reaches a return in each", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get",
        "  begin",
        "    return 1",
        "  rescue Err => e",
        "    return 2",
        "  ensure",
        "    cleanup",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(returns).toHaveLength(2);
    expect(result.byTerminal.has(returns[0] as RbNode)).toBe(true);
    expect(result.byTerminal.has(returns[1] as RbNode)).toBe(true);
  });

  it("lowers case and when, with else as the default group", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get",
        "  case kind",
        "  when 1",
        "    return 1",
        "  else",
        "    return 2",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(returns).toHaveLength(2);
    expect(result.byTerminal.has(returns[0] as RbNode)).toBe(true);
    expect(result.byTerminal.has(returns[1] as RbNode)).toBe(true);
  });

  it("lowers a while loop", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get",
        "  while more",
        "    return 1",
        "  end",
        "  return 2",
        "end",
      ].join("\n"),
    );
    expect(returns).toHaveLength(2);
    expect(result.byTerminal.has(returns[1] as RbNode)).toBe(true);
  });
  it("walks an explicit else arm", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get",
        "  if missing",
        "    return 404",
        "  else",
        "    return 200",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(returns).toHaveLength(2);
    expect(
      result.byTerminal
        .get(returns[1] as RbNode)?.[0]
        ?.map((c) => [c.sourceText, c.polarity]),
    ).toEqual([["missing", "negative"]]);
  });

  it("lowers unless the same way as if", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get",
        "  unless ok",
        "    return 400",
        "  end",
        "  return 200",
        "end",
      ].join("\n"),
    );
    expect(returns).toHaveLength(2);
    expect(result.byTerminal.has(returns[0] as RbNode)).toBe(true);
  });
});
