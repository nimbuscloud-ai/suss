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

import type { Effect } from "@suss/behavioral-ir";
import type { StoragePattern } from "./pack.js";
import type { PyNode } from "./parser.js";

const SQLALCHEMY: StoragePattern[] = [
  {
    module: "sqlalchemy.orm",
    queryTypes: ["Query", "Session"],
    writes: ["update", "delete", "add", "commit"],
    recordsNothing: ["execute", "close"],
    storageSystem: "postgresql",
  },
  {
    module: "sqlalchemy",
    queryTypes: ["Select"],
    writes: ["update", "delete", "insert"],
    queryFunctions: ["select", "update", "delete", "insert"],
    valueMethods: ["values"],
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

/**
 * The effects of the handler module's own body, or, when `inFunction` is
 * given, of the body of that function within it.
 */
async function effectsFor(handler: string, base = BASE, inFunction?: string) {
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

  const scanned =
    inFunction === undefined
      ? (handlerRoot as PyNode)
      : [...definitions.entries()].find(
          ([key, node]) =>
            key.startsWith(handlerPath) &&
            node.childForFieldName("name")?.text === inFunction,
        )?.[1];
  if (scanned === undefined) {
    throw new Error(`no function ${inFunction} in the handler`);
  }

  return storageEffects(bodyCalls(scanned), {
    facts: db,
    filePath: handlerPath,
    patterns: SQLALCHEMY,
    definitionAt: (key) => definitions.get(key),
    couldMatch: new Set(["query", "open_session"]),
  });
}

function accessOf(effect: Effect | undefined) {
  return effect?.type === "interaction" &&
    effect.interaction.class === "storage-access"
    ? effect.interaction
    : null;
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

  it("says a statement function is the write it is named for, whatever it ends with", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import delete, insert, update",
        "",
        "update(Orders).where(Orders.id == 1).values(total=2)",
        "delete(Orders).where(Orders.id == 1)",
        "insert(Orders).values(id=1, total=3)",
        "",
      ].join("\n"),
    );
    expect(effects.map(accessOf)).toMatchObject([
      { kind: "write", operation: "update", fields: ["total"] },
      { kind: "write", operation: "delete", fields: [] },
      { kind: "write", operation: "insert", fields: ["id", "total"] },
    ]);
    expect(accessOf(effects[0])?.selector).toBeUndefined();
  });

  it("reads a session the handler takes as an annotated parameter", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy.orm import Session",
        "",
        "def create(db: Session):",
        "    db.add(Orders())",
        "    db.commit()",
        "    return db.query(Orders).filter_by(id=1).first()",
        "",
      ].join("\n"),
      BASE,
      "create",
    );
    expect(effects.map(accessOf)).toMatchObject([
      { kind: "write", operation: "add" },
      { kind: "write", operation: "commit" },
      { kind: "read", operation: "first", selector: ["id"] },
    ]);
  });

  it("reads a session the body builds or opens itself", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy.orm import Session",
        "",
        "def create():",
        "    session = Session()",
        "    session.add(Orders())",
        "    with Session() as opened:",
        "        opened.commit()",
        "",
      ].join("\n"),
      BASE,
      "create",
    );
    expect(effects.map(accessOf)).toMatchObject([
      { kind: "write", operation: "add" },
      { kind: "write", operation: "commit" },
    ]);
  });

  it("reads a session a project function says it returns", async () => {
    const effects = await effectsFor(
      [
        "from base import open_session",
        "",
        "open_session().add(Orders())",
        "",
      ].join("\n"),
      [
        "from sqlalchemy.orm import Session",
        "",
        "def open_session() -> Session:",
        "    return Session()",
        "",
      ].join("\n"),
    );
    expect(effects.map(accessOf)).toMatchObject([
      { kind: "write", operation: "add" },
    ]);
  });

  it("records nothing for a session method the pack says touches no rows", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import select",
        "from sqlalchemy.orm import Session",
        "",
        "def rows(db: Session):",
        "    found = db.execute(select(Orders.id)).all()",
        "    db.close()",
        "    return found",
        "",
      ].join("\n"),
      BASE,
      "rows",
    );
    expect(effects.map(accessOf)).toMatchObject([
      { kind: "read", operation: "select", fields: ["id"] },
    ]);
  });

  it("reads the session type through a forward reference, Annotated, and Optional", async () => {
    const effects = await effectsFor(
      [
        "from typing import Annotated, Optional",
        "from sqlalchemy.orm import Session",
        "",
        'def create(db: "Session", other: Annotated[Session, 1], third: Optional[Session], fourth: list[Session]):',
        "    db.add(Orders())",
        "    other.add(Orders())",
        "    third.add(Orders())",
        "    fourth.add(Orders())",
        "    def inner():",
        "        db = Store()",
        "    return inner",
        "",
      ].join("\n"),
      BASE,
      "create",
    );
    expect(effects.map(accessOf)).toMatchObject([
      { operation: "add" },
      { operation: "add" },
      { operation: "add" },
    ]);
  });

  it("says nothing about a parameter of a type the library does not export", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy.orm import Session",
        "",
        "class Store:",
        "    pass",
        "",
        "def create(db: Store):",
        "    db.add(Orders())",
        "",
      ].join("\n"),
      BASE,
      "create",
    );
    expect(effects).toEqual([]);
  });
});
