import { describe, expect, it } from "vitest";

import { factValueOps } from "@suss/recognize/ops";

import { pythonFactSource } from "./factSource.js";
import { parsePython } from "./parser.js";
import { factsForFile } from "./project.js";
import { bindModule } from "./scope.js";

import type { AstCapableValueOps } from "@suss/extractor";
import type { PyNode } from "./parser.js";

const FILE = "use.py";

const SOURCE = `
from .things import Thing
import kit
from acme import ledger
from relay import Dispatcher

def deliver(to: Dispatcher):
    to.dispatch("orders")

kind = "primary"
options = {"label": f"{kind} x", "count": 2, "comp": Thing, "kit": kit, "local": kind}

def make():
    return lambda: None

def named():
    return None

render = make()
alias = named
`;

async function sourceFor() {
  const tree = await parsePython(SOURCE);
  const root = tree.rootNode;
  const db = factsForFile({
    file: FILE,
    root,
    module: bindModule(root),
    packs: [],
  });
  const source = pythonFactSource(db);
  const [options] = source.comesTo?.(`${FILE}#options`) ?? [];
  const held = (name: string): string =>
    String(
      db
        .lookup("holdsProperty", 0, options ?? "")
        .find((row) => row[1] === name)?.[2],
    );
  return { db, source, options, held };
}

describe("the Python fact source", () => {
  it("gives the object a name was written as", async () => {
    const { source, options } = await sourceFor();

    expect(options).toBeDefined();
    expect(source.shapeOf(options ?? "")).toBe("object");
    expect(source.comesTo?.(`${FILE}#missing`)).toEqual([]);
  });

  it("gives the function a name comes to, and the one a factory call gives back", async () => {
    const { db, source } = await sourceFor();
    const isFunction = (key: string | null | undefined) =>
      db.lookup("func", 0, key ?? "").length === 1;

    expect(source.comesTo?.(`${FILE}#alias`).every(isFunction)).toBe(true);
    expect(source.comesTo?.(`${FILE}#alias`)).toHaveLength(1);
    expect(source.comesTo?.(`${FILE}#render`)).toEqual([]);
    expect(isFunction(source.givesBack?.(`${FILE}#render`))).toBe(true);
    expect(source.givesBack?.(`${FILE}#alias`)).toBeNull();
  });

  it("settles an f-string and a number the evaluator folds", async () => {
    const { source, held } = await sourceFor();

    expect(source.evaluatedOf?.(held("label"))).toBe("primary x");
    expect(source.evaluatedOf?.(held("count"))).toBe(2);
    expect(source.evaluatedOf?.(held("comp"))).toBeNull();
  });

  it("reads a module imported from its package as the package's own member", async () => {
    const { source } = await sourceFor();

    expect(source.importedAs(`${FILE}#ledger`, "acme.ledger")).toEqual(["*"]);
    expect(source.importedAs(`${FILE}#ledger`, "acme")).toEqual(["ledger"]);
  });

  it("checks a receiver against the class its parameter is annotated with", async () => {
    const { db, source } = await sourceFor();
    const [dispatch] = db
      .facts("call")
      .map((row) => String(row[0]))
      .filter((call) => source.textOf(call).includes("dispatch"));
    const typed = (named: string) =>
      source.typedAs?.(dispatch ?? "", {
        origin: "typed",
        importedFrom: ["relay"],
        named: [named],
      });

    expect(typed("Dispatcher")).toBe(true);
    expect(typed("Other")).toBe(false);
  });

  it("gives the module an import statement spells, and nothing for a name the file assigns", async () => {
    const { source, held } = await sourceFor();

    expect(source.importSpecifierOf?.(held("comp"))).toBe(".things");
    expect(source.importSpecifierOf?.(held("kit"))).toBe("kit");
    expect(source.importSpecifierOf?.(held("local"))).toBeNull();
  });

  it("says how the source wrote a value, and hands over a lambda's own node", async () => {
    const { db, source, options, held } = await sourceFor();
    const returned = new Map(
      db
        .facts("returnsValue")
        .map((row) => String(row[1]))
        .map((key) => [source.textOf(key), key]),
    );
    const lambda = returned.get("lambda: None") ?? "";

    expect(source.formOf?.(lambda)).toBe("function");
    expect(source.formOf?.(returned.get("None") ?? "")).toBe("other");
    expect(source.formOf?.(options ?? "")).toBe("object");
    expect(source.formOf?.(held("comp"))).toBe("name");
    expect(source.formOf?.(held("count"))).toBe("other");
    const ops = factValueOps(lambda, source) as Partial<AstCapableValueOps>;
    expect((ops.ast?.() as PyNode | undefined)?.type).toBe("lambda");
    expect(
      (factValueOps(held("comp"), source) as Partial<AstCapableValueOps>).ast,
    ).toBeUndefined();
  });

  it("gives what json.dumps was handed, when json is the module the file imported", async () => {
    const tree = await parsePython(
      [
        "import json",
        "from mylib import codec",
        "",
        'json.dumps({"a": 1})',
        'codec.dumps({"b": 2})',
        "json.dumps()",
        'json.loads("{}")',
      ].join("\n"),
    );
    const root = tree.rootNode;
    const db = factsForFile({
      file: FILE,
      root,
      module: bindModule(root),
      packs: [],
    });
    const source = pythonFactSource(db);
    const encodings = db
      .facts("call")
      .map((row) => String(row[0]))
      .sort((a, b) => source.textOf(a).localeCompare(source.textOf(b)))
      .map((call) => {
        const found = source.encodedOf?.(call) ?? null;
        return [
          source.textOf(call),
          found === null
            ? null
            : `${found.codec} ${source.textOf(found.value)}`,
        ];
      });

    expect(encodings).toEqual([
      ['codec.dumps({"b": 2})', null],
      ["json.dumps()", null],
      ['json.dumps({"a": 1})', 'json {"a": 1}'],
      ['json.loads("{}")', null],
    ]);
  });
});
