import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";

import {
  modelWords,
  PACK_VERSION,
  SQLALCHEMY_MODEL_CALLS,
  SQLALCHEMY_TYPES,
  sqlalchemyFramework,
  withSqlalchemy,
} from "./index.js";

import type { PythonPack } from "@suss/adapter-python";

const routePack: PythonPack = {
  name: "flask-restx",
  protocol: "http",
  discovery: [],
};

describe("the SQLAlchemy pack", () => {
  it("declares a chain for each query type, on its own module", () => {
    expect(
      SQLALCHEMY_TYPES.map((one) => [one.module, one.types, one.values ?? []]),
    ).toEqual([
      ["sqlalchemy.orm", ["Query", "Session"], []],
      ["sqlalchemy", ["Select", "Update", "Delete", "Insert"], ["values"]],
    ]);
  });

  it("adds its chains to a route pack without disturbing its routes", () => {
    const composed = withSqlalchemy(routePack, { storageSystem: "sqlite" });
    expect(composed.name).toBe("flask-restx");
    expect(composed.discovery).toBe(routePack.discovery);
    expect(composed.invocationRecognizers?.length).toBeGreaterThan(0);
  });

  it("keeps the hooks the route pack already had, first", () => {
    const hook = () => null;
    const already: PythonPack = { ...routePack, invocationRecognizers: [hook] };
    expect(
      withSqlalchemy(already, { storageSystem: "postgresql" })
        .invocationRecognizers?.[0],
    ).toBe(hook);
  });

  it("stands alone for a run that wants no routes", () => {
    const pack = sqlalchemyFramework({ storageSystem: "postgresql" });
    expect(pack.discovery).toEqual([]);
    expect(pack.invocationRecognizers?.length).toBeGreaterThan(0);
  });

  it("says a chain method hands the same model on, for every base a mapped class's ancestry arrives at", () => {
    const words = modelWords(SQLALCHEMY_MODEL_CALLS);
    expect(words.givesBackOne).toContainEqual({
      base: "DeclarativeBase",
      method: "where",
    });
    expect(words.givesBackOne).toContainEqual({
      base: "declarative_base",
      method: "first",
    });
    expect(words.givesBackOne?.map((one) => one.method)).not.toContain("count");
  });

  it("says which calls take the mapped class and give back one of it", () => {
    const words = modelWords(SQLALCHEMY_MODEL_CALLS);
    expect(words.givesBackOneOfArgument).toContainEqual({
      base: "DeclarativeBase",
      method: "get",
      argument: 0,
    });
    expect(words.givesBackOneOfArgument).toContainEqual({
      base: "DeclarativeBase",
      method: "query",
      argument: 0,
    });
    expect(words.givesBackOneOfImport).toEqual([
      { module: "sqlalchemy", name: "select", argument: 0 },
    ]);
  });

  it("carries its words and class bodies onto a route pack it composes with, and stamps its own build", () => {
    const composed = withSqlalchemy(routePack, { storageSystem: "sqlite" });
    expect(composed.words).toEqual(modelWords(SQLALCHEMY_MODEL_CALLS));
    expect(composed.classBodies).toHaveLength(1);
    expect(composed.version).toBeUndefined();
    expect(sqlalchemyFramework({ storageSystem: "sqlite" }).version).toBe(
      PACK_VERSION,
    );
  });
});

describe("the chains on a session and a query", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-sqlalchemy-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(relPath: string, lines: readonly string[]): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${lines.join("\n")}\n`);
  }

  /** Each storage access the units called `unit` record, as kind, operation, fields, selector and container. */
  async function accessesIn(unit: string): Promise<unknown[]> {
    const { summaries } = await extractPythonProject({
      files: [...findPythonFiles(tmpDir)],
      packs: [sqlalchemyFramework({ storageSystem: "postgresql" })],
      roots: [tmpDir],
      modules: [{ name: "app", root: path.join(tmpDir, "app") }],
      workspaceRoot: tmpDir,
      cacheDir: null,
    });
    return summaries
      .filter((summary) => summary.identity.name.endsWith(unit))
      .flatMap((summary) => summary.transitions)
      .flatMap((transition) => transition.effects)
      .flatMap((effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "storage-access" &&
        effect.binding?.semantics.name === "storage"
          ? [
              [
                effect.interaction.kind,
                effect.interaction.operation,
                effect.interaction.fields,
                effect.interaction.selector ?? [],
                effect.binding.semantics.container,
              ],
            ]
          : [],
      );
  }

  const MODELS = [
    "from sqlalchemy.orm import DeclarativeBase, Query",
    "",
    "class Base(DeclarativeBase):",
    "    @classmethod",
    "    def query(cls) -> Query:",
    "        return session()",
    "",
    "class Order(Base):",
    "    pass",
  ];

  it("reads a query a project method says it returns, from the class it is called on", async () => {
    write("app/models.py", MODELS);
    write("app/__init__.py", [
      "from app.models import Order",
      "",
      "def load(order_id):",
      "    Order.query()",
      "    return Order.query().filter_by(id=order_id).first()",
    ]);

    expect(await accessesIn("load")).toEqual([
      ["read", "first", [], ["id"], "Order"],
    ]);
  });

  const ORDER_SERVICE = [
    "from sqlalchemy.orm import Query, Session",
    "from app.models import Order",
    "",
    "def get_all(*, db_session: Session, scope: str = None) -> Query:",
    "    return db_session.query(Order)",
  ];

  it("takes none of the keywords of a project function that returns a query as columns, and records no read when nothing names the table", async () => {
    write("app/models.py", MODELS);
    write("app/orders/__init__.py", []);
    write("app/orders/service.py", ORDER_SERVICE);
    write("app/__init__.py", [
      "from sqlalchemy.orm import Query, Session",
      "from app.models import Order",
      "from app.orders.service import get_all",
      "",
      "def get_local(*, db_session: Session, scope: str = None) -> Query:",
      "    return db_session.query(Order)",
      "",
      "def list_orders(db):",
      '    get_all(db_session=db, scope="all").all()',
      '    get_local(db_session=db, scope="all").all()',
      '    return get_all(db_session=db, scope="all").select_from(Order).all()',
    ]);

    expect(await accessesIn("list_orders")).toEqual([
      ["read", "all", [], [], "Order"],
    ]);
  });

  it("records no read for a query a function read off an imported module returns, when nothing names the table", async () => {
    write("app/models.py", MODELS);
    write("app/orders/__init__.py", []);
    write("app/orders/service.py", ORDER_SERVICE);
    write("app/__init__.py", [
      "from app.orders import service as order_service",
      "",
      "def list_orders(db):",
      '    return order_service.get_all(db_session=db, scope="all").all()',
    ]);

    expect(await accessesIn("list_orders")).toEqual([]);
  });

  it("reads a query a project method returns when it ends with a method a session records nothing for", async () => {
    write("app/models.py", MODELS);
    write("app/__init__.py", [
      "from app.models import Order",
      "",
      "def total():",
      "    return Order.query().scalar()",
    ]);

    expect(await accessesIn("total")).toEqual([
      ["read", "scalar", [], [], "Order"],
    ]);
  });

  it("reads each chain on a session once, the writes it lists and every other method as a read", async () => {
    write("app/models.py", MODELS);
    write("app/__init__.py", [
      "from sqlalchemy import func",
      "from sqlalchemy.orm import Session",
      "from app.models import Order",
      "",
      "def place(db: Session, order: Order, state):",
      "    db.add(order)",
      "    db.commit()",
      "    db.query(func.count(Order.id)).filter(Order.state == state).scalar()",
      "    db.execute(stmt).scalars().all()",
      "    db.close()",
    ]);

    expect(await accessesIn("place")).toEqual([
      ["write", "add", [], [], "Order"],
      ["write", "commit", [], [], null],
      ["read", "scalar", [], ["state"], "Order"],
    ]);
  });

  it("picks rows by each call's keywords and the columns it pins, from the last call back, then by every column compared", async () => {
    write("app/models.py", MODELS);
    write("app/__init__.py", [
      "from sqlalchemy import or_",
      "from sqlalchemy.orm import Session",
      "from app.models import Order",
      "",
      "def find(db: Session, order_id, low):",
      "    return (",
      "        db.query(Order)",
      "        .filter(Order.id == order_id, Order.total > low)",
      "        .filter(or_(Order.state == 'open', Order.state == 'held'))",
      "        .filter_by(owner='me')",
      "        .first()",
      "    )",
    ]);

    expect(await accessesIn("find")).toEqual([
      ["read", "first", [], ["owner", "id", "state", "total"], "Order"],
    ]);
  });

  it("reads a session declared as the class SQLAlchemy defines in its own submodule", async () => {
    write("app/models.py", MODELS);
    write("app/__init__.py", [
      "from sqlalchemy.orm.session import Session",
      "",
      "def save(db: Session):",
      "    db.commit()",
    ]);

    expect(await accessesIn("save")).toEqual([
      ["write", "commit", [], [], null],
    ]);
  });

  it("reads the keywords of a statement's values calls as fields, its first call's first, and picks rows by the other calls after it", async () => {
    write("app/models.py", MODELS);
    write("app/__init__.py", [
      "from sqlalchemy import Update",
      "from app.models import Order",
      "",
      "def close(stmt: Update, order_id):",
      "    stmt.values(state='closed').select_from(Order).values(note='x').filter_by(id=order_id)",
    ]);

    expect(await accessesIn("close")).toEqual([
      ["read", "filter_by", ["state", "note"], ["id"], "Order"],
    ]);
  });

  it("takes none of a statement's first call's keywords as columns when it supplies no values, and records no read when nothing names the table", async () => {
    write("app/models.py", MODELS);
    write("app/__init__.py", [
      "from sqlalchemy import Update",
      "from app.models import Order",
      "",
      "def close(stmt: Update, tenant, order_id):",
      "    stmt.filter_by(tenant=tenant).filter_by(id=order_id).all()",
      "    stmt.filter_by(tenant=tenant).select_from(Order).filter_by(id=order_id).all()",
    ]);

    expect(await accessesIn("close")).toEqual([
      ["read", "all", [], ["id"], "Order"],
    ]);
  });
});

describe("a config that says no database", () => {
  it("refuses with a sentence instead of a TypeError", () => {
    expect(() => sqlalchemyFramework(undefined as never)).toThrow(
      /storageSystem/,
    );
  });
});
