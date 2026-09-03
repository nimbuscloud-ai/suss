import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summaryIdentifier } from "@suss/behavioral-ir";

import { extractPythonProject, findPythonFiles } from "../project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PythonPack } from "../pack.js";

const fastapiLike: PythonPack = {
  name: "fastapi",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET", post: "POST" },
      pathParamSyntax: "braces",
      defaultStatusCode: 200,
    },
  ],
  storage: [
    {
      module: "sqlalchemy",
      queryTypes: ["Select"],
      writes: ["update", "delete"],
      queryFunctions: ["select"],
      storageSystem: "postgresql",
    },
  ],
};

const APP_HEADER = ["from fastapi import FastAPI", "", "app = FastAPI()", ""];

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-reach-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

async function extract(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(tmpDir),
    packs: [fastapiLike],
    roots: [tmpDir],
    workspaceRoot: tmpDir,
  });
  return summaries;
}

function unitNamed(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const found = summaries.find((summary) => summary.identity.name === name);
  if (found === undefined) {
    throw new Error(`no summary is named ${name}`);
  }
  return found;
}

function calls(
  summary: BehavioralSummary,
): Array<[string, string | undefined]> {
  return summary.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "invocation"
        ? [[effect.callee, effect.summary] as [string, string | undefined]]
        : [],
    ),
  );
}

describe("the functions a route reaches", () => {
  it("gives a helper the route calls a library summary and links the call to it", async () => {
    write("app/store.py", ["def read_orders():", "    return fetch_all()"]);
    write("app/main.py", [
      ...APP_HEADER,
      "from app.store import read_orders",
      "",
      '@app.get("/orders")',
      "def list_orders():",
      "    return read_orders()",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "read_orders");
    expect(helper.kind).toBe("library");
    expect(helper.location.file).toBe("app/store.py");
    expect(helper.identity.exportPath).toEqual(["read_orders"]);
    expect(helper.identity.boundaryBinding).toMatchObject({
      transport: "in-process",
      semantics: { name: "function-call" },
      recognition: "reachable",
    });

    const route = unitNamed(summaries, "list_orders");
    expect(calls(route)).toEqual([["read_orders", summaryIdentifier(helper)]]);
    expect(
      calls(route).every(([, id]) => id === "app/store.py::read_orders"),
    ).toBe(true);
  });

  it("follows a helper into the helper it calls", async () => {
    write("app/store.py", [
      "from sqlalchemy import select",
      "",
      "def read_orders():",
      "    return select(Orders.id).all()",
    ]);
    write("app/service.py", [
      "from app import store",
      "",
      "def orders_for(user):",
      "    return store.read_orders()",
    ]);
    write("app/main.py", [
      ...APP_HEADER,
      "from app.service import orders_for",
      "",
      '@app.get("/orders")',
      "def list_orders():",
      "    return orders_for(1)",
    ]);

    const summaries = await extract();
    const service = unitNamed(summaries, "orders_for");
    const store = unitNamed(summaries, "read_orders");
    expect(service.kind).toBe("library");
    expect(store.kind).toBe("library");
    expect(calls(unitNamed(summaries, "list_orders"))).toEqual([
      ["orders_for", summaryIdentifier(service)],
    ]);
    expect(calls(service)).toEqual([
      ["store.read_orders", summaryIdentifier(store)],
    ]);

    const storage = store.transitions.flatMap((transition) =>
      transition.effects.filter(
        (effect) =>
          effect.type === "interaction" &&
          effect.interaction.class === "storage-access",
      ),
    );
    expect(storage).toHaveLength(1);
  });

  it("leaves a name two wildcard imports could each define as an unfollowed call", async () => {
    write("app/first.py", ["def load():", "    return 1"]);
    write("app/second.py", ["def load():", "    return 2"]);
    write("app/main.py", [
      ...APP_HEADER,
      "from app.first import *",
      "from app.second import *",
      "",
      '@app.get("/things")',
      "def list_things():",
      "    return load()",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const route = unitNamed(summaries, "list_things");
    expect(calls(route)).toEqual([["load", undefined]]);
    expect(route.gaps).toContainEqual(
      expect.objectContaining({
        type: "unfollowedCall",
        callee: "load",
        description: expect.stringContaining("more than one possible source"),
      }),
    );
  });

  it("records a call to a method on the route's own class through self", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "class Orders:",
      "    def total(self):",
      "        return tally()",
      "",
      "    @app.get('/orders/total')",
      "    def show(self):",
      "        return self.total()",
    ]);

    const summaries = await extract();
    const method = unitNamed(summaries, "total");
    expect(method.identity.exportPath).toEqual(["Orders", "total"]);
    expect(method.inputs).toEqual([]);
    expect(calls(unitNamed(summaries, "show"))).toEqual([
      ["self.total", summaryIdentifier(method)],
    ]);
  });

  it("stops at a call on a parameter and on a name a loop rebinds, saying which", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def step():",
      "    return 1",
      "",
      '@app.get("/run")',
      "def run(callback):",
      "    for step in callbacks:",
      "        step()",
      "    callback()",
    ]);

    const summaries = await extract();
    const route = unitNamed(summaries, "run");
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    expect(calls(route)).toEqual([
      ["step", undefined],
      ["callback", undefined],
    ]);
    expect(route.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual([
      expect.objectContaining({ callee: "step" }),
      expect.objectContaining({ callee: "callback" }),
    ]);
  });

  it("reaches a function passed by name to a helper that calls it through a parameter", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def build_index():",
      "    return 1",
      "",
      "def register(handler):",
      "    handler()",
      "",
      '@app.get("/run")',
      "def run():",
      "    register(build_index)",
    ]);

    const summaries = await extract();
    const buildIndex = unitNamed(summaries, "build_index");
    expect(buildIndex.kind).toBe("library");

    const run = unitNamed(summaries, "run");
    const passing = run.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "register");
    expect(
      passing?.type === "invocation" ? passing.argsSummary : undefined,
    ).toEqual({ "0": buildIndex.identity.id });

    const register = unitNamed(summaries, "register");
    const called = register.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "handler");
    expect(
      called?.type === "invocation" ? called.calleeParameter : undefined,
    ).toBe(0);
    expect(
      register.gaps.filter(
        (gap) => gap.type === "unfollowedCall" && gap.callee === "handler",
      ),
    ).toHaveLength(0);
  });

  it("leaves an argument passed into an unresolved callee harmless", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def double(x):",
      "    return x * 2",
      "",
      '@app.get("/run")',
      "def run(items):",
      "    return list(map(double, items))",
    ]);

    const summaries = await extract();
    const doubled = unitNamed(summaries, "double");
    expect(doubled.kind).toBe("library");

    const run = unitNamed(summaries, "run");
    const mapCall = run.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "map");
    expect(
      mapCall?.type === "invocation" ? mapCall.argsSummary : undefined,
    ).toEqual({ "0": doubled.identity.id });
    expect(mapCall?.type === "invocation" ? mapCall.summary : undefined).toBe(
      undefined,
    );
  });

  it("leaves a variable bound to a function out of the passed-by-name join", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def build_index():",
      "    return 1",
      "",
      "def register(handler):",
      "    handler()",
      "",
      '@app.get("/run")',
      "def run():",
      "    alias = build_index",
      "    register(alias)",
    ]);

    const summaries = await extract();
    expect(
      summaries.filter((summary) => summary.identity.name === "alias"),
    ).toEqual([]);
    const run = unitNamed(summaries, "run");
    const passing = run.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "register");
    expect(
      passing?.type === "invocation" ? passing.argsSummary : undefined,
    ).toBeUndefined();
  });

  it("leaves a name a loop rebinds out of the passed-by-name join", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def register(handler):",
      "    handler()",
      "",
      '@app.get("/run")',
      "def run(handlers):",
      "    for handler in handlers:",
      "        register(handler)",
    ]);

    const summaries = await extract();
    const run = unitNamed(summaries, "run");
    const passing = run.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "register");
    expect(
      passing?.type === "invocation" ? passing.argsSummary : undefined,
    ).toBeUndefined();
  });

  it("drops an argument position resolved to two different declarations", async () => {
    write("app/first.py", ["def build_index():", "    return 1"]);
    write("app/second.py", ["def build_index():", "    return 2"]);
    write("app/main.py", [
      ...APP_HEADER,
      "from app.first import build_index",
      "",
      "def register(handler):",
      "    handler()",
      "",
      '@app.get("/both")',
      "def both():",
      "    class Fallback:",
      "        from app.second import build_index",
      "        register(build_index)",
      "    register(build_index)",
    ]);

    const summaries = await extract();
    const route = unitNamed(summaries, "both");
    expect(
      summaries.filter((summary) => summary.identity.name === "build_index"),
    ).toHaveLength(2);
    const passing = route.transitions
      .flatMap((t) => t.effects)
      .find((e) => e.type === "invocation" && e.callee === "register");
    expect(
      passing?.type === "invocation" ? passing.argsSummary : undefined,
    ).toBeUndefined();
  });

  it("gaps a call through a parameter nothing here passes a function into", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def apply(handler):",
      "    handler()",
      "",
      '@app.get("/run")',
      "def run():",
      "    apply(lambda: 1)",
    ]);

    const summaries = await extract();
    const apply = unitNamed(summaries, "apply");
    const gap = apply.gaps.find(
      (g) => g.type === "unfollowedCall" && g.callee === "handler",
    );
    expect(gap).toBeDefined();
    expect(gap?.description).toContain(
      "no caller in this run passes it a function by name",
    );
  });

  it("keeps a nested def and a lambda inside the body apart from the names outside", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def helper():",
      "    return 1",
      "",
      '@app.get("/nested")',
      "def outer():",
      "    def inner():",
      "        return helper()",
      "    run = lambda helper: helper()",
      "    return inner(), run(helper)",
    ]);

    const summaries = await extract();
    const route = unitNamed(summaries, "outer");
    const inner = unitNamed(summaries, "inner");
    const helper = unitNamed(summaries, "helper");
    expect(inner.kind).toBe("library");
    expect(calls(route)).toEqual([
      ["helper", undefined],
      ["inner", summaryIdentifier(inner)],
      ["run", undefined],
    ]);
    expect(calls(inner)).toEqual([["helper", summaryIdentifier(helper)]]);
    expect(
      route.gaps
        .filter((gap) => gap.type === "unfollowedCall")
        .map((gap) => gap.callee),
    ).toEqual(["helper", "run"]);
  });

  it("links nothing when one callee spelling lands on two definitions", async () => {
    write("app/first.py", ["def load():", "    return 1"]);
    write("app/other.py", ["def load():", "    return 2"]);
    write("app/main.py", [
      ...APP_HEADER,
      "from app.first import load",
      "",
      '@app.get("/both")',
      "def both():",
      "    class Fallback:",
      "        from app.other import load",
      "        value = load()",
      "    return load() + Fallback.value",
    ]);

    const summaries = await extract();
    const route = unitNamed(summaries, "both");
    expect(
      summaries.filter((summary) => summary.identity.name === "load"),
    ).toHaveLength(2);
    expect(calls(route)).toEqual([
      ["load", undefined],
      ["load", undefined],
    ]);
  });

  it("lists a reached function's parameters by position, whatever their spelling", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def helper(user, /, limit: int, offset=0, *, order, *rest, **extra):",
      "    return user",
      "",
      "class Service:",
      "    def __init__(self, dsn: str):",
      "        self.dsn = dsn",
      "",
      '@app.get("/params")',
      "def params():",
      "    return helper(1, 2), Service('x')",
    ]);

    const summaries = await extract();
    const parameterNames = (summary: BehavioralSummary) =>
      summary.inputs.flatMap((input) =>
        input.type === "parameter" ? [input.name] : [],
      );
    expect(parameterNames(unitNamed(summaries, "helper"))).toEqual([
      "user",
      "limit",
      "offset",
      "order",
      "rest",
      "extra",
    ]);
    const init = unitNamed(summaries, "__init__");
    expect(init.identity.exportPath).toEqual(["Service", "__init__"]);
    expect(parameterNames(init)).toEqual(["dsn"]);
    expect(calls(unitNamed(summaries, "params"))).toEqual([
      ["helper", "app/main.py::helper"],
      ["Service", summaryIdentifier(init)],
    ]);
  });

  it("mints one summary for a helper two routes both reach", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def shared():",
      "    return 1",
      "",
      '@app.get("/a")',
      "def a():",
      "    return shared()",
      "",
      '@app.get("/b")',
      "def b():",
      "    return shared()",
    ]);

    const summaries = await extract();
    expect(
      summaries.filter((summary) => summary.identity.name === "shared"),
    ).toHaveLength(1);
  });

  it("links the calls of a function registered on two paths on both of its summaries", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def shared():",
      "    return 1",
      "",
      '@app.get("/a")',
      '@app.get("/b")',
      "def either():",
      "    return shared()",
    ]);

    const summaries = await extract();
    const shared = unitNamed(summaries, "shared");
    const routes = summaries.filter(
      (summary) => summary.identity.name === "either",
    );
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(calls(route)).toEqual([["shared", summaryIdentifier(shared)]]);
    }
  });
});

describe("the spellings a callee can have", () => {
  it("follows a class call to its __init__ and a method called on a new or a kept instance", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "class Service:",
      "    def __init__(self):",
      "        self.ready = True",
      "",
      "    def run(self):",
      "        return 1",
      "",
      "    def missing_target(self):",
      "        return self.absent()",
      "",
      '@app.get("/svc")',
      "def svc():",
      "    kept = Service()",
      "    Service().run()",
      "    kept.run()",
      "    kept.missing_target()",
      "    return run.cache_clear()",
    ]);

    const summaries = await extract();
    const init = unitNamed(summaries, "__init__");
    const run = unitNamed(summaries, "run");
    const missing = unitNamed(summaries, "missing_target");
    expect(calls(unitNamed(summaries, "svc"))).toEqual([
      ["Service", summaryIdentifier(init)],
      ["Service", summaryIdentifier(init)],
      ["Service().run", summaryIdentifier(run)],
      ["kept.run", summaryIdentifier(run)],
      ["kept.missing_target", summaryIdentifier(missing)],
      ["run.cache_clear", undefined],
    ]);
    expect(calls(missing)).toEqual([["self.absent", undefined]]);
  });

  it("follows an alias, a parenthesized name, and a class attribute that points at a function", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def load():",
      "    return 1",
      "",
      "class Handlers:",
      "    on_get = load",
      "",
      "run = load",
      "counter = 0",
      "",
      '@app.get("/alias")',
      "def alias():",
      "    global counter",
      "    kept = load",
      "    named = Handlers.on_get",
      "    typed: Handlers",
      "    again = counter",
      "    if counter:",
      "        later = load",
      "    run(), (load)(), Handlers.on_get(), counter(), kept(), named()",
      "    return later(), typed.on_get(), again(), load.cache_clear()",
    ]);

    const summaries = await extract();
    const load = unitNamed(summaries, "load");
    expect(calls(unitNamed(summaries, "alias"))).toEqual([
      ["run", summaryIdentifier(load)],
      ["(load)", summaryIdentifier(load)],
      ["Handlers.on_get", summaryIdentifier(load)],
      ["counter", undefined],
      ["kept", summaryIdentifier(load)],
      ["named", summaryIdentifier(load)],
      ["later", undefined],
      ["typed.on_get", undefined],
      ["again", undefined],
      ["load.cache_clear", undefined],
    ]);
  });

  it("reaches out from a route registered inside a block the binder never entered", async () => {
    write("app/main.py", [
      ...APP_HEADER,
      "def helper():",
      "    return 1",
      "",
      "if app:",
      '    @app.get("/guarded")',
      "    def guarded():",
      "        return helper()",
    ]);

    const summaries = await extract();
    const helper = unitNamed(summaries, "helper");
    expect(calls(unitNamed(summaries, "guarded"))).toEqual([
      ["helper", summaryIdentifier(helper)],
    ]);
  });

  it("follows a module imported whole, by its dotted name or an alias, and stops at calling the module itself", async () => {
    write("app/store/__init__.py", [""]);
    write("app/store/orders.py", ["def read():", "    return 1"]);
    write("app/main.py", [
      ...APP_HEADER,
      "import app.store.orders",
      "import app.store.orders as orders",
      "from app import store",
      "",
      '@app.get("/orders")',
      "def list_orders():",
      "    app.store.orders.read()",
      "    orders.read()",
      "    store.orders.read()",
      "    return orders()",
    ]);

    const summaries = await extract();
    const read = unitNamed(summaries, "read");
    expect(read.location.file).toBe("app/store/orders.py");
    expect(calls(unitNamed(summaries, "list_orders"))).toEqual([
      ["app.store.orders.read", summaryIdentifier(read)],
      ["orders.read", summaryIdentifier(read)],
      ["store.orders.read", summaryIdentifier(read)],
      ["orders", undefined],
    ]);
  });

  it("gives up on a name two modules hand back and forth through wildcard imports", async () => {
    write("app/a.py", ["from app.b import *", "from os import *"]);
    write("app/b.py", ["from app.a import *"]);
    write("app/main.py", [
      ...APP_HEADER,
      "from app.a import *",
      "",
      '@app.get("/loop")',
      "def loop():",
      "    return nowhere()",
    ]);

    const summaries = await extract();
    expect(summaries.filter((summary) => summary.kind === "library")).toEqual(
      [],
    );
    const route = unitNamed(summaries, "loop");
    expect(calls(route)).toEqual([["nowhere", undefined]]);
    expect(route.gaps.filter((gap) => gap.type === "unfollowedCall")).toEqual(
      [],
    );
  });
});
