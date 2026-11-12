/**
 * The value ops over the facts, asked the same questions about the same
 * call written in TypeScript, Python and Ruby. Only TypeScript packs
 * declare chains that read these members, so this drives `factValueOps`
 * directly over each adapter's fact source, and the three have to agree.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import {
  bindModule,
  parsePython,
  pythonFactSource,
  factsForFile as pythonFacts,
} from "@suss/adapter-python";
import {
  parseRuby,
  rubyFactSource,
  factsForFile as rubyFacts,
} from "@suss/adapter-ruby";
import {
  factSourceFor,
  ResolutionStore,
  statedFactKey,
} from "@suss/adapter-typescript";
import { factCallOps, factValueOps } from "@suss/recognize/ops";
import { createTestProject } from "@suss/test-project";

import type { Database } from "@suss/datalog";
import type { FactSource, ValueOps } from "@suss/extractor";

const TYPESCRIPT = `
  import { Thing } from "./things";

  const kind = "primary";
  const named = () => null;
  function keep<T>(value: T): T {
    return value;
  }
  function makeRender() {
    return () => null;
  }
  const options = { label: \`\${kind} x\`, count: 2, render: () => null, comp: Thing, named, made: makeRender() };

  register({ label: \`\${kind} x\`, count: 2, render: () => null, comp: Thing, named, made: makeRender() });
  register(keep(options));
`;

const PYTHON = `
from things import Thing

kind = "primary"

def named():
    return None

def keep(value):
    return value

def make_render():
    return lambda: None

options = {"label": f"{kind} x", "count": 2, "render": lambda: None, "comp": Thing, "named": named, "made": make_render()}

register({"label": f"{kind} x", "count": 2, "render": lambda: None, "comp": Thing, "named": named, "made": make_render()})
register(keep(options))
`;

const RUBY = `
KIND = "primary"
NAMED = -> { nil }

def keep(value)
  value
end

def make_render()
  -> { nil }
end

OPTIONS = { label: "#{KIND} x", count: 2, render: -> { nil }, comp: Thing, named: NAMED, made: make_render() }

register({ label: "#{KIND} x", count: 2, render: -> { nil }, comp: Thing, named: NAMED, made: make_render() })
register(keep(OPTIONS))
`;

/** The first argument of each call to one function, in source order. */
type Registered = (ValueOps | null)[];

function typescriptArguments(
  written = TYPESCRIPT,
  callee = "register",
): Registered {
  const project = createTestProject();
  project.createSourceFile("/src/things.ts", "export function Thing() {}");
  const file = project.createSourceFile("/src/use.ts", written);
  const store = new ResolutionStore();
  const source = factSourceFor(store);
  return file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === callee)
    .map(
      (call) =>
        factCallOps(statedFactKey(call, store), source)?.valueAt(0) ?? null,
    );
}

async function pythonArguments(
  written = PYTHON,
  callee = "register",
): Promise<Registered> {
  const tree = await parsePython(written);
  const root = tree.rootNode;
  const db = pythonFacts({
    file: "use.py",
    root,
    module: bindModule(root),
    packs: [],
  });
  return argumentsOf(db, pythonFactSource(db), callee);
}

async function rubyArguments(
  written = RUBY,
  callee = "register",
): Promise<Registered> {
  const tree = await parseRuby(written);
  const db = rubyFacts({ file: "use.rb", root: tree.rootNode, packs: [] });
  return argumentsOf(db, rubyFactSource(db), callee);
}

/** The first argument of every call to `callee` the facts state, by where the call starts. */
function argumentsOf(
  db: Database,
  source: FactSource,
  callee: string,
): Registered {
  return db
    .facts("call")
    .filter((row) => source.textOf(String(row[1])) === callee)
    .map((row) => String(row[0]))
    .sort((a, b) => startOf(a) - startOf(b))
    .map((call) => factCallOps(call, source)?.valueAt(0) ?? null);
}

/** The function that has a parameter of this name, which Python and Ruby state with every other fact. */
function functionWithParameter(
  db: Database,
  source: FactSource,
  parameter: string,
): ValueOps | null {
  const row = db.facts("paramNamed").find((named) => named[1] === parameter);
  return row === undefined ? null : factValueOps(String(row[0]), source);
}

/** Where a node key starts in its file, `use.py:120-180` giving 120. */
function startOf(key: string): number {
  return Number((key.split(":")[1] ?? "").split("-")[0]);
}

/** What each of the five members says about the object a call is handed. */
function readingsOf(argument: ValueOps | null) {
  const object = argument?.object?.() ?? null;
  const property = (name: string) => object?.property(name) ?? null;
  const isFunction = (name: string) =>
    (property(name)?.function?.() ?? null) !== null;
  return {
    keys: object?.entries("nothing").map((entry) => entry.key) ?? null,
    label: property("label")?.evaluated?.() ?? null,
    count: property("count")?.evaluated?.() ?? null,
    functions: ["render", "named", "made", "label"].filter(isFunction),
    component: property("comp")?.source?.() ?? null,
    importedFrom: property("comp")?.importedFrom?.() ?? null,
  };
}

/** The encoding a value is written with, and the keys of what went in. */
function encodingOf(argument: ValueOps | null) {
  const encoded = argument?.encoded?.() ?? null;
  return encoded === null
    ? null
    : {
        codec: encoded.codec,
        keys: encoded.value.entries("nothing").map((entry) => entry.key),
      };
}

const SAME_IN_EVERY_LANGUAGE = {
  keys: ["label", "count", "render", "comp", "named", "made"],
  label: "primary x",
  count: 2,
  functions: ["render", "named", "made"],
  component: "Thing",
};

describe("the value ops over each adapter's facts", () => {
  it("read an object written in place the same way in every language", async () => {
    const [typescript] = typescriptArguments();
    const [python] = await pythonArguments();
    const [ruby] = await rubyArguments();

    expect(readingsOf(typescript ?? null)).toEqual({
      ...SAME_IN_EVERY_LANGUAGE,
      importedFrom: "./things",
    });
    expect(readingsOf(python ?? null)).toEqual({
      ...SAME_IN_EVERY_LANGUAGE,
      importedFrom: "things",
    });
    expect(readingsOf(ruby ?? null)).toEqual({
      ...SAME_IN_EVERY_LANGUAGE,
      importedFrom: null,
    });
  });

  it("read what each language's encoder was handed, through a name too", async () => {
    // The third send is a cast in TypeScript, `to_json` in Ruby, and a
    // `dumps` of a module that is not the standard library's in Python.
    const typescript = typescriptArguments(
      `
        const kept = JSON.stringify({ b: 2 });
        send(JSON.stringify({ a: 1 }));
        send(kept);
        send(JSON.stringify({ c: 3 }) as string);
        send(String({ d: 4 }));
      `,
      "send",
    );
    const python = await pythonArguments(
      `import json
from mylib import codec

kept = json.dumps({"b": 2})
send(json.dumps({"a": 1}))
send(kept)
send(codec.dumps({"c": 3}))
send(json.loads("{}"))
`,
      "send",
    );
    const ruby = await rubyArguments(
      `kept = JSON.pretty_generate({ b: 2 })
send(JSON.generate({ a: 1 }))
send(kept)
send({ c: 3 }.to_json)
send(Other.generate({ d: 4 }))
`,
      "send",
    );

    expect(typescript.map(encodingOf)).toEqual([
      { codec: "json", keys: ["a"] },
      { codec: "json", keys: ["b"] },
      { codec: "json", keys: ["c"] },
      null,
    ]);
    expect(python.map(encodingOf)).toEqual([
      { codec: "json", keys: ["a"] },
      { codec: "json", keys: ["b"] },
      null,
      null,
    ]);
    expect(ruby.map(encodingOf)).toEqual([
      { codec: "json", keys: ["a"] },
      { codec: "json", keys: ["b"] },
      { codec: "json", keys: ["c"] },
      null,
    ]);
  });

  it("read a statement's pieces off what a project function returns", async () => {
    const typescript = typescriptArguments(
      `
        function ledgerQuery() {
          return "SELECT * FROM ledger";
        }
        function bySide(side: string) {
          return \`SELECT id FROM tapes WHERE side = \${side}\`;
        }
        run(ledgerQuery());
        run(bySide("a"));
      `,
      "run",
    );
    const python = await pythonArguments(
      `def ledger_query():
    return "SELECT * FROM ledger"

def by_side(side):
    return f"SELECT id FROM tapes WHERE side = {side}"

run(ledger_query())
run(by_side("a"))
`,
      "run",
    );
    const ruby = await rubyArguments(
      `def ledger_query
  "SELECT * FROM ledger"
end

def by_side(side)
  "SELECT id FROM tapes WHERE side = #{side}"
end

run(ledger_query)
run(by_side("a"))
`,
      "run",
    );
    const piecesOf = (statement: ValueOps | null) => ({
      parts: statement?.parts?.() ?? null,
      holes: statement?.interpolated?.().length ?? null,
    });
    const READ = [
      { parts: ["SELECT * FROM ledger"], holes: 0 },
      { parts: ["SELECT id FROM tapes WHERE side = ", ""], holes: 1 },
    ];

    expect(typescript.map(piecesOf)).toEqual(READ);
    expect(python.map(piecesOf)).toEqual(READ);
    expect(ruby.map(piecesOf)).toEqual(READ);
  });

  it("say which parameter of a function a value is, in every language", async () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/src/handle.ts",
      `
        function handle(first: unknown, second: unknown) {
          use(second);
          use(first);
          use(other);
        }
        register(handle);
      `,
    );
    const store = new ResolutionStore();
    const tsSource = factSourceFor(store);
    const tsArgument = (callee: string) =>
      file
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((call) => call.getExpression().getText() === callee)
        .map(
          (call) =>
            factCallOps(statedFactKey(call, store), tsSource)?.valueAt(0) ??
            null,
        );
    const tsHandle = tsArgument("register")[0]?.function?.() ?? null;

    const pythonTree = await parsePython(
      [
        "def handle(first, second):",
        "    use(second)",
        "    use(first)",
        "    use(other)",
        "",
      ].join("\n"),
    );
    const pythonDb = pythonFacts({
      file: "handle.py",
      root: pythonTree.rootNode,
      module: bindModule(pythonTree.rootNode),
      packs: [],
    });
    const rubyTree = await parseRuby(
      [
        "def handle(first, second)",
        "  use(second)",
        "  use(first)",
        "  use(other)",
        "end",
        "",
      ].join("\n"),
    );
    const rubyDb = rubyFacts({
      file: "handle.rb",
      root: rubyTree.rootNode,
      packs: [],
    });
    const positions = (
      values: readonly (ValueOps | null)[],
      fn: ValueOps | null,
    ) => values.map((value) => (fn === null ? null : value?.parameterAt?.(fn)));

    expect(positions(tsArgument("use"), tsHandle)).toEqual([1, 0, null]);
    for (const [db, source] of [
      [pythonDb, pythonFactSource(pythonDb)],
      [rubyDb, rubyFactSource(rubyDb)],
    ] as const) {
      expect(
        positions(
          argumentsOf(db, source, "use"),
          functionWithParameter(db, source, "first"),
        ),
      ).toEqual([1, 0, null]);
      // Only TypeScript writes JSX, so a function elsewhere writes no element.
      expect(
        functionWithParameter(db, source, "first")?.elements?.("Chip"),
      ).toEqual([]);
    }
  });

  it("say where a value is declared, through an import and in its own file, in every language", async () => {
    const project = createTestProject();
    project.createSourceFile("/src/things.ts", "export function Thing() {}");
    const file = project.createSourceFile(
      "/src/use.ts",
      `
        import { Thing as Renamed } from "./things";
        import { Missing } from "not-installed";
        function local() {}
        register(Renamed);
        register(local);
        register(Missing);
      `,
    );
    const store = new ResolutionStore();
    const tsSource = factSourceFor(store);
    const typescript = file
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .map(
        (call) =>
          factCallOps(statedFactKey(call, store), tsSource)?.valueAt(0) ?? null,
      );

    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-declaration-")),
    );
    const pythonFile = (name: string, source: string) => {
      const full = path.join(dir, name);
      fs.writeFileSync(full, source);
      return full;
    };
    const thingsPy = pythonFile("things.py", "def Thing():\n    return 1\n");
    const usePy = pythonFile(
      "use.py",
      [
        "from things import Thing as Renamed",
        "from not_installed import Missing",
        "def local():",
        "    return 1",
        "register(Renamed)",
        "register(local)",
        "register(Missing)",
        "",
      ].join("\n"),
    );
    const pythonDbs = await Promise.all(
      [thingsPy, usePy].map(async (pyFile) => {
        const root = (await parsePython(fs.readFileSync(pyFile, "utf8")))
          .rootNode;
        return pythonFacts({
          file: pyFile,
          root,
          module: bindModule(root),
          packs: [],
          roots: [dir],
        });
      }),
    );
    const [thingsDb, useDb] = pythonDbs as [Database, Database];
    for (const relation of thingsDb.relationNames()) {
      for (const row of thingsDb.facts(relation)) {
        useDb.add(relation, [...row]);
      }
    }
    const python = argumentsOf(useDb, pythonFactSource(useDb), "register");
    fs.rmSync(dir, { recursive: true, force: true });

    const rubyTree = await parseRuby(
      [
        "class Thing",
        "end",
        "LOCAL = -> { nil }",
        "register(Thing)",
        "register(LOCAL)",
        "register(Missing::Thing)",
        "",
      ].join("\n"),
    );
    const rubyDb = rubyFacts({
      file: "use.rb",
      root: rubyTree.rootNode,
      packs: [],
    });
    const ruby = argumentsOf(rubyDb, rubyFactSource(rubyDb), "register");

    const declared = (values: readonly (ValueOps | null)[]) =>
      values.map((value) => value?.declaration?.() ?? null);
    expect(declared(typescript)).toEqual([
      { file: "/src/things.ts", name: "Thing" },
      { file: "/src/use.ts", name: "local" },
      null,
    ]);
    expect(declared(python)).toEqual([
      { file: thingsPy, name: "Thing" },
      { file: usePy, name: "local" },
      null,
    ]);
    expect(declared(ruby)).toEqual([
      { file: "use.rb", name: "Thing" },
      { file: "use.rb", name: "LOCAL" },
      null,
    ]);
  });

  it("follow an object through a name and a function that returns its argument", async () => {
    const [, typescript] = typescriptArguments();
    const [, python] = await pythonArguments();
    const [, ruby] = await rubyArguments();

    expect(readingsOf(typescript ?? null)).toEqual({
      ...SAME_IN_EVERY_LANGUAGE,
      importedFrom: "./things",
    });
    expect(readingsOf(python ?? null)).toEqual({
      ...SAME_IN_EVERY_LANGUAGE,
      importedFrom: "things",
    });
    expect(readingsOf(ruby ?? null)).toEqual({
      ...SAME_IN_EVERY_LANGUAGE,
      importedFrom: null,
    });
  });
});
