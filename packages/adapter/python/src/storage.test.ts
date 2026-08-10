import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitModuleImportFacts } from "./facts.js";
import { parsePython } from "./parser.js";
import { bodyCalls } from "./paths/effects.js";
import { findPythonFiles } from "./project.js";
import { bindModule } from "./scope.js";
import { storageEffects } from "./storage.js";

import type { StoragePattern } from "./pack.js";
import type { PyNode } from "./parser.js";

const SQLALCHEMY: StoragePattern = {
  module: "sqlalchemy.orm",
  queryTypes: ["Query"],
  writes: ["update", "delete", "add"],
  storageSystem: "postgres",
};

/**
 * The shape the measured corpus writes. A project base class wraps the
 * library, every model inherits it, and the file doing the querying imports
 * neither the base nor anything from SQLAlchemy.
 */
const BASE = [
  "from sqlalchemy.orm import Query",
  "",
  "class Base:",
  "    @classmethod",
  "    def query(cls) -> Query:",
  "        return session()",
  "",
].join("\n");

const MODELS = [
  "from base import Base",
  "",
  "class Orders(Base):",
  "    pass",
  "",
].join("\n");

async function effectsFor(handler: string, base = BASE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-storage-"));
  fs.writeFileSync(path.join(dir, "base.py"), base);
  fs.writeFileSync(path.join(dir, "models.py"), MODELS);
  fs.writeFileSync(
    path.join(dir, "handler.py"),
    `from models import Orders\n\n${handler}`,
  );

  const db = new Database();
  const definitions = new Map<string, PyNode>();
  let handlerRoot: PyNode | null = null;
  let handlerPath = "";

  for (const file of findPythonFiles(dir)) {
    const tree = await parsePython(fs.readFileSync(file, "utf8"));
    emitModuleImportFacts(db, file, bindModule(tree.rootNode), {
      roots: [dir],
    });
    emitValueFacts(db, file, tree.rootNode);
    const index = (node: PyNode): void => {
      if (node.type === "function_definition") {
        definitions.set(nodeId(file, node), node);
      }
      for (const child of node.namedChildren) {
        if (child !== null) {
          index(child);
        }
      }
    };
    index(tree.rootNode);
    if (file.endsWith("handler.py")) {
      handlerRoot = tree.rootNode;
      handlerPath = file;
    }
  }

  return storageEffects(bodyCalls(handlerRoot as PyNode), {
    facts: db,
    filePath: handlerPath,
    patterns: [SQLALCHEMY],
    definitionAt: (key) => definitions.get(key),
    couldMatch: new Set(["query"]),
  });
}

describe("the database work a Python body does", () => {
  it("reads a chain through a project base class the library never appears in", async () => {
    const effects = await effectsFor(
      "found = Orders.query().filter_by(id=1).first()\n",
    );

    expect(effects).toHaveLength(1);
    const [effect] = effects;
    expect(effect?.type === "interaction" ? effect.interaction : null).toEqual({
      class: "storage-access",
      kind: "read",
      fields: [],
      operation: "first",
    });
  });

  it("counts a chain once rather than once per call in it", async () => {
    const effects = await effectsFor(
      "found = Orders.query().filter_by(id=1).all()\n",
    );
    expect(effects).toHaveLength(1);
  });

  it("says a chain ending in a write is one", async () => {
    const effects = await effectsFor(
      "Orders.query().filter_by(id=1).delete()\n",
    );
    const [effect] = effects;
    expect(
      effect?.type === "interaction" &&
        effect.interaction.class === "storage-access"
        ? effect.interaction.kind
        : null,
    ).toBe("write");
  });

  it("says which model the chain was called on", async () => {
    const effects = await effectsFor("found = Orders.query().first()\n");
    const [effect] = effects;
    const semantics =
      effect?.type === "interaction" ? effect.binding.semantics : null;
    expect(
      semantics?.name === "storage-relational" ? semantics.table : null,
    ).toBe("Orders");
  });

  it("says nothing about a wrapper that returns something else", async () => {
    const effects = await effectsFor(
      "found = Orders.query().first()\n",
      [
        "from sqlalchemy.orm import Query",
        "",
        "class Base:",
        "    @classmethod",
        "    def query(cls) -> Report:",
        "        return build()",
        "",
      ].join("\n"),
    );
    expect(effects).toEqual([]);
  });

  it("says nothing when the declaring file never imports the library", async () => {
    const effects = await effectsFor(
      "found = Orders.query().first()\n",
      [
        "class Base:",
        "    @classmethod",
        "    def query(cls) -> Query:",
        "        return build()",
        "",
      ].join("\n"),
    );
    expect(effects).toEqual([]);
  });

  it("says nothing when no pack declares a pattern", async () => {
    const db = new Database();
    const tree = await parsePython("found = Orders.query().first()\n");
    expect(
      storageEffects(bodyCalls(tree.rootNode), {
        facts: db,
        filePath: "f.py",
        patterns: [],
        definitionAt: () => undefined,
        couldMatch: new Set(["query"]),
      }),
    ).toEqual([]);
  });
});
