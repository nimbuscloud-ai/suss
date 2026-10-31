import { describe, expect, it } from "vitest";

import {
  copyAndFree,
  MirroredTree,
  type TreeSitterCursor,
  type TreeSitterTree,
} from "./mirroredTree.js";

/** A node of the fake parse the cursor below walks. */
interface Fake {
  type: string;
  start: number;
  end: number;
  named?: boolean;
  field?: string;
  missing?: boolean;
  children?: Fake[];
}

const TYPES = ["", "program", "call", "identifier", "(", ")", "arguments"];
const FIELDS = [null, "function", "arguments"];

/** A tree-sitter tree as far as the copy reads one, over the fake nodes. */
function fakeTree(
  root: Fake,
): TreeSitterTree & { deleted: boolean; delete(): void } {
  const tree = {
    deleted: false,
    language: {
      types: TYPES,
      fields: FIELDS,
      nodeTypeIsNamed: (typeId: number) =>
        !["(", ")"].includes(TYPES[typeId] ?? ""),
    },
    walk(): TreeSitterCursor {
      const path: Array<{ node: Fake; index: number }> = [
        { node: root, index: 0 },
      ];
      const here = () => (path[path.length - 1] as { node: Fake }).node;
      return {
        get nodeTypeId() {
          return TYPES.indexOf(here().type);
        },
        get currentFieldId() {
          return FIELDS.indexOf(here().field ?? null);
        },
        get startIndex() {
          return here().start;
        },
        get endIndex() {
          return here().end;
        },
        get nodeIsMissing() {
          return here().missing === true;
        },
        gotoFirstChild() {
          const first = here().children?.[0];
          if (first === undefined) {
            return false;
          }
          path.push({ node: first, index: 0 });
          return true;
        },
        gotoNextSibling() {
          if (path.length < 2) {
            return false;
          }
          const at = path[path.length - 1] as { node: Fake; index: number };
          const parent = (path[path.length - 2] as { node: Fake }).node;
          const next = parent.children?.[at.index + 1];
          if (next === undefined) {
            return false;
          }
          path[path.length - 1] = { node: next, index: at.index + 1 };
          return true;
        },
        gotoParent() {
          if (path.length < 2) {
            return false;
          }
          path.pop();
          return true;
        },
        delete() {},
      };
    },
    delete() {
      tree.deleted = true;
    },
  };
  return tree;
}

// `f(x)` on the second line of a two-line source.
const SOURCE = "\nf(x)";
const CALL: Fake = {
  type: "program",
  start: 0,
  end: 5,
  children: [
    {
      type: "call",
      start: 1,
      end: 5,
      children: [
        { type: "identifier", start: 1, end: 2, field: "function" },
        {
          type: "arguments",
          start: 2,
          end: 5,
          field: "arguments",
          children: [
            { type: "(", start: 2, end: 3, named: false },
            { type: "identifier", start: 3, end: 4 },
            { type: ")", start: 4, end: 5, named: false },
          ],
        },
      ],
    },
  ],
};

describe("a copied parse", () => {
  const tree = new MirroredTree(SOURCE, fakeTree(CALL));
  const call = tree.rootNode.namedChild(0);
  const args = call?.childForFieldName("arguments") ?? null;

  it("keeps each node's type, text, field and parent", () => {
    expect(call?.type).toBe("call");
    expect(call?.text).toBe("f(x)");
    expect(call?.childForFieldName("function")?.text).toBe("f");
    expect(call?.childrenForFieldName("arguments").map((n) => n.type)).toEqual([
      "arguments",
    ]);
    expect(args?.parent).toBe(call);
    expect(call?.tree).toBe(tree);
  });

  it("tells named children from tokens", () => {
    expect(args?.childCount).toBe(3);
    expect(args?.namedChildCount).toBe(1);
    expect(args?.namedChild(0)?.text).toBe("x");
    expect(args?.child(0)?.isNamed).toBe(false);
    expect(args?.namedChild(5)).toBeNull();
    expect(call?.namedChildren).toBe(call?.children);
  });

  it("gives rows and columns from the start of the source", () => {
    expect(call?.startPosition).toEqual({ row: 1, column: 0 });
    expect(call?.endPosition).toEqual({ row: 1, column: 4 });
    expect(tree.rootNode.startPosition).toEqual({ row: 0, column: 0 });
  });

  it("finds descendants by type, and the smallest node over a range", () => {
    expect(
      tree.rootNode.descendantsOfType("identifier").map((n) => n.text),
    ).toEqual(["f", "x"]);
    expect(tree.rootNode.descendantsOfType(["call", "arguments"]).length).toBe(
      2,
    );
    expect(tree.rootNode.descendantForIndex(3).text).toBe("x");
    expect(tree.rootNode.descendantForIndex(2, 4).type).toBe("arguments");
    expect(tree.rootNode.descendantForIndex(9).type).toBe("program");
  });

  it("reports an error from an ERROR node or a missing one", () => {
    expect(tree.rootNode.hasError).toBe(false);
    const broken = new MirroredTree(
      "f(",
      fakeTree({
        type: "program",
        start: 0,
        end: 2,
        children: [
          { type: ")", start: 2, end: 2, named: false, missing: true },
        ],
      }),
    );
    expect(broken.rootNode.hasError).toBe(true);
    expect(broken.rootNode.child(0)?.isMissing).toBe(true);
  });

  it("frees the tree it copied from", () => {
    const parsed = fakeTree(CALL);
    const copy = copyAndFree(SOURCE, parsed);
    expect(parsed.deleted).toBe(true);
    expect(copy.rootNode.text).toBe(SOURCE);
    copy.delete();
  });
});
