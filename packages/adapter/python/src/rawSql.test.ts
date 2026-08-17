// What a Python body says when it hands the database a statement it
// wrote as SQL. The shape a project writes is `session.execute(text(...))`,
// so the statement is inside the call the library exports.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { emitValueFacts } from "./facts/values.js";
import { emitModuleImportFacts } from "./facts.js";
import { parsePython } from "./parser.js";
import { bodyCalls } from "./paths/effects.js";
import { rawSqlEffects } from "./rawSql.js";
import { bindModule } from "./scope.js";

import type { Effect } from "@suss/behavioral-ir";
import type { RawSqlPattern } from "./pack.js";
import type { PyNode } from "./parser.js";

const SQLALCHEMY: RawSqlPattern[] = [
  { module: "sqlalchemy", functions: ["text"], storageSystem: "postgres" },
];

async function effectsFor(source: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rawsql-"));
  const file = path.join(dir, "handler.py");
  fs.writeFileSync(file, source);

  const db = new Database();
  const tree = await parsePython(source);
  emitModuleImportFacts(db, file, bindModule(tree.rootNode), { roots: [dir] });
  emitValueFacts(db, file, tree.rootNode);

  // `bodyCalls` reads one function's own body, so the walk starts at the
  // definition rather than at the module.
  const definition = tree.rootNode.namedChildren.find(
    (child) => child?.type === "function_definition",
  ) as PyNode;
  return rawSqlEffects(bodyCalls(definition), {
    facts: db,
    filePath: file,
    patterns: SQLALCHEMY,
  });
}

function storageOf(effect: Effect) {
  if (effect.type !== "interaction") {
    throw new Error(`expected an interaction, got ${effect.type}`);
  }
  const semantics = effect.binding.semantics;
  if (semantics.name !== "storage") {
    throw new Error(`expected storage, got ${semantics.name}`);
  }
  return { semantics, interaction: effect.interaction };
}

describe("a statement a Python body writes as SQL", () => {
  it("reads the table, the fields, and what it picks rows by", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def load(session, tenant):",
        '    return session.execute(text("SELECT id, email FROM users WHERE tenant_id = :tenant"))',
      ].join("\n"),
    );

    expect(effects).toHaveLength(1);
    const { semantics, interaction } = storageOf(effects[0] as Effect);
    expect(semantics).toMatchObject({
      storageSystem: "postgres",
      container: "users",
    });
    expect(interaction).toMatchObject({
      class: "storage-access",
      kind: "read",
      fields: ["id", "email"],
      selector: ["tenant_id"],
    });
  });

  it("gives a join one effect per table", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def load(session):",
        '    return session.execute(text("SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id"))',
      ].join("\n"),
    );

    expect(
      effects.map((effect) => storageOf(effect).semantics.container),
    ).toEqual(["users", "orders"]);
  });

  it("reads a write as a write", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def touch(session, id):",
        '    session.execute(text("UPDATE users SET last_seen = NOW() WHERE id = :id"))',
      ].join("\n"),
    );

    expect(storageOf(effects[0] as Effect).interaction).toMatchObject({
      kind: "write",
      fields: ["last_seen"],
      selector: ["id"],
    });
  });

  it("reads a statement written across several lines, which is how a long query is written", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def load(session):",
        '    return session.execute(text("""',
        "        SELECT id",
        "        FROM users",
        "        WHERE active = true",
        '    """))',
      ].join("\n"),
    );

    expect(storageOf(effects[0] as Effect).semantics.container).toBe("users");
  });

  it("reads what an f-string fills in as a parameter", async () => {
    const effects = await effectsFor(
      [
        "from sqlalchemy import text",
        "",
        "def load(session, tenant):",
        '    return session.execute(text(f"SELECT id FROM users WHERE tenant_id = {tenant}"))',
      ].join("\n"),
    );

    expect(storageOf(effects[0] as Effect).interaction).toMatchObject({
      selector: ["tenant_id"],
    });
  });

  it("leaves a call to a function of the same name from somewhere else alone", async () => {
    expect(
      await effectsFor(
        [
          "from mylib import text",
          "",
          "def load(session):",
          '    return session.execute(text("SELECT id FROM users"))',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("says nothing about a statement built somewhere else", async () => {
    expect(
      await effectsFor(
        [
          "from sqlalchemy import text",
          "",
          "def load(session, statement):",
          "    return session.execute(text(statement))",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
