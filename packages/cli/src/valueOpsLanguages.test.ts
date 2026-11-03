/**
 * The value ops over the facts, asked the same questions about the same
 * call written in TypeScript, Python and Ruby. Nothing in a declaration
 * reads these members yet, so this drives `factValueOps` directly over
 * each adapter's fact source, and the three have to agree.
 */

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
import { factCallOps } from "@suss/recognize/ops";
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

/** The first argument of each `register` call, in source order. */
type Registered = (ValueOps | null)[];

function typescriptArguments(): Registered {
  const project = createTestProject();
  project.createSourceFile("/src/things.ts", "export function Thing() {}");
  const file = project.createSourceFile("/src/use.ts", TYPESCRIPT);
  const store = new ResolutionStore();
  const source = factSourceFor(store);
  return file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === "register")
    .map(
      (call) =>
        factCallOps(statedFactKey(call, store), source)?.valueAt(0) ?? null,
    );
}

async function pythonArguments(): Promise<Registered> {
  const tree = await parsePython(PYTHON);
  const root = tree.rootNode;
  const db = pythonFacts({
    file: "use.py",
    root,
    module: bindModule(root),
    packs: [],
  });
  return argumentsOf(db, pythonFactSource(db));
}

async function rubyArguments(): Promise<Registered> {
  const tree = await parseRuby(RUBY);
  const db = rubyFacts({ file: "use.rb", root: tree.rootNode, packs: [] });
  return argumentsOf(db, rubyFactSource(db));
}

/** The first argument of every call to `register` the facts state, by where the call starts. */
function argumentsOf(db: Database, source: FactSource): Registered {
  return db
    .facts("call")
    .filter((row) => source.textOf(String(row[1])) === "register")
    .map((row) => String(row[0]))
    .sort((a, b) => startOf(a) - startOf(b))
    .map((call) => factCallOps(call, source)?.valueAt(0) ?? null);
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
