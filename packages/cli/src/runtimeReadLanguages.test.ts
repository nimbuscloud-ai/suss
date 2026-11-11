/**
 * The read ops over the facts, asked about the same environment reads in
 * TypeScript, Python and Ruby: a plain read, a read with a fallback, an
 * assignment to an entry, and a read through a helper `need("G")`.
 * TypeScript also has a destructured read, and runs the Node pack's
 * chains through the access context. Python and Ruby each get a getter
 * chain here, run over their own facts, since their adapters still record
 * environment reads themselves.
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
import {
  accessContextFor,
  ResolutionStore,
  readOpsAt,
} from "@suss/adapter-typescript";
import nodeRuntimePack from "@suss/packs/node";
import { compile, global, runtimeReads } from "@suss/recognize";
import { factCallOps, factReadOps } from "@suss/recognize/ops";
import { createTestProject } from "@suss/test-project";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { FactSource, ReadOps, RuntimeObject } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

const TYPESCRIPT = `
function need(name: string) {
  return process.env[name];
}

export function reads() {
  const a = process.env.A;
  const f = process.env.F ?? "y";
  const { D } = process.env;
  const g = need("G");
  process.env.W = "1";
  return [a, f, D, g];
}
`;

const PYTHON = `import os


def need(name):
    return os.environ[name]


def reads():
    a = os.environ["A"]
    f = os.environ["F"] or "y"
    b = os.environ.get("B", "d")
    g = need("G")
    os.environ["W"] = "1"
    return a, f, b, g
`;

const RUBY = `module Settings
  def self.need(name)
    ENV[name]
  end

  def self.reads
    a = ENV["A"]
    f = ENV["F"] || "y"
    b = ENV.fetch("B", "d")
    g = need("G")
    ENV["W"] = "1"
    [a, f, b, g]
  end
end
`;

const RECOGNITION = "@suss/runtime-read-test";

/** The read ops at each site the tests ask about, by the source text of the site. */
interface Sites {
  readonly object: RuntimeObject;
  at(text: string): ReadOps;
}

function typescriptSites(): {
  sites: Sites;
  file: SourceFile;
  store: ResolutionStore;
} {
  const project = createTestProject();
  const file = project.createSourceFile("/src/env.ts", TYPESCRIPT);
  const store = ResolutionStore.forPacks([nodeRuntimePack()]);
  store.notePossibleCallers([file]);
  const nodes = file
    .getDescendants()
    .filter(
      (node) =>
        Node.isPropertyAccessExpression(node) || Node.isCallExpression(node),
    );
  return {
    file,
    store,
    sites: {
      object: global("process.env"),
      at: (text) => {
        const node =
          nodes.find((one) => one.getText() === text) ??
          raise(`no site ${text}`);
        return readOpsAt(node, store);
      },
    },
  };
}

/** A language's facts for its source, and the read ops at its sites. */
interface Stated {
  readonly sites: Sites;
  readonly db: Database;
  readonly source: FactSource;
}

async function pythonSites(): Promise<Stated> {
  const tree = await parsePython(PYTHON);
  const root = tree.rootNode;
  const module = bindModule(root);
  const db = pythonFacts({ file: "env.py", root, module, packs: [] });
  bindEnvFacts(db, [envFactsIn("env.py", root, module)]);
  const source = pythonFactSource(db);
  return { sites: sitesIn(db, source, global("os.environ")), db, source };
}

async function rubySites(): Promise<Stated> {
  const tree = await parseRuby(RUBY);
  const db = rubyFacts({ file: "env.rb", root: tree.rootNode, packs: [] });
  emitEnvFacts(db, "env.rb", tree.rootNode);
  const source = rubyFactSource(db);
  return { sites: sitesIn(db, source, global("ENV")), db, source };
}

/** The sites the facts state a read, an assignment or a call at, by their text. */
function sitesIn(
  db: Database,
  source: FactSource,
  object: RuntimeObject,
): Sites {
  const keys = ["readsEntry", "readsKeyed", "assigns", "call"].flatMap(
    (relation) => db.facts(relation).map((row) => String(row[0])),
  );
  return {
    object,
    at: (text) =>
      factReadOps(
        keys.find((key) => source.textOf(key) === text) ??
          raise(`no site ${text}`),
        source,
      ),
  };
}

function raise(message: string): never {
  throw new Error(message);
}

/** What the ops say about the four sites every language writes. */
function readingsOf(sites: Sites, spelled: (entry: string) => string) {
  const plain = sites.at(spelled("A"));
  const withFallback = sites.at(spelled("F"));
  const [key] = sites.at('need("G")').keysSuppliedTo(sites.object) ?? [];
  return {
    plain: {
      entry: plain.entry(),
      isOff: plain.isOff(sites.object),
      defaulted: plain.defaulted(),
      fallback: plain.fallback()?.evaluated?.() ?? null,
    },
    withFallback: {
      entry: withFallback.entry(),
      defaulted: withFallback.defaulted(),
      fallback: withFallback.fallback()?.evaluated?.() ?? null,
    },
    assigned:
      sites.at(spelled("W")).assigned()?.evaluated?.() ?? "nothing assigned",
    helper:
      key === undefined
        ? null
        : {
            at: key.at,
            name: key.value.evaluated?.() ?? null,
            forwarded: key.forwarded,
            siteEntries: key.sites.map((site) => site.entry()),
          },
  };
}

const EVERY_LANGUAGE = {
  plain: { entry: "A", isOff: true, defaulted: false, fallback: null },
  withFallback: { entry: "F", defaulted: true, fallback: "y" },
  assigned: "1",
  helper: { at: 0, name: "G", forwarded: false, siteEntries: [null] },
};

/** A config read's name, whether it is defaulted, and what it falls back to. */
function configReadsIn(effects: readonly Effect[]) {
  return effects.flatMap((effect) =>
    effect.type === "interaction" && effect.interaction.class === "config-read"
      ? [
          [
            effect.callee,
            effect.interaction.name,
            effect.interaction.defaulted,
            effect.interaction.default ?? null,
          ],
        ]
      : [],
  );
}

/** A getter chain's effects at the call in each language, over its own facts. */
function getterReadsAt(
  { db, source }: Stated,
  chain: ReturnType<typeof runtimeReads>,
  text: string,
): Effect[] {
  const call =
    db
      .facts("call")
      .map((row) => String(row[0]))
      .find((key) => source.textOf(key) === text) ?? raise(`no call ${text}`);
  const recognize = compile(chain.declared, RECOGNITION);
  return (
    recognize(null, {
      read: factReadOps(call, source),
      ops: factCallOps(call, source),
    }) ?? []
  );
}

describe("the read ops, in every language", () => {
  it("say the same about TypeScript's reads", () => {
    const { sites } = typescriptSites();
    expect(readingsOf(sites, (entry) => `process.env.${entry}`)).toEqual(
      EVERY_LANGUAGE,
    );
  });

  it("say the same about Python's reads", async () => {
    const { sites } = await pythonSites();
    expect(readingsOf(sites, (entry) => `os.environ["${entry}"]`)).toEqual(
      EVERY_LANGUAGE,
    );
  });

  it("say the same about Ruby's reads", async () => {
    const { sites } = await rubySites();
    expect(readingsOf(sites, (entry) => `ENV["${entry}"]`)).toEqual(
      EVERY_LANGUAGE,
    );
  });

  it("read the entries TypeScript destructures off the object itself", () => {
    const { file, store } = typescriptSites();
    const destructured =
      file
        .getDescendants()
        .find(
          (node) =>
            node.getText() === "process.env" &&
            Node.isVariableDeclaration(node.getParent()),
        ) ?? raise("no destructuring");
    expect(
      readOpsAt(destructured, store)
        .readsOff()
        .map((site) => site.entry()),
    ).toEqual(["D"]);
  });

  it("run the Node pack's chains over TypeScript's reads", () => {
    const { file, store } = typescriptSites();
    const recognizers = nodeRuntimePack().accessRecognizers ?? [];
    const effects = file
      .getDescendants()
      .flatMap((node) =>
        Node.isPropertyAccessExpression(node) || Node.isCallExpression(node)
          ? recognizers.flatMap(
              (recognize) =>
                recognize(node, accessContextFor(node, file, store)) ?? [],
            )
          : [],
      );
    expect(configReadsIn(effects)).toEqual([
      ["process.env[name]", null, false, null],
      ["process.env.A", "A", false, null],
      ["process.env.F", "F", true, "y"],
      ["process.env.D", "D", false, null],
      ["process.env.G", "G", false, null],
      ["process.env.W", "W", false, null],
    ]);
  });

  it("read a Python getter's key and fallback", async () => {
    const python = await pythonSites();
    const getter = runtimeReads({ object: global("os.environ") })
      .entries({}, { reads: "config" })
      .getters({
        get: { key: { at: 0 }, fallback: { at: 1, keyword: "default" } },
      });
    expect(
      configReadsIn(getterReadsAt(python, getter, 'os.environ.get("B", "d")')),
    ).toEqual([["os.environ.B", "B", true, "d"]]);
  });

  it("read a Ruby getter's key and fallback", async () => {
    const ruby = await rubySites();
    const getter = runtimeReads({ object: global("ENV") })
      .entries({}, { reads: "config" })
      .getters({
        fetch: {
          key: { at: 0 },
          fallback: [{ at: 1 }, { block: true }],
          raisesWithout: true,
        },
      });
    expect(
      configReadsIn(getterReadsAt(ruby, getter, 'ENV.fetch("B", "d")')),
    ).toEqual([["ENV.B", "B", true, "d"]]);
  });

  it("find no key at a call that passes none to a helper", () => {
    const { sites } = typescriptSites();
    expect(sites.at("process.env.A").keysSuppliedTo(sites.object)).toEqual([]);
  });
});
