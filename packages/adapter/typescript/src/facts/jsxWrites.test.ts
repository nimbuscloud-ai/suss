// The JSX rows a reader asks for on one function or file, and the rest element
// of a parameter's destructure. No rule reads any of them.

import { Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { resolutionProgram, resolutionUnderProgram } from "@suss/resolution";

import { createNodeTable } from "./extract.js";
import { stateElementsWritten } from "./jsxWrites.js";
import { ResolutionStore } from "./store.js";

import type { Node, SourceFile } from "ts-morph";

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

const ROUTES = [
  "export const tree = (",
  "  <Routes>",
  '    <Route path="/a" element={<Layout />}>',
  '      {flag && <Route path="b" element={(<B />) as never} />}',
  '      <Route path="c" element={<Guard><Route path="d" /></Guard>} />',
  "    </Route>",
  "  </Routes>",
  ");",
].join("\n");

function rowsFor(
  source = RENDER,
  rootOf: (file: SourceFile) => Node = (file) =>
    file.getFunctionOrThrow("render"),
): Record<string, string[][]> {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("/mod.tsx", source);
  const db = new Database();
  const table = createNodeTable([]);
  const written = stateElementsWritten(db, table, rootOf(sourceFile));
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
    jsxParent: rows("jsxParent"),
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

  it("states the elements a file writes under its path, each under the nearest element written with children around it", () => {
    const rows = rowsFor(ROUTES, (file) => file);

    expect(rows.writesElement.map(([writer]) => writer)).toEqual(
      Array(8).fill("/mod.tsx"),
    );
    expect(rows.jsxParent).toEqual([
      ["<Route>", "<Routes>"],
      ["<Layout />", "<Route>"],
      ['<Route path="b" element={(<B />) as never} />', "<Route>"],
      ["<B />", "<Route>"],
      [
        '<Route path="c" element={<Guard><Route path="d" /></Guard>} />',
        "<Route>",
      ],
      ["<Guard>", "<Route>"],
      ['<Route path="d" />', "<Guard>"],
    ]);
  });

  it("keys an attribute's value inside its braces and under parentheses and casts", () => {
    const rows = rowsFor(ROUTES, (file) => file);

    expect(rows.jsxAttribute.filter(([, name]) => name === "element")).toEqual([
      ["<Route>", "element", "<Layout />"],
      ['<Route path="b" element={(<B />) as never} />', "element", "<B />"],
      [
        '<Route path="c" element={<Guard><Route path="d" /></Guard>} />',
        "element",
        "<Guard>",
      ],
    ]);
  });
});

describe("an attribute the body walk states too", () => {
  it("has one row, its value keyed past parentheses and a cast, whichever of the two states it first", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(
      "/mod.tsx",
      [
        "export function Toast({ close }: { close: () => void }) {",
        '  return <button onClick={(close)} title={"x" as string} />;',
        "}",
      ].join("\n"),
    );
    const toast = sourceFile.getFunctionOrThrow("Toast");
    const store = new ResolutionStore();
    const rendered = store.elementsRunBy(toast);
    store.elementsWrittenIn(toast);
    const access = store.factAccess();

    expect(rendered.map((element) => element.getText())).toEqual([
      '<button onClick={(close)} title={"x" as string} />',
    ]);
    expect(
      access.db
        .facts("jsxAttribute")
        .map((row) => [
          String(row[1]),
          shown(access.nodeOf(String(row[2])), String(row[2])),
        ]),
    ).toEqual([
      ["onClick", "close"],
      ["title", '"x"'],
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
              "jsxParent",
              "restOf",
            ].includes(literal.relation),
        ),
      );

    expect(readers).toEqual([]);
  });
});
