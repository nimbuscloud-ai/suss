import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";
import { fastapiRoutes, ROUTER_UNREAD } from "@suss/framework-fastapi";
import { storageWords } from "@suss/framework-sqlalchemy";

import {
  SQLMODEL_MODEL_CALLS,
  SQLMODEL_TYPES,
  STATEMENT_MODULES,
  sqlmodelFramework,
  withSqlmodel,
} from "./index.js";

import type { PythonPack } from "@suss/adapter-python";

/** The part of the fastapi pack a route needs to be found. */
const fastapiLike: PythonPack = {
  name: "fastapi",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      routes: { table: fastapiRoutes(["fastapi"]), unread: ROUTER_UNREAD },
      pathParamSyntax: "braces",
      injectedParameterCallees: ["Depends"],
    },
  ],
};

describe("the SQLModel pack", () => {
  it("declares a chain for each query type under SQLModel's own modules", () => {
    const own = SQLMODEL_TYPES.filter((one) =>
      one.module.startsWith("sqlmodel"),
    );
    expect(own.flatMap((one) => one.types)).toEqual(
      expect.arrayContaining(["Session", "AsyncSession", "SelectOfScalar"]),
    );
  });

  it("treats exec as running a statement rather than as a query of its own", () => {
    const session = SQLMODEL_TYPES.find((one) => one.types.includes("Session"));
    expect(session?.recordsNothing).toContain("exec");
  });

  it("includes the SQLAlchemy chains and statements, since a SQLModel project imports from both", () => {
    expect(SQLMODEL_TYPES.map((one) => one.module)).toContain("sqlalchemy.orm");
    expect(STATEMENT_MODULES).toEqual(["sqlmodel", "sqlalchemy"]);
  });

  it("adds itself to a route pack without disturbing its routes", () => {
    const composed = withSqlmodel(fastapiLike, { storageSystem: "sqlite" });
    expect(composed.name).toBe("fastapi");
    expect(composed.discovery).toBe(fastapiLike.discovery);
    expect(composed.invocationRecognizers?.length).toBeGreaterThan(0);
  });

  it("stands alone for a run that wants no routes", () => {
    const pack = sqlmodelFramework({ storageSystem: "postgresql" });
    expect(pack.discovery).toEqual([]);
    expect(pack.invocationRecognizers?.length).toBeGreaterThan(0);
  });

  it("puts its own model base beside the SQLAlchemy ones", () => {
    expect(SQLMODEL_MODEL_CALLS.baseNames).toContain("SQLModel");
    expect(SQLMODEL_MODEL_CALLS.baseNames).toContain("DeclarativeBase");
  });

  it("adds exec and its own select to what SQLAlchemy already declares", () => {
    expect(SQLMODEL_MODEL_CALLS.entryMethods).toContainEqual({
      method: "exec",
      argument: 0,
    });
    expect(SQLMODEL_MODEL_CALLS.entryMethods).toContainEqual({
      method: "get",
      argument: 0,
    });
    expect(SQLMODEL_MODEL_CALLS.entryFunctions).toEqual([
      { module: "sqlalchemy", name: "select", argument: 0 },
      { module: "sqlmodel", name: "select", argument: 0 },
    ]);
  });

  it("states its words on the pack a run loads, and on a route pack it composes with", () => {
    const words = storageWords(SQLMODEL_MODEL_CALLS);
    expect(sqlmodelFramework({ storageSystem: "postgresql" }).words).toEqual(
      words,
    );
    expect(
      withSqlmodel(fastapiLike, { storageSystem: "sqlite" }).words,
    ).toEqual(words);
  });

  it("refuses a config that says no database with a sentence instead of a TypeError", () => {
    expect(() => sqlmodelFramework(undefined as never)).toThrow(
      /storageSystem/,
    );
  });
});

describe("a FastAPI handler using SQLModel", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-sqlmodel-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it("reads the session through an Annotated alias from another module", async () => {
    write("app/__init__.py", "");
    write("app/api/__init__.py", "");
    write(
      "app/models.py",
      [
        "from sqlmodel import Field, SQLModel",
        "",
        "class Item(SQLModel, table=True):",
        "    id: int = Field(primary_key=True)",
        "",
      ].join("\n"),
    );
    write(
      "app/api/deps.py",
      [
        "from typing import Annotated",
        "from fastapi import Depends",
        "from sqlmodel import Session",
        "",
        "def get_db():",
        "    yield Session()",
        "",
        "SessionDep = Annotated[Session, Depends(get_db)]",
        "",
      ].join("\n"),
    );
    write(
      "app/api/items.py",
      [
        "from fastapi import APIRouter",
        "from sqlmodel import select",
        "from app.api.deps import SessionDep",
        "from app.models import Item",
        "",
        "router = APIRouter()",
        "",
        '@router.get("/items")',
        "def read_items(session: SessionDep, skip: int = 0):",
        "    return session.exec(select(Item).offset(skip)).all()",
        "",
        '@router.post("/items")',
        "def create_item(session: SessionDep, item: Item):",
        "    session.add(item)",
        "    session.commit()",
        "    return item",
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [...findPythonFiles(tmpDir)],
      packs: [withSqlmodel(fastapiLike, { storageSystem: "postgresql" })],
      roots: [tmpDir],
    });

    const storageBy = (name: string) =>
      summaries
        .filter((summary) => summary.identity.name === name)
        .flatMap((summary) => summary.transitions)
        .flatMap((transition) => transition.effects)
        .flatMap((effect) =>
          effect.type === "interaction" &&
          effect.interaction.class === "storage-access"
            ? [effect.interaction]
            : [],
        );

    expect(storageBy("read_items")).toMatchObject([
      { kind: "read", operation: "select" },
    ]);
    expect(storageBy("create_item")).toMatchObject([
      { kind: "write", operation: "add" },
      { kind: "write", operation: "commit" },
    ]);
  });

  it("reads a statement written as SQL under the package it imported `text` from", async () => {
    write(
      "app/__init__.py",
      [
        "import sqlmodel",
        "from sqlalchemy import text as raw",
        "from sqlmodel import text",
        "",
        "def touch(pool, id):",
        '    pool.execute(text("UPDATE items SET seen = true WHERE id = :id"), {"id": id})',
        '    pool.execute(raw("SELECT id FROM tags"))',
        '    pool.execute(sqlmodel.text("SELECT id FROM notes"))',
        "",
      ].join("\n"),
    );

    const { summaries } = await extractPythonProject({
      files: [...findPythonFiles(tmpDir)],
      packs: [sqlmodelFramework({ storageSystem: "postgresql" })],
      roots: [tmpDir],
      modules: [{ name: "app", root: path.join(tmpDir, "app") }],
      workspaceRoot: tmpDir,
      cacheDir: null,
    });
    const accesses = summaries
      .filter((summary) => summary.identity.name.endsWith("touch"))
      .flatMap((summary) => summary.transitions)
      .flatMap((transition) => transition.effects)
      .flatMap((effect) =>
        effect.type === "interaction" &&
        effect.binding?.semantics.name === "storage"
          ? [[effect.binding.recognition, effect.binding.semantics.container]]
          : [],
      );

    expect(accesses).toEqual([
      ["python-sqlmodel", "items"],
      ["python-sqlalchemy", "tags"],
    ]);
  });
});
