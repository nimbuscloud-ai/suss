/**
 * One `schemaReads` declaration run over the same program in TypeScript,
 * Python and Ruby. A schema is built with a library's `object` and a
 * refinement chained on it, and parsed against the environment three
 * ways: handed the environment, handed a parameter a caller fills with
 * it, and through a helper whose body parses. Each language reads the
 * same keys with the same defaults, which exercises the builder step,
 * the value ops `runtimePath` and `mentions`, and the call ops'
 * `callsInCallee`. TypeScript and Python also follow the environment
 * into a parameter that defaults to it. No Python or Ruby pack declares
 * a schema read yet, so those two run the chain over their own facts.
 */

import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import {
  bindEnvFacts,
  bindModule,
  envFactsIn,
  parsePython,
  pythonFactSource,
  factsForFile as pythonFacts,
} from "@suss/adapter-python";
import {
  emitEnvFacts,
  parseRuby,
  rubyFactSource,
  factsForFile as rubyFacts,
} from "@suss/adapter-ruby";
import { accessContextFor, ResolutionStore } from "@suss/adapter-typescript";
import nodeRuntimePack from "@suss/packs/node";
import { compile, constructedFrom, global, schemaReads } from "@suss/recognize";
import { factCallOps, factReadOps } from "@suss/recognize/ops";
import { createTestProject } from "@suss/test-project";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { FactSource } from "@suss/extractor";

const TYPESCRIPT = `
import { Schema } from "schemas";

const Env = Schema.object({
  PORT: Schema.string().optional(),
  NAME: Schema.string(),
}).strict();

export function direct() {
  return Env.parse(process.env);
}

function loadConfig(source: Record<string, string | undefined>) {
  return Env.parse(source);
}

export function handler() {
  return loadConfig(process.env);
}

export function fromDefault(fallback = process.env) {
  return Env.parse(fallback);
}
`;

const PYTHON = `import os
from schemas import Field, Schema

Env = Schema.object({"PORT": Field(default=1).optional(), "NAME": Schema.string()}).strict()


def direct():
    return Env.parse(os.environ)


def load_config(source):
    return Env.parse(source)


def handler():
    return load_config(os.environ)


def from_default(fallback=os.environ):
    return Env.parse(fallback)
`;

const RUBY = `ENV_SCHEMA = Schema.object({ "PORT" => optional(:x).default(1), "NAME" => Schema.string }).strict

def direct
  ENV_SCHEMA.parse(ENV)
end

def load_config(source)
  ENV_SCHEMA.parse(source)
end

def handler
  load_config(ENV)
end
`;

/** A schema chain over one language's environment, built by a `Schema` it imports from `module`. */
function chainOver(environment: string, module: string) {
  return schemaReads({ object: global(environment) })
    .methods({
      parse: {
        environment: { at: 0 },
        schema: [
          {
            of: [
              { to: "receiver" },
              { to: "builder", method: "object", from: [module] },
            ],
            at: 0,
          },
        ],
      },
    })
    .defaultedWhen({ calls: ["default", "optional"], options: ["default"] })
    .throughHelpers();
}

const RECOGNITION = "@suss/schema-read-test";

/** The callee, the name and whether it is defaulted, for each config read. */
function readsIn(effects: readonly Effect[]) {
  return effects.flatMap((effect) =>
    effect.type === "interaction" && effect.interaction.class === "config-read"
      ? [[effect.callee, effect.interaction.name, effect.interaction.defaulted]]
      : [],
  );
}

function raise(message: string): never {
  throw new Error(message);
}

/** The reads the chain gives at each call, by the call's text, over a language's facts. */
function readsOverFacts(
  db: Database,
  source: FactSource,
  chain: ReturnType<typeof chainOver>,
  text: string,
) {
  const call =
    db
      .facts("call")
      .map((row) => String(row[0]))
      .find((key) => source.textOf(key) === text) ?? raise(`no call ${text}`);
  const recognize = compile(chain.declared, RECOGNITION);
  return readsIn(recognize(null, { read: factReadOps(call, source) }) ?? []);
}

async function python() {
  const tree = await parsePython(PYTHON);
  const root = tree.rootNode;
  const module = bindModule(root);
  const db = pythonFacts({ file: "settings.py", root, module, packs: [] });
  bindEnvFacts(db, [envFactsIn("settings.py", root, module)]);
  return { db, source: pythonFactSource(db) };
}

async function ruby() {
  const tree = await parseRuby(RUBY);
  const db = rubyFacts({ file: "settings.rb", root: tree.rootNode, packs: [] });
  emitEnvFacts(db, "settings.rb", tree.rootNode);
  return { db, source: rubyFactSource(db) };
}

/** What every language reads: the defaulted key, then the other, off the environment's own spelling. */
function expected(environment: string) {
  return [
    [`${environment}.PORT`, "PORT", true],
    [`${environment}.NAME`, "NAME", false],
  ];
}

describe("a schema chain, in every language", () => {
  it("reads TypeScript's parses: handed the environment, a parameter a caller fills, through a helper, and a parameter defaulting to it", () => {
    const project = createTestProject();
    const file = project.createSourceFile("/src/settings.ts", TYPESCRIPT);
    const store = ResolutionStore.forPacks([nodeRuntimePack()]);
    store.notePossibleCallers([file]);
    const recognize = compile(
      chainOver("process.env", "schemas").declared,
      RECOGNITION,
    );
    const readsAt = (text: string) => {
      const call =
        file
          .getDescendants()
          .find(
            (node) => Node.isCallExpression(node) && node.getText() === text,
          ) ?? raise(`no call ${text}`);
      return readsIn(
        recognize(call, accessContextFor(call as never, file, store)) ?? [],
      );
    };

    expect(readsAt("Env.parse(process.env)")).toEqual(expected("process.env"));
    expect(readsAt("Env.parse(source)")).toEqual(expected("process.env"));
    expect(readsAt("loadConfig(process.env)")).toEqual(expected("process.env"));
    expect(readsAt("Env.parse(fallback)")).toEqual(expected("process.env"));
    expect(readsAt("Schema.string()")).toEqual([]);
  });

  it("reads Python's the same way, over its own facts", async () => {
    const { db, source } = await python();
    const chain = chainOver("os.environ", "schemas");
    const readsAt = (text: string) => readsOverFacts(db, source, chain, text);
    expect(readsAt("Env.parse(os.environ)")).toEqual(expected("os.environ"));
    expect(readsAt("Env.parse(source)")).toEqual(expected("os.environ"));
    expect(readsAt("load_config(os.environ)")).toEqual(expected("os.environ"));
    expect(readsAt("Env.parse(fallback)")).toEqual(expected("os.environ"));
  });

  it("reads Ruby's the same way, over its own facts", async () => {
    const { db, source } = await ruby();
    const chain = chainOver("ENV", "Schema");
    const readsAt = (text: string) => readsOverFacts(db, source, chain, text);
    expect(readsAt("ENV_SCHEMA.parse(ENV)")).toEqual(expected("ENV"));
    expect(readsAt("ENV_SCHEMA.parse(source)")).toEqual(expected("ENV"));
    expect(readsAt("load_config(ENV)")).toEqual(expected("ENV"));
  });
});

/** A library function that takes the environment and then the schema, imported under another name. */
function cleanOver(environment: string, module: string) {
  return schemaReads({
    object: global(environment),
    client: constructedFrom({ from: [module], named: ["clean"] }),
  }).methods({
    clean: { environment: { at: 0 }, schema: [{ at: 1 }] },
  });
}

const ALIASED_TYPESCRIPT = `
import { clean as load } from "envlib";
export const settings = load(process.env, { PORT: "8080" });
`;

const ALIASED_PYTHON = `import os
from envlib import clean as load

settings = load(os.environ, {"PORT": "8080"})
`;

const ALIASED_RUBY = `SETTINGS = load(ENV, { "PORT" => "8080" })
`;

describe("a parse the file imported under another name, in every language", () => {
  it("reads TypeScript's through its import", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/src/aliased.ts",
      ALIASED_TYPESCRIPT,
    );
    const store = ResolutionStore.forPacks([nodeRuntimePack()]);
    const call =
      file.getDescendants().find((node) => Node.isCallExpression(node)) ??
      raise("no call");
    const ctx = accessContextFor(call as never, file, store);
    expect(ctx.read?.call?.()?.calleeImport?.(["envlib"])).toBe("clean");
    const recognize = compile(
      cleanOver("process.env", "envlib").declared,
      RECOGNITION,
    );
    expect(readsIn(recognize(call, ctx) ?? [])).toEqual([
      ["process.env.PORT", "PORT", false],
    ]);
  });

  it("reads Python's through its import", async () => {
    const tree = await parsePython(ALIASED_PYTHON);
    const root = tree.rootNode;
    const module = bindModule(root);
    const db = pythonFacts({ file: "aliased.py", root, module, packs: [] });
    const source = pythonFactSource(db);
    expect(
      readsOverFacts(
        db,
        source,
        cleanOver("os.environ", "envlib"),
        'load(os.environ, {"PORT": "8080"})',
      ),
    ).toEqual([["os.environ.PORT", "PORT", false]]);
  });

  it("finds no import to read in Ruby, which imports no names", async () => {
    const tree = await parseRuby(ALIASED_RUBY);
    const db = rubyFacts({
      file: "aliased.rb",
      root: tree.rootNode,
      packs: [],
    });
    const source = rubyFactSource(db);
    const call =
      db
        .facts("call")
        .map((row) => String(row[0]))
        .find((key) => source.textOf(key).startsWith("load(")) ??
      raise("no call");
    expect(factCallOps(call, source)?.calleeImport?.(["Envlib"])).toBeNull();
  });
});
