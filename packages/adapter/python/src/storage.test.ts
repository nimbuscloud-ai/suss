/**
 * What the adapter adds to the storage chains a pack declares: running
 * them over a body's calls, the calls they claim, the order a body lists
 * their accesses in, and dropping a read that names no table. The
 * chains' own readings are tested with the SQLAlchemy pack.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { packRecognizers } from "@suss/extractor";

import { sqlTextTestPack } from "./__fixtures__/sqlTextPack.js";
import { storageChains } from "./__fixtures__/storageChains.js";
import { emitValueFacts, nodeId } from "./facts/values.js";
import { emitModuleImportFacts } from "./facts.js";
import { parsePython } from "./parser.js";
import { bodyCalls } from "./paths/effects.js";
import { findPythonFiles } from "./project.js";
import { bindModule } from "./scope.js";
import { bodyStorage, declaredCallIds } from "./storage.js";
import { bindEvaluator, forgetEvaluations } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { PyNode } from "./parser.js";
import type { StorageLookup } from "./storage.js";
import type { EvaluatedFile } from "./values/evaluator.js";

const MODELS = ["class Orders:", "    pass", ""].join("\n");

/**
 * The handler module beside the models, with its facts bound for the
 * evaluator, and the body of `handler` in it.
 */
async function handlerProject(handler: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-storage-"));
  fs.writeFileSync(path.join(dir, "models.py"), MODELS);
  fs.writeFileSync(
    path.join(dir, "handler.py"),
    `from models import Orders\n\n${handler}`,
  );

  const db = new Database();
  const definitions = new Map<string, PyNode>();
  const files: EvaluatedFile[] = [];
  let handlerPath = "";
  for (const file of findPythonFiles(dir)) {
    const tree = await parsePython(fs.readFileSync(file, "utf8"));
    const module = bindModule(tree.rootNode);
    files.push({ file, root: tree.rootNode, module });
    emitModuleImportFacts(db, file, module, { roots: [dir] });
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
      handlerPath = file;
    }
  }
  bindEvaluator(db, { files, definitions });
  const scanned = [...definitions.entries()].find(
    ([key, node]) =>
      key.startsWith(handlerPath) &&
      node.childForFieldName("name")?.text === "handler",
  )?.[1];
  if (scanned === undefined) {
    throw new Error("no function handler in the handler module");
  }
  const lookup: StorageLookup = {
    facts: db,
    factsPath: handlerPath,
    declared: packRecognizers(
      [
        {
          name: "sessions",
          protocol: "postgresql",
          discovery: [],
          invocationRecognizers: storageChains([
            {
              module: "sqlalchemy.orm",
              types: ["Session"],
              writes: ["add", "commit"],
              recordsNothing: ["execute"],
            },
          ]),
        },
        sqlTextTestPack("postgresql"),
      ],
      undefined,
    ),
  };
  return { db, lookup, scanned };
}

function calleeOf(effect: Effect): string | undefined {
  return effect.type === "interaction" ? effect.callee : undefined;
}

describe("the database work a Python body does", () => {
  it("lists the storage chains' accesses in the order the body makes the calls, before what other packs read", async () => {
    const { lookup, scanned } = await handlerProject(
      [
        "from sqlalchemy import text",
        "from sqlalchemy.orm import Session",
        "",
        "def handler(db: Session):",
        '    db.execute(text("SELECT id FROM orders"))',
        "    db.query(Orders).first()",
        "    db.add(Orders())",
        "",
      ].join("\n"),
    );

    expect(
      bodyStorage(scanned, lookup).effects.map(({ effect }) =>
        calleeOf(effect),
      ),
    ).toEqual(["db.query(Orders).first", "db.add", "text"]);
  });

  it("claims the call that starts each chain a declared hook reads at its last call, one that records nothing included", async () => {
    const { db, lookup, scanned } = await handlerProject(
      [
        "from sqlalchemy.orm import Session",
        "",
        "def handler(db: Session, stmt):",
        "    db.query(Orders).filter_by(id=1).first()",
        "    db.execute(stmt).scalars().all()",
        "",
      ].join("\n"),
    );
    const calls = bodyCalls(scanned, db);
    const claimed = new Set(declaredCallIds(calls, lookup));

    expect(
      calls.filter((call) => claimed.has(call.id)).map((call) => call.text),
    ).toEqual(["db.query(Orders)", "db.execute(stmt)"]);
  });

  it("recognizes a body once until evaluation starts over", async () => {
    const { db, lookup, scanned } = await handlerProject(
      [
        "from sqlalchemy.orm import Session",
        "",
        "def handler(db: Session):",
        "    db.query(Orders).first()",
        "",
      ].join("\n"),
    );

    const first = bodyStorage(scanned, lookup);
    expect(first.effects).toHaveLength(1);
    expect(bodyStorage(scanned, { ...lookup })).toBe(first);

    forgetEvaluations(db);
    const again = bodyStorage(scanned, lookup);
    expect(again).not.toBe(first);
    expect(again.effects).toEqual(first.effects);
  });

  it("records no read whose table nothing names, and keeps a write that has none", async () => {
    const { lookup, scanned } = await handlerProject(
      [
        "from sqlalchemy import func",
        "from sqlalchemy.orm import Session",
        "",
        "def handler(db: Session):",
        "    db.query(func.count()).all()",
        "    db.commit()",
        "",
      ].join("\n"),
    );

    expect(
      bodyStorage(scanned, lookup).effects.map(({ effect }) =>
        calleeOf(effect),
      ),
    ).toEqual(["db.commit"]);
  });

  it("reads nothing when no pack declares a chain", async () => {
    const { lookup, scanned } = await handlerProject(
      [
        "from sqlalchemy.orm import Session",
        "",
        "def handler(db: Session):",
        "    db.commit()",
        "",
      ].join("\n"),
    );

    expect(bodyStorage(scanned, { ...lookup, declared: [] }).effects).toEqual(
      [],
    );
  });
});
