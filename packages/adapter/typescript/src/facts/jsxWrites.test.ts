// The JSX rows a reader asks for on one function, and the rest element
// of a parameter's destructure. No rule reads any of them.

import { Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { resolutionProgram, resolutionUnderProgram } from "@suss/resolution";

import { createNodeTable } from "./extract.js";
import { stateElementsWritten } from "./jsxWrites.js";
import { ResolutionStore } from "./store.js";

import type { Node } from "ts-morph";

const RENDER = [
  "export function render(args: { label: string }) {",
  '  const held = <Badge tone="warm" />;',
  "  return (",
  "    <Frame open label={args.label} {...args}>",
  "      <Chip />",
  "      text",
  "      {/* note */}",
  "      {held}",
  '      {[1].map(() => <Chip size="md" />)}',
  "    </Frame>",
  "  );",
  "}",
].join("\n");

/** An element by its tag, any other node by its text with whitespace folded. */
function shown(node: Node | undefined, value: string): string {
  if (node === undefined) {
    return value;
  }
  if (node.isKind(SyntaxKind.JsxElement)) {
    return `<${node.getOpeningElement().getTagNameNode().getText()}>`;
  }
  if (node.isKind(SyntaxKind.FunctionDeclaration)) {
    return node.getName() ?? "function";
  }
  return node.getText().replace(/\s+/g, " ").trim();
}

function rowsFor(): Record<string, string[][]> {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("/mod.tsx", RENDER);
  const db = new Database();
  const table = createNodeTable([]);
  const written = stateElementsWritten(
    db,
    table,
    sourceFile.getFunctionOrThrow("render"),
  );
  const rows = (relation: string) =>
    db
      .facts(relation)
      .map((row) =>
        row.map((value) => shown(table.byId.get(String(value)), String(value))),
      );
  return {
    written: [written.map((id) => shown(table.byId.get(id), id))],
    writesElement: rows("writesElement"),
    jsxElement: rows("jsxElement"),
    jsxAttribute: rows("jsxAttribute"),
    jsxSpread: rows("jsxSpread"),
    jsxChild: rows("jsxChild"),
  };
}

describe("the JSX a function writes", () => {
  it("states every element under the function, held in a local or written in a callback, with its attributes, spreads and children", () => {
    const rows = rowsFor();

    expect(rows.written).toEqual([
      ['<Badge tone="warm" />', "<Frame>", "<Chip />", '<Chip size="md" />'],
    ]);
    expect(rows.writesElement).toEqual([
      ["render", '<Badge tone="warm" />'],
      ["render", "<Frame>"],
      ["render", "<Chip />"],
      ["render", '<Chip size="md" />'],
    ]);
    expect(rows.jsxElement).toEqual([
      ['<Badge tone="warm" />', "Badge"],
      ["<Frame>", "Frame"],
      ["<Chip />", "Chip"],
      ['<Chip size="md" />', "Chip"],
    ]);
    expect(rows.jsxAttribute).toEqual([
      ['<Badge tone="warm" />', "tone", '"warm"'],
      ["<Frame>", "open", "open"],
      ["<Frame>", "label", "args.label"],
      ['<Chip size="md" />', "size", '"md"'],
    ]);
    expect(rows.jsxSpread).toEqual([["<Frame>", "args"]]);
    expect(rows.jsxChild).toEqual([
      ["<Frame>", "1", "<Chip />"],
      ["<Frame>", "2", "text"],
      ["<Frame>", "5", "{held}"],
      ["<Frame>", "7", '{[1].map(() => <Chip size="md" />)}'],
    ]);
  });
});

describe("restOf", () => {
  it("states the rest of a parameter's destructure, and no other rest element", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      "/mod.ts",
      [
        "export function show({ label, ...rest }: Record<string, string>) {",
        "  const { size, ...others } = rest;",
        "  return [label, rest, size, others];",
        "}",
      ].join("\n"),
    );
    const store = new ResolutionStore();
    const access = store.factAccess();
    for (const reference of sourceFile
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .flatMap((statement) =>
        statement.getDescendantsOfKind(SyntaxKind.Identifier),
      )) {
      access.state(reference);
    }

    expect(
      access.db
        .facts("restOf")
        .map((row) =>
          row.map((value) =>
            shown(access.nodeOf(String(value)), String(value)),
          ),
        ),
    ).toEqual([["...rest", "{ label, ...rest }: Record<string, string>"]]);
  });
});

describe("the JSX rows and restOf", () => {
  it("are read by no rule, since a row exists only for a function some reader asked about", () => {
    const readers = [resolutionProgram(), resolutionUnderProgram()]
      .flatMap((program) => program.rules)
      .filter((rule) =>
        rule.body.some(
          (literal) =>
            "relation" in literal &&
            [
              "writesElement",
              "jsxAttribute",
              "jsxSpread",
              "jsxChild",
              "restOf",
            ].includes(literal.relation),
        ),
      );

    expect(readers).toEqual([]);
  });
});
