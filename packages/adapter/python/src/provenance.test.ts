// Where a Python route's values came from, over a whole project run: the
// columns its queries pick rows by and write, and the subjects of its
// guards, written as the value references a TypeScript route gets.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject } from "./project.js";

import type {
  BehavioralSummary,
  ProvenanceEntry,
  ValueRef,
} from "@suss/behavioral-ir";
import type { PythonPack } from "./pack.js";

const fastapiLike: PythonPack = {
  name: "fastapi-test",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET", post: "POST" },
      pathParamSyntax: "braces",
      injectedParameterCallees: ["Depends"],
      responseStatusCalls: [
        { callee: "fastapi.HTTPException", statusKeyword: "status_code" },
      ],
    },
  ],
  storage: [
    {
      module: "sqlalchemy.orm",
      queryTypes: ["Query", "Session"],
      writes: ["update", "delete", "add", "commit"],
      recordsNothing: ["execute", "close"],
      storageSystem: "postgresql",
    },
  ],
};

const flaskLike: PythonPack = {
  name: "flask-test",
  protocol: "http",
  discovery: [
    {
      type: "decoratedClassRoute",
      importModule: ["myapp.restx"],
      decoratorName: "route",
      verbMethodNames: { get: "GET" },
    },
  ],
  requestObjects: [{ module: "flask", name: "request" }],
};

const MODELS = [
  "from sqlalchemy.orm import DeclarativeBase",
  "",
  "class Base(DeclarativeBase):",
  "    pass",
  "",
  "class Order(Base):",
  '    __tablename__ = "orders"',
  "",
].join("\n");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-sources-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): string {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.join("\n"));
  return full;
}

async function unitNamed(
  name: string,
  files: string[],
  packs: PythonPack[],
): Promise<BehavioralSummary> {
  const { summaries } = await extractPythonProject({
    files,
    packs,
    roots: [tmpDir],
    workspaceRoot: tmpDir,
  });
  const found = summaries.find((summary) => summary.identity.name === name);
  if (found === undefined) {
    throw new Error(`no unit ${name}`);
  }
  return found;
}

/** Each slot as `slot name <- sources`, across the unit's transitions. */
function sourcesIn(unit: BehavioralSummary): Record<string, ValueRef[]> {
  const found: Record<string, ValueRef[]> = {};
  for (const entry of unit.transitions.flatMap(
    (transition): ProvenanceEntry[] => transition.provenance ?? [],
  )) {
    found[`${entry.at.slot} ${entry.at.name}`] = entry.from;
  }
  return found;
}

describe("where a FastAPI route's query values came from", () => {
  it("records a parameter, a literal and a helper's own parameter", async () => {
    const route = write("app/routes.py", [
      "from fastapi import Depends, FastAPI, Header, HTTPException",
      "from sqlalchemy.orm import Session",
      "from app.models import Order",
      "",
      "app = FastAPI()",
      "",
      '@app.get("/orders")',
      "def list_orders(x_tenant_id: str = Header(), session: Session = Depends(get_session)):",
      "    if not x_tenant_id:",
      "        raise HTTPException(status_code=401)",
      '    return session.query(Order).filter_by(tenant_id=x_tenant_id, status="open").all()',
      "",
      "def get_session():",
      "    return Session()",
      "",
    ]);
    const models = write("app/models.py", [MODELS]);

    const unit = await unitNamed("list_orders", [route, models], [fastapiLike]);

    expect(sourcesIn(unit)).toEqual({
      "selector status": [{ type: "literal", value: "open" }],
      "selector tenant_id": [
        { type: "input", inputRef: "x_tenant_id", path: [] },
      ],
    });
    expect(unit.transitions.flatMap((t) => t.conditions)[0]).toEqual({
      type: "negation",
      operand: {
        type: "truthinessCheck",
        subject: { type: "input", inputRef: "x_tenant_id", path: [] },
        negated: false,
      },
    });
    expect(unit.inputReads).toEqual([{ input: "x_tenant_id", path: [] }]);
  });

  it("writes a value a builtin converted as converted from the input", async () => {
    const route = write("app/routes.py", [
      "from fastapi import Depends, FastAPI",
      "from sqlalchemy.orm import Session",
      "from app.models import Order",
      "",
      "app = FastAPI()",
      "",
      '@app.get("/orders/{order_id}")',
      "def read_order(order_id: str, session: Session = Depends(get_session)):",
      "    return session.query(Order).filter_by(id=int(order_id)).first()",
      "",
      "def get_session():",
      "    return Session()",
      "",
    ]);
    const models = write("app/models.py", [MODELS]);

    const unit = await unitNamed("read_order", [route, models], [fastapiLike]);

    expect(sourcesIn(unit)).toEqual({
      "selector id": [
        {
          type: "derived",
          derivation: { type: "methodCall", method: "int", args: [] },
          from: { type: "input", inputRef: "order_id", path: [] },
        },
      ],
    });
  });

  it("maps a text() statement's placeholders to the values bound to them", async () => {
    const route = write("app/routes.py", [
      "from fastapi import Depends, FastAPI, Header",
      "from sqlalchemy import text",
      "from sqlalchemy.orm import Session",
      "",
      "app = FastAPI()",
      "",
      '@app.get("/orders")',
      "def list_orders(x_tenant_id: str = Header(), session: Session = Depends(get_session)):",
      "    session.execute(",
      '        text("SELECT id FROM orders WHERE tenant_id = :tenant AND status = :status"),',
      '        {"tenant": x_tenant_id, "status": "open"},',
      "    )",
      '    session.execute(text("UPDATE notes SET body = :body WHERE id = :id").bindparams(body="x", id=x_tenant_id))',
      "    return []",
      "",
      "def get_session():",
      "    return Session()",
      "",
    ]);
    const withText: PythonPack = {
      ...fastapiLike,
      rawSql: [
        {
          module: "sqlalchemy",
          functions: ["text"],
          storageSystem: "postgresql",
        },
      ],
    };

    const unit = await unitNamed("list_orders", [route], [withText]);

    const tenant = { type: "input", inputRef: "x_tenant_id", path: [] };
    expect(sourcesIn(unit)).toEqual({
      "selector tenant_id": [tenant],
      "selector status": [{ type: "literal", value: "open" }],
      "field body": [{ type: "literal", value: "x" }],
      "selector id": [tenant],
    });
  });

  it("maps a ? placeholder to its place in the values handed over", async () => {
    const route = write("app/routes.py", [
      "from fastapi import Depends, FastAPI, Header",
      "from sqlalchemy import text",
      "from sqlalchemy.orm import Session",
      "",
      "app = FastAPI()",
      "",
      '@app.get("/orders")',
      "def list_orders(x_tenant_id: str = Header(), session: Session = Depends(get_session)):",
      '    session.execute(text("SELECT id FROM orders WHERE status = ? AND tenant_id = ?"), ("open", x_tenant_id))',
      "    return []",
      "",
      "def get_session():",
      "    return Session()",
      "",
    ]);
    const withText: PythonPack = {
      ...fastapiLike,
      rawSql: [
        { module: "sqlalchemy", functions: ["text"], storageSystem: "sqlite" },
      ],
    };

    const unit = await unitNamed("list_orders", [route], [withText]);

    expect(sourcesIn(unit)).toEqual({
      "selector status": [{ type: "literal", value: "open" }],
      "selector tenant_id": [
        { type: "input", inputRef: "x_tenant_id", path: [] },
      ],
    });
  });

  it("leaves a conversion alone when the module rebinds the builtin", async () => {
    const route = write("app/routes.py", [
      "from fastapi import Depends, FastAPI",
      "from sqlalchemy.orm import Session",
      "from app.models import Order",
      "from app.ids import int",
      "",
      "app = FastAPI()",
      "",
      '@app.get("/orders/{order_id}")',
      "def read_order(order_id: str, session: Session = Depends(get_session)):",
      "    return session.query(Order).filter_by(id=int(order_id)).first()",
      "",
      "def get_session():",
      "    return Session()",
      "",
    ]);
    const models = write("app/models.py", [MODELS]);

    const unit = await unitNamed("read_order", [route, models], [fastapiLike]);

    expect(sourcesIn(unit)["selector id"]).toEqual([
      { type: "unresolved", sourceText: "int(order_id)" },
    ]);
  });
});

describe("which part of the request a FastAPI parameter is", () => {
  it("reads the part from the call a parameter is declared with, and the field from its name", async () => {
    const route = write("app/routes.py", [
      "from typing import Annotated",
      "from fastapi import Body, Cookie, FastAPI, Header, Query",
      "from app.models import Order",
      "",
      "app = FastAPI()",
      "",
      '@app.post("/orders/{order_id}")',
      "def update_order(",
      "    order_id: int,",
      "    order: Order,",
      '    limit: int = Query(alias="max"),',
      "    x_request_id: Annotated[str, Header()] = None,",
      "    note: str = Body(),",
      "    session_id: str = Cookie(),",
      "    page: int = 1,",
      "):",
      "    return []",
      "",
    ]);
    const models = write("app/models.py", [MODELS]);
    const withSources: PythonPack = {
      ...fastapiLike,
      discovery: fastapiLike.discovery.map((pattern) => ({
        ...pattern,
        annotatedClassIsRequestBody: true,
        parameterSources: {
          Header: { role: "headers", underscoresAs: "-" },
          Query: { role: "queryParams" },
          Body: { role: "requestBody" },
          Cookie: { role: "cookies" },
        },
        parameterAliasKeyword: "alias",
      })),
    };

    const unit = await unitNamed(
      "update_order",
      [route, models],
      [withSources],
    );

    expect(
      unit.inputs.map((input) =>
        input.type === "parameter"
          ? [input.name, input.role, input.field ?? null]
          : null,
      ),
    ).toEqual([
      ["order_id", "pathParams", "order_id"],
      ["order", "requestBody", null],
      ["limit", "queryParams", "max"],
      ["x_request_id", "headers", "x-request-id"],
      ["note", "requestBody", "note"],
      ["session_id", "cookies", "session_id"],
      ["page", "queryParams", "page"],
    ]);
  });
});

describe("where a Flask resource's values came from", () => {
  it("reads a subscript of the request object a pack declares as an input", async () => {
    const restx = write("myapp/restx.py", [
      "def route(path):",
      "    return lambda cls: cls",
      "",
    ]);
    const resource = write("myapp/orders.py", [
      "from flask import request",
      "from myapp.restx import route",
      "",
      '@route("/orders")',
      "class Orders:",
      "    def get(self):",
      '        if request.headers["x-tenant-id"]:',
      "            return []",
      "        return None",
      "",
    ]);

    const unit = await unitNamed("Orders.get", [restx, resource], [flaskLike]);

    expect(unit.transitions.flatMap((t) => t.conditions)[0]).toEqual({
      type: "truthinessCheck",
      subject: {
        type: "input",
        inputRef: "request",
        path: ["headers", "x-tenant-id"],
      },
      negated: false,
    });
  });
});
