import { describe, expect, it } from "vitest";

import { enumerateStructuredPaths } from "@suss/extractor";

import { field } from "../ast.js";
import { parsePython } from "../parser.js";
import { lowerPythonBody } from "./lowering.js";
import { operandsOf, predicateOf } from "./predicates.js";

import type { PyNode } from "../parser.js";

async function pathsFor(source: string) {
  const tree = await parsePython(source);
  const fn = tree.rootNode.namedChildren[0] as PyNode;
  const body = field(fn, "body");
  const returns: PyNode[] = [];
  const walk = (n: PyNode) => {
    for (const c of n.namedChildren) {
      if (c === null) {
        continue;
      }
      if (c.type === "function_definition" || c.type === "lambda") {
        continue;
      }
      if (c.type === "return_statement") {
        returns.push(c);
      }
      walk(c);
    }
  };
  walk(body as PyNode);
  const lowered = lowerPythonBody(body, returns);
  const result = enumerateStructuredPaths({
    statements: lowered.statements,
    terminalsByStmt: lowered.terminalsByStmt,
  });
  return { returns, result };
}

describe("python lowering feeds the shared path engine", () => {
  it("gives each return of an if/else its own condition set", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get(self):",
        "    if not found:",
        '        return {"error": "nope"}, 404',
        '    return {"a": 1}, 200',
      ].join("\n"),
    );
    expect(returns).toHaveLength(2);
    const early = result.byTerminal.get(returns[0] as PyNode);
    const late = result.byTerminal.get(returns[1] as PyNode);
    expect(early?.[0]?.map((c) => [c.sourceText, c.polarity])).toEqual([
      ["not found", "positive"],
    ]);
    expect(late?.[0]?.map((c) => [c.sourceText, c.polarity])).toEqual([
      ["not found", "negative"],
    ]);
  });

  it("walks an elif chain as nested else arms", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get(self):",
        "    if a:",
        "        return 1",
        "    elif b:",
        "        return 2",
        "    return 3",
      ].join("\n"),
    );
    expect(
      result.byTerminal
        .get(returns[2] as PyNode)?.[0]
        ?.map((c) => [c.sourceText, c.polarity]),
    ).toEqual([
      ["a", "negative"],
      ["b", "negative"],
    ]);
  });
  it("lowers a while loop, so a return inside it is gated on the loop running", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get(self):",
        "    while more:",
        "        return 1",
        "    return 2",
      ].join("\n"),
    );
    expect(
      result.byTerminal.get(returns[0] as PyNode)?.[0]?.length,
    ).toBeGreaterThan(0);
    expect(result.byTerminal.has(returns[1] as PyNode)).toBe(true);
  });

  it("lowers a for loop the same way", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get(self):",
        "    for item in items:",
        "        return 1",
        "    return 2",
      ].join("\n"),
    );
    expect(result.byTerminal.has(returns[0] as PyNode)).toBe(true);
    expect(result.byTerminal.has(returns[1] as PyNode)).toBe(true);
  });

  it("lowers try, except and finally, and reaches a return in each", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get(self):",
        "    try:",
        "        return 1",
        "    except ValueError:",
        "        return 2",
        "    finally:",
        "        cleanup()",
      ].join("\n"),
    );
    expect(returns).toHaveLength(2);
    expect(result.byTerminal.has(returns[0] as PyNode)).toBe(true);
    expect(result.byTerminal.has(returns[1] as PyNode)).toBe(true);
  });

  it("runs one case and never the next, with the subject in each case's condition", async () => {
    const { returns, result } = await pathsFor(
      [
        "def send_it(verb):",
        "    match verb:",
        '        case "get":',
        "            log_read()",
        '        case "put" | "patch":',
        "            log_write()",
        "        case other:",
        "            log_other(other)",
        "    return 1",
      ].join("\n"),
    );
    expect(
      result.byTerminal
        .get(returns[0] as PyNode)
        ?.map((path) => path.map((c) => [c.sourceText, c.polarity])),
    ).toEqual([
      [['verb == "get"', "positive"]],
      [['verb == "put" or verb == "patch"', "positive"]],
      [
        ['verb == "get"', "negative"],
        ['verb == "put" or verb == "patch"', "negative"],
      ],
    ]);
  });

  it("reads each case's condition as the subject compared with its pattern", async () => {
    const { returns, result } = await pathsFor(
      [
        "def read_reply(reply, strict):",
        "    match reply.status:",
        "        case 200:",
        "            return 1",
        '        case "gone" | "lost":',
        "            return 2",
        "        case None:",
        "            return 3",
        "        case Reply(code=500) if strict:",
        "            return 4",
        "        case code if code > 400:",
        "            return 5",
      ].join("\n"),
    );
    const read = returns.map((one) => {
      const condition = result.byTerminal.get(one)?.[0]?.[0];
      return [
        condition?.sourceText,
        condition?.expression === null || condition?.expression === undefined
          ? null
          : predicateOf(condition.expression),
      ];
    });
    const status = {
      type: "dependency",
      name: "reply",
      accessChain: ["status"],
    };
    const statusIs = (value: string | number) => ({
      type: "comparison",
      left: status,
      op: "eq",
      right: { type: "literal", value },
    });
    expect(read).toEqual([
      ["reply.status == 200", statusIs(200)],
      [
        'reply.status == "gone" or reply.status == "lost"',
        {
          type: "compound",
          op: "or",
          operands: [statusIs("gone"), statusIs("lost")],
        },
      ],
      [
        "reply.status is None",
        { type: "nullCheck", subject: status, negated: false },
      ],
      [
        "reply.status matches Reply(code=500) and strict",
        {
          type: "compound",
          op: "and",
          operands: [
            {
              type: "opaque",
              sourceText: "reply.status matches Reply(code=500)",
              reason: "complexExpression",
            },
            {
              type: "truthinessCheck",
              subject: { type: "unresolved", sourceText: "strict" },
              negated: false,
            },
          ],
        },
      ],
      [
        "code > 400",
        {
          type: "comparison",
          left: { type: "unresolved", sourceText: "code" },
          op: "gt",
          right: { type: "literal", value: 400 },
        },
      ],
    ]);
  });

  it("compares a named value or a bound literal, and quotes a sequence or a signed number", async () => {
    const { returns, result } = await pathsFor(
      [
        "def read_reply(reply, kind, strict):",
        "    match reply:",
        "        case Status.GONE:",
        "            return 1",
        '        case "lost" as why:',
        "            return 2",
        "        case -1:",
        "            return 3",
        "    match reply, kind:",
        "        case 1, 2:",
        "            return 4",
        "        case (code, _) if strict:",
        "            return 5",
      ].join("\n"),
    );
    const read = returns.map((one) => {
      const condition = result.byTerminal.get(one)?.[0]?.at(-1);
      const expression = condition?.expression;
      return [
        condition?.sourceText,
        expression === null || expression === undefined
          ? []
          : operandsOf(expression).map((node) => node.text),
      ];
    });
    expect(read).toEqual([
      ["reply == Status.GONE", ["reply"]],
      ['reply == "lost"', ["reply"]],
      ["reply matches -1", []],
      ["reply, kind matches 1, 2", []],
      ["reply, kind matches (code, _) and strict", ["strict"]],
    ]);
  });

  it("lowers match and case, with the wildcard case as the default group", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get(self):",
        "    match kind:",
        "        case 1:",
        "            return 1",
        "        case _:",
        "            return 2",
      ].join("\n"),
    );
    expect(returns).toHaveLength(2);
    expect(result.byTerminal.has(returns[0] as PyNode)).toBe(true);
    expect(result.byTerminal.has(returns[1] as PyNode)).toBe(true);
  });

  it("leaves a nested function's return to that function", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get(self):",
        "    def helper():",
        "        return 99",
        "    return 1",
      ].join("\n"),
    );
    expect(returns).toHaveLength(1);
    expect(result.byTerminal.has(returns[0] as PyNode)).toBe(true);
  });

  it("reads a raise as a throw rather than a return", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get(self):",
        "    if bad:",
        "        raise ValueError()",
        "    return 1",
      ].join("\n"),
    );
    expect(
      result.byTerminal.get(returns[0] as PyNode)?.[0]?.map((c) => c.polarity),
    ).toEqual(["negative"]);
  });

  it("keeps a break and a continue out of the terminal set", async () => {
    const { returns, result } = await pathsFor(
      [
        "def get(self):",
        "    for item in items:",
        "        if item:",
        "            continue",
        "        break",
        "    return 1",
      ].join("\n"),
    );
    expect(returns).toHaveLength(1);
    expect(result.byTerminal.has(returns[0] as PyNode)).toBe(true);
  });
});
