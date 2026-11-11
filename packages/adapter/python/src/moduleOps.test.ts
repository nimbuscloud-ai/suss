import { describe, expect, it } from "vitest";

import { pythonModuleOps } from "./declaredDiscovery.js";
import { parsePython } from "./parser.js";
import { factsForFile } from "./project.js";
import { bindModule } from "./scope.js";

describe("a Python file as module ops", () => {
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
});
