import { describe, expect, it } from "vitest";

import { enumerateStructuredPaths } from "@suss/extractor";

import { field } from "../ast.js";
import { parseRuby } from "../parser.js";
import { lowerRubyBody } from "./lowering.js";
import { operandsOf, predicateOf } from "./predicates.js";

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

/** The calls to these methods written as statements of their own, each standing in as a terminal. */
async function callPathsFor(source: string, names: readonly string[]) {
  const tree = await parseRuby(source);
  const method = tree.rootNode.namedChildren[0] as RbNode;
  const body = field(method, "body");
  const calls: RbNode[] = [];
  const walk = (node: RbNode) => {
    for (const child of node.namedChildren) {
      if (child === null) {
        continue;
      }
      if (child.type === "identifier" && names.includes(child.text)) {
        calls.push(child);
      }
      walk(child);
    }
  };
  walk(body as RbNode);
  const lowered = lowerRubyBody(body, calls);
  const result = enumerateStructuredPaths({
    statements: lowered.statements,
    terminalsByStmt: lowered.terminalsByStmt,
  });
  return { calls, result };
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

  it("runs one when arm and never the next, so the arms rejoin before the return after the case", async () => {
    const { returns, result } = await pathsFor(
      [
        "def send_it(verb)",
        "  case verb",
        "  when :get",
        "    log_read",
        "  when :put, :patch",
        "    log_write",
        "  else",
        "    log_other",
        "  end",
        "  return 1",
        "end",
      ].join("\n"),
    );
    expect(
      result.byTerminal
        .get(returns[0] as RbNode)
        ?.map((path) => path.map((c) => [c.sourceText, c.polarity])),
    ).toEqual([[]]);
  });

  it("reads each arm's condition as the subject compared with its patterns", async () => {
    const { returns, result } = await pathsFor(
      [
        "def send_it(verb)",
        "  case verb",
        "  when :get then return 1",
        "  when :put, :patch then return 2",
        "  when Integer then return 3",
        "  end",
        "end",
      ].join("\n"),
    );
    const [get, write, number] = returns.map((one) => {
      const expression = result.byTerminal.get(one)?.[0]?.[0]?.expression;
      return expression === null || expression === undefined
        ? null
        : predicateOf(expression);
    });
    const verbIs = (symbol: string) => ({
      type: "comparison",
      left: { type: "unresolved", sourceText: "verb" },
      op: "eq",
      right: { type: "unresolved", sourceText: symbol },
    });
    expect(get).toEqual(verbIs(":get"));
    expect(write).toEqual({
      type: "compound",
      op: "or",
      operands: [verbIs(":put"), verbIs(":patch")],
    });
    expect(number).toEqual({
      type: "opaque",
      sourceText: "Integer === verb",
      reason: "complexExpression",
    });
  });

  it("reads a case with no subject as an elsif chain on each arm's own test", async () => {
    const { returns, result } = await pathsFor(
      [
        "def size_of(n)",
        "  case",
        "  when n > 10",
        "    return :big",
        "  when n > 1, n < -1",
        "    return :medium",
        "  end",
        "  return :small",
        "end",
      ].join("\n"),
    );
    const conditions = (at: number) =>
      result.byTerminal
        .get(returns[at] as RbNode)
        ?.map((path) => path.map((c) => [c.sourceText, c.polarity]));
    expect(conditions(1)).toEqual([
      [
        ["n > 10", "negative"],
        ["n > 1 || n < -1", "positive"],
      ],
    ]);
    expect(conditions(2)).toEqual([
      [
        ["n > 10", "negative"],
        ["n > 1 || n < -1", "negative"],
      ],
    ]);
    const medium = result.byTerminal.get(returns[1] as RbNode)?.[0]?.[1];
    expect(
      medium?.expression === null || medium?.expression === undefined
        ? null
        : predicateOf(medium.expression).type,
    ).toBe("compound");
  });

  it("reads the arms of a case written as the value an assignment stores", async () => {
    const { calls, result } = await callPathsFor(
      [
        "def send_it(verb)",
        "  response = case verb",
        "  when :get then fetch_one",
        "  when :post then create_one",
        "  end",
        "  response",
        "end",
      ].join("\n"),
      ["fetch_one", "create_one"],
    );
    expect(
      calls.map((call) =>
        result.byTerminal
          .get(call)
          ?.map((path) => path.map((c) => [c.sourceText, c.polarity])),
      ),
    ).toEqual([
      [[["verb == :get", "positive"]]],
      [[["verb == :post", "positive"]]],
    ]);
  });

  it("reads an if written as the value of an assignment, even one assigned on again", async () => {
    const { calls, result } = await callPathsFor(
      [
        "def pick(ok)",
        "  first = second = if ok then fetch_one else fetch_two end",
        "  @cached ||= case ok when true then fetch_three end",
        "end",
      ].join("\n"),
      ["fetch_one", "fetch_two", "fetch_three"],
    );
    expect(
      calls.map((call) =>
        result.byTerminal
          .get(call)
          ?.map((path) => path.map((c) => [c.sourceText, c.polarity])),
      ),
    ).toEqual([
      [[["ok", "positive"]]],
      [[["ok", "negative"]]],
      [[["ok == true", "positive"]]],
    ]);
  });

  it("reads an in arm as the pattern it matches, under its guard, and raises when none matches", async () => {
    const { returns, result } = await pathsFor(
      [
        "def read_reply(reply, strict)",
        "  case reply",
        "  in {status: 200} if strict",
        "    return 1",
        "  in :gone | :lost",
        "    return 2",
        "  end",
        "  return 3",
        "end",
      ].join("\n"),
    );
    expect(
      returns.map((one) =>
        result.byTerminal
          .get(one)
          ?.map((path) => path.map((c) => [c.sourceText, c.polarity])),
      ),
    ).toEqual([
      [[["reply in {status: 200} && strict", "positive"]]],
      [[["reply == :gone || reply == :lost", "positive"]]],
      undefined,
    ]);
  });

  it("reads a case with no subject exactly as the elsif chain it stands for", async () => {
    const read = async (branch: string[]) => {
      const { returns, result } = await pathsFor(
        [
          "def size_of(n, ready)",
          "  if ready",
          ...branch,
          "  end",
          "  return :done if n == 0",
          "  return :other",
          "end",
        ].join("\n"),
      );
      return returns.map((one) =>
        result.byTerminal
          .get(one)
          ?.map((path) =>
            path.map((c) => [c.sourceText, c.polarity, c.source]),
          ),
      );
    };
    const chained = await read([
      "    case",
      "    when n > 10 then log_big",
      "    when n < 0 then raise ArgumentError",
      "    else log_small",
      "    end",
    ]);
    expect(chained).toEqual(
      await read([
        "    if n > 10 then log_big",
        "    elsif n < 0 then raise ArgumentError",
        "    else log_small",
        "    end",
      ]),
    );
    expect(chained[1]?.[0]?.[0]).toEqual(["ready", "positive", "explicit"]);
  });

  it("joins an in arm's guard onto its patterns, an unless guard negated", async () => {
    const { returns, result } = await pathsFor(
      [
        "def read_reply(reply, strict)",
        "  case reply",
        "  in :gone | :lost unless strict",
        "    return 1",
        "  in Integer => code if code > 400",
        "    return 2",
        "  in other if strict",
        "    return 3",
        "  else",
        "    return 4",
        "  end",
        "end",
      ].join("\n"),
    );
    const arms = returns.slice(0, 3).map((one) => {
      const condition = result.byTerminal.get(one)?.[0]?.[0];
      const expression = condition?.expression;
      return [
        condition?.sourceText,
        expression === null || expression === undefined
          ? null
          : predicateOf(expression),
        expression === null || expression === undefined
          ? []
          : operandsOf(expression).map((node) => node.text),
      ];
    });
    const replyIs = (symbol: string) => ({
      type: "comparison",
      left: { type: "unresolved", sourceText: "reply" },
      op: "eq",
      right: { type: "unresolved", sourceText: symbol },
    });
    const strict = {
      type: "truthinessCheck",
      subject: { type: "unresolved", sourceText: "strict" },
      negated: false,
    };
    expect(arms).toEqual([
      [
        "(reply == :gone || reply == :lost) && !(strict)",
        {
          type: "compound",
          op: "and",
          operands: [
            {
              type: "compound",
              op: "or",
              operands: [replyIs(":gone"), replyIs(":lost")],
            },
            { type: "negation", operand: strict },
          ],
        },
        ["reply", ":gone", "reply", ":lost", "strict"],
      ],
      [
        "reply in Integer => code && code > 400",
        {
          type: "compound",
          op: "and",
          operands: [
            {
              type: "opaque",
              sourceText: "reply in Integer => code",
              reason: "complexExpression",
            },
            {
              type: "comparison",
              left: { type: "unresolved", sourceText: "code" },
              op: "gt",
              right: { type: "literal", value: 400 },
            },
          ],
        },
        ["code", "400"],
      ],
      ["strict", strict, ["strict"]],
    ]);
  });

  it("reads the values each when arm compares, for a reader asking where they came from", async () => {
    const { returns, result } = await pathsFor(
      [
        "def route(verb, n)",
        "  case verb",
        "  when :get then return 1",
        "  when Integer then return 2",
        "  end",
        "  case",
        "  when n > 1 then return 3",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(
      returns.map((one) => {
        const path = result.byTerminal.get(one)?.[0] ?? [];
        const expression = path[path.length - 1]?.expression;
        return expression === null || expression === undefined
          ? []
          : operandsOf(expression).map((node) => node.text);
      }),
    ).toEqual([["verb", ":get"], [], ["n", "1"]]);
  });

  it("reads an in arm that binds a bare name as the arm that matches anything else", async () => {
    const { returns, result } = await pathsFor(
      [
        "def read_reply(reply)",
        "  case reply",
        "  in :gone",
        "    return 1",
        "  in other",
        "    return 2",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(
      result.byTerminal
        .get(returns[1] as RbNode)
        ?.map((path) => path.map((c) => [c.sourceText, c.polarity])),
    ).toEqual([[["reply == :gone", "negative"]]]);
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

  it("lowers unless as an if with the arms the other way around", async () => {
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
    expect(
      result.byTerminal
        .get(returns[0] as RbNode)?.[0]
        ?.map((c) => [c.sourceText, c.polarity]),
    ).toEqual([["ok", "negative"]]);
    expect(
      result.byTerminal
        .get(returns[1] as RbNode)?.[0]
        ?.map((c) => [c.sourceText, c.polarity]),
    ).toEqual([["ok", "positive"]]);
  });

  it("gates a statement an if modifier guards on the test as written", async () => {
    const { returns, result } = await pathsFor(
      ["def get", "  return 400 if missing", "  return 200", "end"].join("\n"),
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

  it("gates a statement an unless modifier guards on the other side of the test", async () => {
    const { returns, result } = await pathsFor(
      ["def get", "  return 400 unless ok", "  return 200", "end"].join("\n"),
    );
    expect(returns).toHaveLength(2);
    expect(
      result.byTerminal
        .get(returns[0] as RbNode)?.[0]
        ?.map((c) => [c.sourceText, c.polarity]),
    ).toEqual([["ok", "negative"]]);
    expect(
      result.byTerminal
        .get(returns[1] as RbNode)?.[0]
        ?.map((c) => [c.sourceText, c.polarity]),
    ).toEqual([["ok", "positive"]]);
  });
});
