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

const SQLALCHEMY: StoragePattern[] = [
  {
    module: "sqlalchemy.orm",
    queryTypes: ["Query"],
    writes: ["update", "delete", "add"],
    storageSystem: "postgresql",
  },
  {
    module: "sqlalchemy",
    queryTypes: ["Select"],
    writes: ["update", "delete"],
    queryFunctions: ["select"],
    storageSystem: "postgresql",
  },
];

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
    patterns: SQLALCHEMY,
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
      selector: ["id"],
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
    expect(semantics?.name === "storage" ? semantics.container : null).toBe(
      "Orders",
    );
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

  it("leaves the work a called function does to that function's own summary", async () => {
    const effects = await effectsFor(
      [
        "def load_orders():",
        "    return Orders.query().filter_by(id=1).first()",
        "",
        "found = load_orders()",
        "",
      ].join("\n"),
    );
    expect(effects).toEqual([]);
  });

  it("reads a query built from a function the file imported", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import select",
        "",
        "found = select(User.email, User.id).where(User.id == 1).all()",
        "",
      ].join("\n"),
    );
    expect(effects).toHaveLength(1);
    const [effect] = effects;
    expect(
      effect?.type === "interaction" &&
        effect.interaction.class === "storage-access"
        ? effect.interaction.fields
        : null,
    ).toEqual(["email", "id"]);
  });

  it("says nothing about a function of the same name from somewhere else", async () => {
    const effects = await effectsFor(
      [
        "from myapp.helpers import select",
        "",
        "found = select(a).all()",
        "",
      ].join("\n"),
    );
    expect(effects).toEqual([]);
  });

  it("takes a column named by a keyword when a query is built that way", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import select",
        "",
        "found = select(whole=User.email).all()",
        "",
      ].join("\n"),
    );
    expect(
      effects[0]?.type === "interaction" &&
        effects[0].interaction.class === "storage-access"
        ? effects[0].interaction.fields
        : null,
    ).toEqual(["whole"]);
  });

  it("says no columns for a query given a bare name", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import select",
        "",
        "found = select(User).all()",
        "",
      ].join("\n"),
    );
    expect(
      effects[0]?.type === "interaction" &&
        effects[0].interaction.class === "storage-access"
        ? effects[0].interaction.fields
        : null,
    ).toEqual([]);
  });

  it("says nothing about a wrapper that says nothing about what it returns", async () => {
    const effects = await effectsFor(
      "found = Orders.query().first()\n",
      [
        "from sqlalchemy.orm import Query",
        "",
        "class Base:",
        "    @classmethod",
        "    def query(cls):",
        "        return session()",
        "",
      ].join("\n"),
    );
    expect(effects).toEqual([]);
  });

  it("says nothing about a query function the file declares itself", async () => {
    const effects = await effectsFor(
      [
        "def select(*columns):",
        "    return build()",
        "",
        "found = select(User.id).all()",
        "",
      ].join("\n"),
    );
    expect(effects).toEqual([]);
  });

  it("leaves a query a called function builds from an imported constructor to that function", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import select",
        "",
        "def load_orders():",
        "    return select(User.id).all()",
        "",
        "found = load_orders()",
        "",
      ].join("\n"),
    );
    expect(effects).toEqual([]);
  });
});
