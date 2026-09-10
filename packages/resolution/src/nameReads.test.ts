import { beforeEach, describe, expect, it } from "vitest";

import {
  type ChainReads,
  type NameReads,
  type OrderedWrite,
  startsAtName,
  writesRunInOrder,
} from "./nameReads.js";

/** A parse tree stood up by hand, since nothing here reads a parser. */
interface TestNode {
  type: string;
  text: string;
  startIndex: number;
  children: TestNode[];
  parent: TestNode | null;
}

let cursor = 0;

beforeEach(() => {
  cursor = 0;
});

/** A leaf takes the next span of the source, so leaves are in the order they are built. */
function leaf(type: string, text: string): TestNode {
  const startIndex = cursor;
  cursor += text.length + 1;
  return { type, text, startIndex, children: [], parent: null };
}

function name(text: string): TestNode {
  return leaf("identifier", text);
}

function branch(type: string, ...children: TestNode[]): TestNode {
  const node: TestNode = {
    type,
    text: children.map((child) => child.text).join(" "),
    startIndex: children[0]?.startIndex ?? cursor,
    children,
    parent: null,
  };
  for (const child of children) {
    child.parent = node;
  }
  return node;
}

/** `x = <value>`, whose first child is the name written to. */
function assign(target: TestNode, value: TestNode): TestNode {
  return branch("assignment", target, value);
}

const RULES: NameReads<TestNode> & ChainReads<TestNode> = {
  nameType: "identifier",
  laterBodies: new Set(["function", "block"]),
  childrenOf: (node) => node.children,
  isRead: (node) => {
    const parent = node.parent;
    return parent?.type !== "assignment" || parent.children[0] !== node;
  },
  readFirst: (node) => {
    if (node.type === "call" || node.type === "paren") {
      return node.children[0] ?? null;
    }
    return null;
  },
};

function direct(at: TestNode): OrderedWrite<TestNode> {
  return { at, direct: true };
}

describe("writesRunInOrder", () => {
  it("says no when the scope has no statement list", () => {
    const write = assign(name("x"), leaf("number", "1"));
    expect(writesRunInOrder(null, "x", [direct(write)], RULES)).toBe(false);
  });

  it("says no when there are no writes", () => {
    expect(writesRunInOrder(branch("body"), "x", [], RULES)).toBe(false);
  });

  it("says no when a write is not a statement of the scope's own list", () => {
    const first = assign(name("x"), leaf("number", "1"));
    const second = assign(name("x"), leaf("number", "2"));
    const scope = branch("body", first, branch("if", second));
    expect(
      writesRunInOrder(
        scope,
        "x",
        [direct(first), { at: second, direct: false }],
        RULES,
      ),
    ).toBe(false);
  });

  it("says yes when every write is a statement and nothing reads the name between them", () => {
    const first = assign(name("x"), leaf("number", "1"));
    const other = assign(name("y"), leaf("number", "2"));
    const second = assign(name("x"), leaf("number", "3"));
    const scope = branch("body", first, other, second);
    expect(
      writesRunInOrder(scope, "x", [direct(first), direct(second)], RULES),
    ).toBe(true);
  });

  it("says no when a statement between the writes reads the name", () => {
    const first = assign(name("x"), leaf("number", "1"));
    const read = assign(name("y"), branch("call", name("x")));
    const second = assign(name("x"), leaf("number", "3"));
    const scope = branch("body", first, read, second);
    expect(
      writesRunInOrder(scope, "x", [direct(first), direct(second)], RULES),
    ).toBe(false);
  });

  it("does not count a read inside a body that runs later", () => {
    const first = assign(name("x"), leaf("number", "1"));
    const later = branch("function", branch("call", name("x")));
    const second = assign(name("x"), leaf("number", "3"));
    const scope = branch("body", first, later, second);
    expect(
      writesRunInOrder(scope, "x", [direct(first), direct(second)], RULES),
    ).toBe(true);
  });

  it("does not count a read from the last write onwards", () => {
    const first = assign(name("x"), leaf("number", "1"));
    const second = assign(name("x"), branch("call", name("x")));
    const after = assign(name("y"), branch("call", name("x")));
    const scope = branch("body", first, second, after);
    expect(
      writesRunInOrder(scope, "x", [direct(first), direct(second)], RULES),
    ).toBe(true);
  });

  it("does not count the name a write is written to", () => {
    const first = assign(name("x"), leaf("number", "1"));
    const second = assign(name("x"), leaf("number", "2"));
    const third = assign(name("x"), leaf("number", "3"));
    const scope = branch("body", first, second, third);
    expect(
      writesRunInOrder(
        scope,
        "x",
        [direct(first), direct(second), direct(third)],
        RULES,
      ),
    ).toBe(true);
  });

  it("looks past a name spelled the same in another statement", () => {
    const first = assign(name("x"), leaf("number", "1"));
    const other = assign(name("y"), branch("call", name("z")));
    const second = assign(name("x"), leaf("number", "3"));
    const scope = branch("body", first, other, second);
    expect(
      writesRunInOrder(scope, "x", [direct(first), direct(second)], RULES),
    ).toBe(true);
  });
});

describe("startsAtName", () => {
  it("reads a bare name as itself", () => {
    expect(startsAtName(name("query"), "query", RULES)).toBe(true);
  });

  it("says no for a name spelled differently", () => {
    expect(startsAtName(name("other"), "query", RULES)).toBe(false);
  });

  it("follows a chain of calls back to what it starts at", () => {
    const chain = branch("call", branch("call", name("query")));
    expect(startsAtName(chain, "query", RULES)).toBe(true);
  });

  it("reads through parentheses", () => {
    const chain = branch("call", branch("paren", name("query")));
    expect(startsAtName(chain, "query", RULES)).toBe(true);
  });

  it("says no when nothing is read before the expression", () => {
    expect(startsAtName(leaf("number", "1"), "query", RULES)).toBe(false);
  });

  it("says no when the chain starts at another name", () => {
    const chain = branch("call", name("other"));
    expect(startsAtName(chain, "query", RULES)).toBe(false);
  });

  it("says no when the part read first is missing", () => {
    expect(startsAtName(branch("call"), "query", RULES)).toBe(false);
  });
});
