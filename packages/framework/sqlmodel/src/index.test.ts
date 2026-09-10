import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";

import {
  sqlmodelFramework,
  sqlmodelModels,
  sqlmodelStorage,
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
      verbAttributeNames: { get: "GET", post: "POST", delete: "DELETE" },
      pathParamSyntax: "braces",
      injectedParameterCallees: ["Depends"],
      routerComposition: {
        routerConstructorName: "APIRouter",
        includeMethodName: "include_router",
        routerKeyword: "router",
        prefixKeyword: "prefix",
      },
    },
  ],
};

describe("the SQLModel pack", () => {
  it("says which types a query comes back as under SQLModel's own module", () => {
    const patterns = sqlmodelStorage({ storageSystem: "postgresql" });
    const own = patterns.filter((pattern) => pattern.module === "sqlmodel");
    expect(own.flatMap((pattern) => pattern.queryTypes)).toEqual(
      expect.arrayContaining(["Session", "Select", "SelectOfScalar"]),
    );
    expect(own.flatMap((pattern) => pattern.queryFunctions ?? [])).toContain(
      "select",
    );
    expect(patterns.every((p) => p.storageSystem === "postgresql")).toBe(true);
  });

  it("treats exec as running a statement rather than as a query of its own", () => {
    const session = sqlmodelStorage({ storageSystem: "postgresql" }).find(
      (pattern) =>
        pattern.module === "sqlmodel" && pattern.queryTypes.includes("Session"),
    );
    expect(session?.recordsNothing).toContain("exec");
  });

  it("includes the SQLAlchemy patterns, since a SQLModel project imports from both", () => {
    const modules = sqlmodelStorage({ storageSystem: "mysql" }).map(
      (pattern) => pattern.module,
    );
    expect(modules).toContain("sqlalchemy.orm");
    expect(modules).toContain("sqlalchemy");
  });

  it("adds itself to a route pack without disturbing its routes", () => {
    const composed = withSqlmodel(fastapiLike, { storageSystem: "sqlite" });
    expect(composed.name).toBe("fastapi");
    expect(composed.discovery).toBe(fastapiLike.discovery);
    expect(composed.storage?.length).toBeGreaterThan(0);
  });

  it("stands alone for a run that wants no routes", () => {
    const pack = sqlmodelFramework({ storageSystem: "postgresql" });
    expect(pack.discovery).toEqual([]);
    expect(pack.storage?.map((pattern) => pattern.module)).toContain(
      "sqlmodel",
    );
  });

  it("puts its own model base beside the SQLAlchemy ones", () => {
    const [model] = sqlmodelModels();
    expect(model?.baseNames).toContain("SQLModel");
    expect(model?.baseNames).toContain("DeclarativeBase");
  });

  it("adds exec and its own select to what SQLAlchemy already declares", () => {
    const [model] = sqlmodelModels();
    expect(model?.entryMethods).toContainEqual({ method: "exec", argument: 0 });
    expect(model?.entryMethods).toContainEqual({ method: "get", argument: 0 });
    expect(model?.entryFunctions).toContainEqual({
      module: "sqlmodel",
      name: "select",
      argument: 0,
    });
    expect(model?.entryFunctions).toContainEqual({
      module: "sqlalchemy",
      name: "select",
      argument: 0,
    });
  });

  it("stands the model declarations up on the pack a run loads", () => {
    const pack = sqlmodelFramework({ storageSystem: "postgresql" });
    expect(pack.models?.length).toBeGreaterThan(0);
    expect(
      withSqlmodel(fastapiLike, { storageSystem: "sqlite" }).models?.length,
    ).toBeGreaterThan(0);
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
});
