// The JSX elements a function body renders, with each one's tag and
// attributes, and the question that lists a function's elements the way
// runsCall lists its calls. A sub-unit hook reads them, and no rule does.

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { resolutionProgram, resolutionUnderProgram } from "@suss/resolution";

import { jsxTagOf } from "./directives.js";
import { createNodeTable, extractFileFacts } from "./extract.js";
import { ResolutionStore } from "./store.js";

const SOURCE = `
export function Panel({ items, onClose, select }) {
  function footer() { return <footer />; }
  return (
    <section onClick={() => onClose()} hidden>
      {items.map((item) => <Row key={item} onSelect={(select)} {...item} />)}
      <></>
    </section>
  );
}
`;

function panelFile() {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("/panel.tsx", SOURCE);
}

/** Each row of the relation, with an element written as its tag and any other node as its text. */
function rowsOf(relation: string): string[][] {
  const db = new Database();
  const table = createNodeTable([]);
  extractFileFacts(db, table, panelFile());
  const text = (key: string): string => {
    const node = table.byId.get(key);
    if (node === undefined) {
      return key;
    }
    const tag = jsxTagOf(node);
    return tag === null ? node.getText().split("\n")[0] : `<${tag.getText()}>`;
  };
  return db
    .facts(relation)
    .map((row) => row.map((value) => text(String(value))));
}

describe("the elements a body renders", () => {
  it("states each element against the body that writes it, a nested declaration's against that declaration", () => {
    expect(rowsOf("rendersElement")).toEqual([
      ["function footer() { return <footer />; }", "<footer>"],
      ["export function Panel({ items, onClose, select }) {", "<section>"],
      ["(item) => <Row key={item} onSelect={(select)} {...item} />", "<Row>"],
    ]);
  });

  it("states each attribute with its value read through parentheses, an attribute with no value as itself, and no spread", () => {
    expect(rowsOf("jsxAttribute")).toEqual([
      ["<section>", "onClick", "() => onClose()"],
      ["<section>", "hidden", "hidden"],
      ["<Row>", "key", "item"],
      ["<Row>", "onSelect", "select"],
    ]);
  });

  it("lists a function's elements with those of the arrows it runs inline, in source order", () => {
    const file = panelFile();
    const panel = file.getFunctionOrThrow("Panel");
    const tags = new ResolutionStore()
      .elementsRunBy(panel)
      .map((element) => jsxTagOf(element)?.getText());
    expect(tags).toEqual(["section", "Row"]);
  });

  it("is read by no rule but the one that lists a function's elements", () => {
    const readers = [resolutionProgram(), resolutionUnderProgram()]
      .flatMap((program) => program.rules)
      .filter(
        (rule) =>
          rule.head.relation !== "runsElement" &&
          rule.body.some(
            (literal) =>
              "relation" in literal &&
              ["rendersElement", "jsxAttribute"].includes(literal.relation),
          ),
      );

    expect(readers).toEqual([]);
  });
});
