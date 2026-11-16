import { describe, expect, it } from "vitest";

import { pythonModuleOps } from "./declaredDiscovery.js";
import { parsePython } from "./parser.js";
import { factsForFile } from "./project.js";
import { bindModule } from "./scope.js";

async function opsOf(source: string) {
  const file = "/app/routes.py";
  const tree = await parsePython(source);
  const module = bindModule(tree.rootNode);
  const db = factsForFile({ file, root: tree.rootNode, module, packs: [] });
  return pythonModuleOps(
    { file, displayPath: "routes.py", root: tree.rootNode, module },
    db,
  );
}

describe("a Python file as module ops", () => {
  it("maps each name imported from the modules to the name the module exports, and leaves a relative import out", async () => {
    const ops = await opsOf(
      "from flask import Blueprint as BP, request\n" +
        "from .local import Blueprint\n" +
        "import flask\n",
    );
    expect([...ops.importedNames(["flask"])]).toEqual([
      ["BP", "Blueprint"],
      ["request", "request"],
    ]);
  });

  it("reads a list through a name with its spreads in place, and no list a function returns", async () => {
    const ops = await opsOf(
      "more = [b]\n" +
        "routes = [a, *more, make()]\n" +
        "def built():\n" +
        "    return [x]\n" +
        "router(routes)\n" +
        "again(routes)\n" +
        "router(built())\n",
    );
    const [first, second, third] = ops
      .calls()
      .filter((call) => ["router", "again"].includes(call.calleeText()))
      .map((call) => call.valueAt(0)?.listed?.() ?? null);

    expect(
      first?.entries.map(({ form, value }) => `${form} ${value.source?.()}`),
    ).toEqual(["value a", "spread more", "value make()"]);
    expect(second?.key).toBe(first?.key);
    expect(third).toBeNull();
  });

  it("lists the classes it writes, nested ones and ones inside a function included, in source order", async () => {
    const source =
      "class Outer(Base):\n" +
      "    class Inner:\n" +
      "        pass\n" +
      "\n" +
      "def make():\n" +
      "    class Local:\n" +
      "        pass\n";
    const file = "/app/models.py";
    const tree = await parsePython(source);
    const module = bindModule(tree.rootNode);
    const db = factsForFile({ file, root: tree.rootNode, module, packs: [] });
    const ops = pythonModuleOps(
      { file, displayPath: "models.py", root: tree.rootNode, module },
      db,
    );
    const classes = ops.classes();
    expect(classes).toHaveLength(3);
    expect(classes[0]?.name()).toBe("Outer");
  });

  it("lists the functions and classes it writes under decorators, a method and one inside a function included, in source order", async () => {
    const ops = await opsOf(
      "@app.get('/x')\n" +
        "def read():\n" +
        "    @wraps(read)\n" +
        "    def inner():\n" +
        "        pass\n" +
        "\n" +
        "@ns.route('/y')\n" +
        "class Item:\n" +
        "    @staticmethod\n" +
        "    def get():\n" +
        "        pass\n" +
        "\n" +
        "def plain():\n" +
        "    pass\n",
    );
    expect(
      ops
        .decorated()
        .map(({ definition, decorators }) => [
          definition.source?.().split("\n")[0],
          decorators.length,
        ]),
    ).toEqual([
      ["def read():", 1],
      ["def inner():", 1],
      ["class Item:", 1],
      ["def get():", 1],
    ]);
  });
});
