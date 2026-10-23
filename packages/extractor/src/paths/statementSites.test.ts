import { describe, expect, it } from "vitest";

import { statementSites } from "./statementSites.js";

import type { StructuredStatement } from "./structuredStatement.js";

/** A parse-tree node as a tree-sitter adapter sees it: a fresh object each read, the same id. */
interface Node {
  id: number;
  line: number;
}

const node = (id: number, line: number): Node => ({ id, line });

/**
 * A body of `try { if (a) { <first> } } finally { <cleanup> }`, with the
 * try on lines 4 to 9. Each statement is a terminal when the caller asks
 * about it.
 */
function lowerBody(first: Node, cleanup: Node) {
  return (statements: readonly Node[]) => {
    const asked = (id: number) => statements.filter((one) => one.id === id);
    const firstStatement: StructuredStatement<string> = {
      kind: "opaque",
      exitKind: null,
    };
    const cleanupStatement: StructuredStatement<string> = {
      kind: "opaque",
      exitKind: null,
    };
    const tried: StructuredStatement<string> = {
      kind: "try",
      tryBody: [
        {
          kind: "if",
          condition: { sourceText: "a", expression: "a" },
          thenBody: [firstStatement],
          elseBody: null,
          exitKind: null,
        },
      ],
      catchBody: null,
      finallyBody: [cleanupStatement],
      exitKind: null,
      lines: { start: 4, end: 9 },
    };
    return {
      statements: [tried],
      terminalsByStmt: new Map([
        [firstStatement, asked(first.id)],
        [cleanupStatement, asked(cleanup.id)],
      ]),
    };
  };
}

describe("statementSites", () => {
  const first = node(10, 5);
  const cleanup = node(30, 8);
  const statementOf = new Map<number, Node>([
    [1, first],
    [2, node(10, 5)],
    [3, cleanup],
  ]);
  const sites = statementSites(
    [node(1, 5), node(2, 5), node(3, 8), node(9, 2)],
    {
      statementOf: (one) => statementOf.get(one.id) ?? null,
      lower: lowerBody(first, cleanup),
      firstLine: (one) => one.line,
    },
  );

  it("asks about two calls in one statement through the same statement", () => {
    expect(sites.plainSiteOf(node(1, 5))).toEqual(
      sites.plainSiteOf(node(2, 5)),
    );
    expect(sites.plainSiteOf(node(2, 5)).preconditions).toMatchObject([
      { sourceText: "a", polarity: "positive" },
    ]);
  });

  it("places a node written outside every statement by its own line, under no guards", () => {
    expect(sites.plainSiteOf(node(9, 2))).toEqual({
      line: 2,
      preconditions: [],
      cleansUpFrom: undefined,
    });
  });

  it("places a call in a cleanup body by its try, and reads the rest of the body all the same", () => {
    expect(sites.plainSiteOf(node(3, 8))).toEqual({
      line: 8,
      preconditions: [],
      cleansUpFrom: 4,
    });
    expect(sites.pathsTo(node(1, 5))).toEqual([
      [
        {
          sourceText: "a",
          polarity: "positive",
          source: "explicit",
          expression: "a",
        },
      ],
    ]);
  });
});
