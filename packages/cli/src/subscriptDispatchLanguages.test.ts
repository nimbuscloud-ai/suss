/**
 * A call through a subscript, `TABLE[kind]` or `Registry[kind]`, asked
 * what it may run in TypeScript, Python and Ruby. A table written out
 * gives its entries in all three. A class does not: JavaScript reads a
 * static off it, while Python and Ruby run the class's own `__getitem__`
 * or `[]` method, which never hands back a method the class declares.
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
import { ResolutionStore } from "@suss/adapter-typescript";
import { dispatchOutcomes } from "@suss/resolution";
import { createTestProject } from "@suss/test-project";

import type { Database } from "@suss/datalog";
import type { FactSource } from "@suss/extractor";

const TYPESCRIPT = `
class Registry {
  static registered() { return 1; }
}
const TABLE = { created: () => 1, deleted: () => 2 };
export function viaTable(kind: any) { return TABLE[kind](); }
export function viaClass(kind: any) { return Registry[kind](); }
`;

const PYTHON = `
class Registry:
    @classmethod
    def registered(cls):
        return 1

    def resolve(self):
        return 2

TABLE = {"created": lambda: 1, "deleted": lambda: 2}

def via_table(kind):
    return TABLE[kind]()

def via_get(kind):
    return TABLE.get(kind)()

def via_class(kind):
    return Registry[kind]()

def via_written_key():
    return Registry["resolve"]()
`;

const RUBY = `
class Registry
  def self.registered
    1
  end

  def resolve
    2
  end
end

TABLE = { created: -> { 1 }, deleted: -> { 2 } }

def via_table(kind)
  TABLE[kind].call
end

def via_fetch(kind)
  TABLE.fetch(kind).call
end

def via_class(kind)
  Registry[kind].call
end

def via_written_key
  Registry[:resolve].call
end
`;

/** The first line of each function a call may run, sorted. */
function firstLines(texts: readonly string[]): string[] {
  return texts.map((text) => (text.split("\n")[0] ?? "").trim()).sort();
}

function typescriptTargets(callee: string): string[] {
  const project = createTestProject();
  const file = project.createSourceFile("/src/use.ts", TYPESCRIPT);
  const call = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((node) => node.getText() === callee);
  if (call === undefined) {
    throw new Error(`no call ${callee}`);
  }
  const found = new ResolutionStore().dispatchedFunctions([call]).get(call);
  return firstLines((found?.functions ?? []).map((fn) => fn.getText()));
}

/** What the call written as `callee` may run, over one file's facts. */
function targetsIn(db: Database, source: FactSource, callee: string): string[] {
  const call = db
    .facts("call")
    .map((row) => String(row[0]))
    .find((key) => source.textOf(key) === callee);
  if (call === undefined) {
    throw new Error(`no call ${callee}`);
  }
  const functions = dispatchOutcomes(db, [call]).get(call)?.functions ?? [];
  return firstLines(functions.map((fn) => source.textOf(fn) ?? fn));
}

async function pythonTargets(callee: string): Promise<string[]> {
  const root = (await parsePython(PYTHON)).rootNode;
  const db = pythonFacts({
    file: "use.py",
    root,
    module: bindModule(root),
    packs: [],
  });
  return targetsIn(db, pythonFactSource(db), callee);
}

async function rubyTargets(callee: string): Promise<string[]> {
  const root = (await parseRuby(RUBY)).rootNode;
  const db = rubyFacts({ file: "use.rb", root, packs: [] });
  return targetsIn(db, rubyFactSource(db), callee);
}

describe("a call through a subscript, in each language", () => {
  it("may run any entry of a table written out", async () => {
    expect(typescriptTargets("TABLE[kind]()")).toEqual(["() => 1", "() => 2"]);
    expect(await pythonTargets("TABLE[kind]()")).toEqual([
      "lambda: 1",
      "lambda: 2",
    ]);
    expect(await pythonTargets("TABLE.get(kind)()")).toEqual([
      "lambda: 1",
      "lambda: 2",
    ]);
    expect(await rubyTargets("TABLE[kind].call")).toEqual([
      "-> { 1 }",
      "-> { 2 }",
    ]);
    expect(await rubyTargets("TABLE.fetch(kind).call")).toEqual([
      "-> { 1 }",
      "-> { 2 }",
    ]);
  });

  it("may run a static off a TypeScript class, and never a method of a Python or Ruby one", async () => {
    expect(typescriptTargets("Registry[kind]()")).toEqual([
      "static registered() { return 1; }",
    ]);
    expect(await pythonTargets("Registry[kind]()")).toEqual([]);
    expect(await rubyTargets("Registry[kind].call")).toEqual([]);
  });

  it("never runs a method of a Python or Ruby class under a key written out", async () => {
    expect(await pythonTargets('Registry["resolve"]()')).toEqual([]);
    expect(await rubyTargets("Registry[:resolve].call")).toEqual([]);
  });
});
