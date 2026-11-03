import { describe, expect, it } from "vitest";

import { pythonFactSource } from "./factSource.js";
import { parsePython } from "./parser.js";
import { factsForFile } from "./project.js";
import { bindModule } from "./scope.js";

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
});
