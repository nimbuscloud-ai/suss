import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";

import { sqlalchemyFramework } from "./index.js";

/**
 * A project base class that wraps the library, which every model
 * inherits, so the file doing the querying imports neither the base nor
 * anything from SQLAlchemy.
 */
const BASE = [
  "from sqlalchemy.orm import Query",
  "",
  "class Base:",
  "    @classmethod",
  "    def query(cls) -> Query:",
  "        return session()",
];

const MODELS = [
  "from app.base import Base",
  "",
  "class Orders(Base):",
  "    pass",
];

interface Access {
  readonly kind: string;
  readonly operation: string | undefined;
  readonly fields: readonly string[];
  readonly selector: readonly string[] | undefined;
  readonly container: string | null;
  readonly callee: string | undefined;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-sqlalchemy-chains-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, lines: readonly string[]): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

/**
 * The storage accesses `unit` records, with `handler` written as the
 * app's own module beside the base and the models.
 */
async function accessesOf(
  handler: readonly string[],
  options: { base?: readonly string[]; unit?: string } = {},
): Promise<Access[]> {
  write("app/base.py", options.base ?? BASE);
  write("app/models.py", MODELS);
  write("app/__init__.py", ["from app.models import Orders", "", ...handler]);
  const { summaries } = await extractPythonProject({
    files: [...findPythonFiles(tmpDir)],
    packs: [sqlalchemyFramework({ storageSystem: "postgresql" })],
    roots: [tmpDir],
    modules: [{ name: "app", root: path.join(tmpDir, "app") }],
    workspaceRoot: tmpDir,
    cacheDir: null,
  });
  const unit = options.unit ?? "handler";
  return summaries
    .filter((summary) => summary.identity.name.endsWith(unit))
    .flatMap((summary) => summary.transitions)
    .flatMap((transition) => transition.effects)
    .flatMap((effect): Access[] => {
      if (
        effect.type !== "interaction" ||
        effect.interaction.class !== "storage-access" ||
        effect.binding?.semantics.name !== "storage" ||
        effect.binding.recognition !== "python-storage"
      ) {
        return [];
      }
      return [
        {
          kind: effect.interaction.kind,
          operation: effect.interaction.operation,
          fields: effect.interaction.fields,
          selector: effect.interaction.selector,
          container: effect.binding.semantics.container,
          callee: effect.callee,
        },
      ];
    });
}

describe("a query a project method returns", () => {
  it("reads the chain once, at its last call, on the class it is called on", async () => {
    expect(
      await accessesOf([
        "def handler():",
        "    return Orders.query().filter_by(id=1).first()",
      ]),
    ).toEqual([
      {
        kind: "read",
        operation: "first",
        fields: [],
        selector: ["id"],
        container: "Orders",
        callee: "Orders.query().filter_by(id=1).first",
      },
    ]);
  });

  it("says a chain ending in a write is one", async () => {
    expect(
      await accessesOf([
        "def handler():",
        "    Orders.query().filter_by(id=1).delete()",
      ]),
    ).toMatchObject([{ kind: "write", operation: "delete" }]);
  });

  it("takes no column from a keyword the method is given", async () => {
    const base = [...BASE];
    base[4] = "    def query(cls, *, scope=None) -> Query:";
    expect(
      await accessesOf(
        ["def handler():", '    return Orders.query(scope="all").first()'],
        { base },
      ),
    ).toMatchObject([{ operation: "first", fields: [] }]);
  });

  it("reads one whose file imports the type from a module inside the library's", async () => {
    const base = [...BASE];
    base[0] = "from sqlalchemy.orm.query import Query";
    expect(
      await accessesOf(
        ["def handler():", "    return Orders.query().first()"],
        {
          base,
        },
      ),
    ).toMatchObject([{ kind: "read", operation: "first" }]);
  });

  it("says nothing about a method that returns something else", async () => {
    const base = [...BASE];
    base[4] = "    def query(cls) -> Report:";
    expect(
      await accessesOf(
        ["def handler():", "    return Orders.query().first()"],
        {
          base,
        },
      ),
    ).toEqual([]);
  });

  it("says nothing about a method that says nothing about what it returns", async () => {
    const base = [...BASE];
    base[4] = "    def query(cls):";
    expect(
      await accessesOf(
        ["def handler():", "    return Orders.query().first()"],
        {
          base,
        },
      ),
    ).toEqual([]);
  });

  it("says nothing when the method's file never imports the library", async () => {
    expect(
      await accessesOf(
        ["def handler():", "    return Orders.query().first()"],
        {
          base: BASE.slice(2),
        },
      ),
    ).toEqual([]);
  });

  it("leaves the work a called function does to that function's own summary", async () => {
    expect(
      await accessesOf([
        "def load_orders():",
        "    return Orders.query().filter_by(id=1).first()",
        "",
        "def handler():",
        "    return load_orders()",
      ]),
    ).toEqual([]);
  });
});

describe("a statement built with a function the file imports", () => {
  it("reads the columns it selects off its model", async () => {
    expect(
      await accessesOf([
        "from sqlalchemy import select",
        "",
        "def handler(token):",
        "    select(User.email, User.id).where(User.id == 1).all()",
        "    select(User.id, Group.name, token.sub).all()",
        "    select(User.id, whole=User.email).all()",
        "    select(User).all()",
      ]),
    ).toMatchObject([
      { operation: "select", fields: ["email", "id"], container: "User" },
      { operation: "select", fields: ["id"] },
      { operation: "select", fields: ["id"] },
      { operation: "select", fields: [] },
    ]);
  });

  it("says a statement function is the write it is named for, whatever it ends with", async () => {
    const found = await accessesOf([
      "from sqlalchemy import delete, insert, update",
      "",
      "def handler():",
      "    update(Orders).where(Orders.id == 1).values(total=2)",
      "    delete(Orders).where(Orders.id == 1)",
      "    insert(Orders).values(id=1, total=3)",
    ]);
    expect(found).toMatchObject([
      {
        kind: "write",
        operation: "update",
        fields: ["total"],
        selector: ["id"],
      },
      { kind: "write", operation: "delete", fields: [] },
      { kind: "write", operation: "insert", fields: ["id", "total"] },
    ]);
  });

  it("reads a function another module re-exports, or a module inside the library's exports", async () => {
    expect(
      await accessesOf(
        [
          "from app.base import select",
          "from sqlalchemy.sql import select as sql_select",
          "",
          "def handler():",
          "    select(User.id).all()",
          "    sql_select(User.id).where(User.id == 1)",
        ],
        { base: ["from sqlalchemy import select"] },
      ),
    ).toMatchObject([
      { kind: "read", operation: "select", fields: ["id"] },
      { kind: "read", operation: "select" },
    ]);
  });

  it("says nothing about a function of the same name from somewhere else, or one the file declares", async () => {
    expect(
      await accessesOf([
        "from myapp.helpers import select",
        "",
        "def handler(a):",
        "    return select(a).all()",
      ]),
    ).toEqual([]);
    expect(
      await accessesOf([
        "def select(*columns):",
        "    return build()",
        "",
        "def handler():",
        "    return select(User.id).all()",
      ]),
    ).toEqual([]);
  });

  it("leaves a statement a called function builds to that function", async () => {
    expect(
      await accessesOf([
        "from sqlalchemy import select",
        "",
        "def load_orders():",
        "    return select(User.id).all()",
        "",
        "def handler():",
        "    return load_orders()",
      ]),
    ).toEqual([]);
  });

  it("records no read whose table nothing names, and keeps a write that has none", async () => {
    expect(
      await accessesOf([
        "from sqlalchemy import func, select, update",
        "",
        "def handler(table):",
        "    select(func.count()).all()",
        "    update(table).values(name=1)",
      ]),
    ).toMatchObject([
      { kind: "write", operation: "update", fields: ["name"], container: null },
    ]);
  });
});

describe("the rows a chain picks", () => {
  it("picks rows by a model column compared in where, filter or and_", async () => {
    const found = await accessesOf([
      "from sqlalchemy import and_, select",
      "",
      "def handler(tenant, status, other):",
      "    select(Orders).where(Orders.tenant_id == tenant)",
      "    select(Orders).where(and_(status == Orders.status, Orders.kind == 'a'))",
      "    select(Orders).where(Orders.total > 3, tenant.id == other)",
    ]);
    expect(found.map((one) => one.selector)).toEqual([
      ["tenant_id"],
      ["status", "kind"],
      ["total"],
    ]);
  });

  it("picks rows by the calls along the chain, and by none written inside an argument", async () => {
    const found = await accessesOf([
      "from datetime import timedelta",
      "from sqlalchemy import select",
      "",
      "def handler(now, window, t):",
      "    select(Orders).where(Orders.placed_at >= now - timedelta(hours=window))",
      "    select(Orders).where(Orders.id.in_(select(Users.id).where(Users.tenant_id == t)))",
    ]);
    expect(found.map((one) => one.selector)).toEqual([
      ["placed_at"],
      undefined,
      ["tenant_id"],
    ]);
  });

  it("picks rows by an equality on another class's column only when it is the chain's model", async () => {
    const found = await accessesOf([
      "from sqlalchemy import select",
      "",
      "def handler(k, s):",
      "    select(Orders).join(Users).where(Users.kind == k, Orders.state == s)",
    ]);
    expect(found.map((one) => one.selector)).toEqual([["state"]]);
  });

  it("picks rows by its own model's column however a filter compares it", async () => {
    const found = await accessesOf([
      "from sqlalchemy import or_, select",
      "",
      "def handler(now, cutoff):",
      "    Orders.query().filter(Orders.expires >= now).delete()",
      "    select(Orders).where(or_(Orders.closed_at < cutoff, Orders.status != 'open'))",
      "    select(Orders).where(Users.created_at > cutoff)",
    ]);
    expect(found.map((one) => one.selector)).toEqual([
      ["expires"],
      ["closed_at", "status"],
      undefined,
    ]);
  });
});

describe("a session typed the way a project writes it", () => {
  it("reads a session taken as an annotated parameter, the class from a module inside the library's included", async () => {
    expect(
      await accessesOf([
        "from sqlalchemy.orm import Session",
        "from sqlalchemy.orm.session import Session as InnerSession",
        "",
        "def handler(db: Session, inner: InnerSession):",
        "    db.add(Orders())",
        "    inner.commit()",
        "    return db.query(Orders).filter_by(id=1).first()",
      ]),
    ).toMatchObject([
      { kind: "write", operation: "add" },
      { kind: "write", operation: "commit" },
      { kind: "read", operation: "first", selector: ["id"] },
    ]);
  });

  it("says nothing about a session from a package whose name only starts with the library's, or of a project class", async () => {
    expect(
      await accessesOf([
        "from sqlalchemy_utils import Session",
        "",
        "class Store:",
        "    pass",
        "",
        "def handler(db: Session, store: Store):",
        "    db.commit()",
        "    store.add(Orders())",
      ]),
    ).toEqual([]);
  });

  it("reads a session through an Annotated alias another module exports, or one in the same module", async () => {
    expect(
      await accessesOf(
        [
          "from typing import Annotated",
          "from fastapi import Depends",
          "from sqlalchemy.orm import Session",
          "from app.base import SessionDep",
          "",
          "LocalDep = Annotated[Session, Depends(get_db)]",
          "",
          "def handler(db: SessionDep, local: LocalDep):",
          "    db.add(Orders())",
          "    local.commit()",
        ],
        {
          base: [
            "from typing import Annotated",
            "from fastapi import Depends",
            "from sqlalchemy.orm import Session",
            "",
            "def get_db():",
            "    yield Session()",
            "",
            "SessionDep = Annotated[Session, Depends(get_db)]",
          ],
        },
      ),
    ).toMatchObject([
      { kind: "write", operation: "add" },
      { kind: "write", operation: "commit" },
    ]);
  });

  it("reads a session the body builds, opens, or gives another name", async () => {
    expect(
      await accessesOf([
        "from sqlalchemy.orm import Session",
        "",
        "def handler():",
        "    session = Session()",
        "    session.add(Orders())",
        "    with Session() as opened:",
        "        opened.commit()",
        "    alias = session",
        "    alias.flush()",
      ]),
    ).toMatchObject([
      { operation: "add" },
      { operation: "commit" },
      { operation: "flush" },
    ]);
  });

  it("reads a session a project function builds, whether or not it says it returns one, and records nothing for the call that only returns it", async () => {
    expect(
      await accessesOf(
        [
          "from app.base import open_session, typed_session",
          "",
          "def handler():",
          "    db = open_session()",
          "    db.add(Orders())",
          "    typed_session().commit()",
          "    typed_session()",
        ],
        {
          base: [
            "from sqlalchemy.orm import Session",
            "",
            "def open_session():",
            "    return Session()",
            "",
            "def typed_session() -> Session:",
            "    return Session()",
          ],
        },
      ),
    ).toMatchObject([
      { kind: "write", operation: "add" },
      { kind: "write", operation: "commit" },
    ]);
  });

  it("records nothing for a session method the pack says touches no rows", async () => {
    expect(
      await accessesOf([
        "from sqlalchemy import select",
        "from sqlalchemy.orm import Session",
        "",
        "def handler(db: Session):",
        "    found = db.execute(select(Orders.id)).all()",
        "    db.close()",
        "    return found",
      ]),
    ).toMatchObject([{ kind: "read", operation: "select", fields: ["id"] }]);
  });

  it("reads the session type through a forward reference, Annotated and Optional, but not inside a list", async () => {
    expect(
      await accessesOf([
        "from typing import Annotated, Optional",
        "from sqlalchemy.orm import Session",
        "",
        'def handler(db: "Session", other: Annotated[Session, 1], third: Optional[Session], fourth: list[Session]):',
        "    db.add(Orders())",
        "    other.add(Orders())",
        "    third.add(Orders())",
        "    fourth.add(Orders())",
      ]),
    ).toMatchObject([
      { operation: "add" },
      { operation: "add" },
      { operation: "add" },
    ]);
  });
});

describe("the model a chain is charged to", () => {
  // A summary keeps one of two accesses that differ only in where they
  // are, so the second and third `db.add` to `Orders` do not show.
  it("charges each session call to the model it works on, and commit to none", async () => {
    const found = await accessesOf([
      "from sqlalchemy.orm import Session",
      "",
      "def handler(db: Session, order: Orders, order_id: int, data: dict):",
      "    db.add(order)",
      "    db.add(Orders(id=2))",
      "    db.commit()",
      "    found = db.get(Orders, order_id)",
      "    db.refresh(found)",
      "    built = Orders.model_validate(data)",
      "    db.add(built)",
      "    fetched = load_order(order_id)",
      "    db.add(fetched)",
      "    return db.query(Orders).filter_by(id=1).first()",
    ]);
    expect(found.map((one) => [one.operation, one.container])).toEqual([
      ["add", "Orders"],
      ["commit", null],
      ["get", "Orders"],
      ["refresh", "Orders"],
      ["add", null],
      ["first", "Orders"],
    ]);
  });

  it("charges a call on a parameter declared through an Annotated alias to the class behind it", async () => {
    const found = await accessesOf(
      [
        "from typing import Annotated",
        "from fastapi import Depends",
        "from sqlalchemy.orm import Session",
        "from app.base import CurrentOrder",
        "",
        "LocalOrder = Annotated[Orders, Depends(get_order)]",
        "",
        "def handler(db: Session, order: CurrentOrder, other: LocalOrder):",
        "    db.add(order)",
        "    db.refresh(order)",
        "    db.delete(other)",
      ],
      {
        base: [
          "from typing import Annotated",
          "from fastapi import Depends",
          "from app.models import Orders",
          "",
          "def get_order():",
          "    return Orders()",
          "",
          "CurrentOrder = Annotated[Orders, Depends(get_order)]",
        ],
      },
    );
    expect(found.map((one) => one.container)).toEqual([
      "Orders",
      "Orders",
      "Orders",
    ]);
  });

  it("charges a call on a local a project function returned to what that function says it returns", async () => {
    const found = await accessesOf(
      [
        "from sqlalchemy.orm import Session",
        "from app.base import load_order",
        "",
        "def handler(db: Session, order_id: int):",
        "    found = load_order(db, order_id)",
        "    db.add(found)",
        "    missing = unknown(order_id)",
        "    db.add(missing)",
      ],
      {
        base: [
          "from app.models import Orders",
          "",
          "def load_order(db, order_id: int) -> Orders | None:",
          "    return db.get(Orders, order_id)",
        ],
      },
    );
    expect(found.map((one) => one.container)).toEqual(["Orders", null]);
  });

  it("charges a statement to the model in its first argument, or to the table it selects from", async () => {
    const found = await accessesOf([
      "from sqlalchemy import func, select",
      "import app.models as models",
      "",
      "def handler(text):",
      "    select(Orders).where(Orders.id == 1)",
      "    select(Orders.id, Orders.total)",
      "    select(models.Orders.id)",
      "    select(func.count()).select_from(Orders)",
      "    select(func.count(Orders.id))",
      "    select(text)",
    ]);
    expect(found.map((one) => one.container)).toEqual([
      "Orders",
      "Orders",
      "Orders",
      "Orders",
      "Orders",
    ]);
  });

  it("charges nothing to a statement or a column declared as one of the library's own types, so it records no read", async () => {
    expect(
      await accessesOf([
        "from sqlalchemy import ColumnElement, Select, func, select",
        "",
        "def handler(query: Select, column: ColumnElement):",
        "    select(func.count()).select_from(query.order_by(None).subquery())",
        "    return query.order_by(column)",
      ]),
    ).toEqual([]);
  });
});

/** A helper that takes its session bare, for the callers in the base to hand one to. */
const LOOKUP = [
  "def handler(*, db, order_id):",
  "    return db.query(Orders).filter_by(id=order_id).first()",
  "",
  "def handler_at(db, order_id):",
  "    return db.query(Orders).filter_by(id=order_id).first()",
];

/** The operations the helper records once these callers are in the run. */
async function lookupOperations(
  callers: readonly string[],
  unit = "handler",
): Promise<(string | undefined)[]> {
  const found = await accessesOf(LOOKUP, { base: callers, unit });
  return found.map((one) => one.operation);
}

describe("a session the callers declare", () => {
  it("reads a session every caller passes by keyword as a Session", async () => {
    expect(
      await lookupOperations([
        "from sqlalchemy.orm import Session",
        "from app import handler",
        "",
        "def read_order(db: Session, order_id: int):",
        "    return handler(db=db, order_id=order_id)",
      ]),
    ).toEqual(["first"]);
  });

  it("reads a session a caller passes by position", async () => {
    expect(
      await lookupOperations(
        [
          "from sqlalchemy.orm import Session",
          "from app import handler_at",
          "",
          "def read_order(session: Session):",
          "    return handler_at(session, 1)",
        ],
        "handler_at",
      ),
    ).toEqual(["first"]);
  });

  it("reads a session one caller declares through an Annotated alias and another as Session", async () => {
    expect(
      await lookupOperations([
        "from typing import Annotated",
        "from fastapi import Depends",
        "from sqlalchemy.orm import Session",
        "from app import handler",
        "",
        "SessionDep = Annotated[Session, Depends(get_db)]",
        "",
        "def read_order(db: SessionDep):",
        "    return handler(db=db, order_id=1)",
        "",
        "def sync_order(session: Session):",
        "    return handler(db=session, order_id=2)",
      ]),
    ).toEqual(["first"]);
  });

  it("reads a session handed down through two helpers that take it bare", async () => {
    expect(
      await lookupOperations([
        "from sqlalchemy.orm import Session",
        "from app import handler",
        "",
        "def load(*, db, order_id):",
        "    return handler(db=db, order_id=order_id)",
        "",
        "def fetch(db, order_id):",
        "    return load(db=db, order_id=order_id)",
        "",
        "def read_order(db: Session):",
        "    return fetch(db, 1)",
      ]),
    ).toEqual(["first"]);
  });

  it("reads nothing when two callers declare different classes", async () => {
    expect(
      await lookupOperations([
        "from sqlalchemy.orm import Session",
        "from redis import Redis",
        "from app import handler",
        "",
        "def read_order(db: Session):",
        "    return handler(db=db, order_id=1)",
        "",
        "def cached_order(db: Redis):",
        "    return handler(db=db, order_id=1)",
      ]),
    ).toEqual([]);
  });

  it("reads nothing when a caller passes a value nothing declares", async () => {
    expect(
      await lookupOperations([
        "from sqlalchemy.orm import Session",
        "from app import handler",
        "",
        "def read_order(db: Session):",
        "    return handler(db=db, order_id=1)",
        "",
        "def job(context):",
        "    return handler(db=context.db, order_id=1)",
      ]),
    ).toEqual([]);
  });

  it("reads nothing when no caller is in the run", async () => {
    expect(await lookupOperations([""])).toEqual([]);
  });
});
