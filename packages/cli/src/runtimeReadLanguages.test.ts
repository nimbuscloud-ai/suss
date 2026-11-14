/**
 * The read ops over the facts, asked about the same environment reads in
 * TypeScript, Python and Ruby: a plain read, a read with a fallback, an
 * assignment to an entry, and a read through a helper `need("G")`.
 * TypeScript also has a destructured read, and runs the Node pack's
 * chains through the access context. Python and Ruby each run their own
 * environment chain through their read dispatch. A function the runtime
 * provides is a test chain in TypeScript and Ruby, whose environments
 * have none.
 */

import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import {
  bindEnvFacts,
  bindModule,
  ENVIRONMENT,
  envFactsIn,
  parsePython,
  pythonFactSource,
  factsForFile as pythonFacts,
  nodeId as pythonNodeId,
  stdlibReads,
} from "@suss/adapter-python";
import {
  parseRuby,
  ENVIRONMENT as RUBY_ENVIRONMENT,
  rubyFactSource,
  factsForFile as rubyFacts,
  nodeId as rubyNodeId,
  stdlibReads as rubyStdlibReads,
} from "@suss/adapter-ruby";
import {
  accessContextFor,
  discoverUnits,
  factSourceFor,
  ResolutionStore,
  readOpsAt,
  statedFactKey,
} from "@suss/adapter-typescript";
import nodeRuntimePack from "@suss/packs/node";
import {
  allOf,
  compile,
  discoverDeclared,
  global,
  handedIn,
  readOff,
  runtimeReads,
  siteReadOf,
} from "@suss/recognize";
import { factCallOps, factModuleOps, factReadOps } from "@suss/recognize/ops";
import { stateHandedIn } from "@suss/resolution";
import { createTestProject } from "@suss/test-project";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  CallOps,
  DeclaredDiscoveryPattern,
  FactSource,
  ReadOps,
  RuntimeObject,
  SuppliedKey,
  UnitSpec,
} from "@suss/extractor";
import type { DeclaredUnit } from "@suss/recognize";
import type { PropertyAccessExpression, SourceFile } from "ts-morph";

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

function typescriptSites(text = TYPESCRIPT): {
  sites: Sites;
  file: SourceFile;
  store: ResolutionStore;
} {
  const project = createTestProject();
  const file = project.createSourceFile("/src/env.ts", text);
  const store = ResolutionStore.forPacks([nodeRuntimePack()]);
  store.notePossibleCallers([file]);
  const nodes = file
    .getDescendants()
    .filter(
      (node) =>
        Node.isPropertyAccessExpression(node) ||
        Node.isElementAccessExpression(node) ||
        Node.isCallExpression(node),
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

async function pythonSites(
  text = PYTHON,
): Promise<
  Stated & { root: Awaited<ReturnType<typeof parsePython>>["rootNode"] }
> {
  const tree = await parsePython(text);
  const root = tree.rootNode;
  const module = bindModule(root);
  const db = pythonFacts({ file: "env.py", root, module, packs: [] });
  bindEnvFacts(db, [envFactsIn("env.py", root, module)]);
  const source = pythonFactSource(db);
  return {
    sites: sitesIn(db, source, global("os.environ")),
    db,
    source,
    root,
  };
}

async function rubySites(
  text = RUBY,
): Promise<
  Stated & { root: Awaited<ReturnType<typeof parseRuby>>["rootNode"] }
> {
  const tree = await parseRuby(text);
  const root = tree.rootNode;
  const db = rubyFacts({ file: "env.rb", root, packs: [] });
  const source = rubyFactSource(db);
  return { sites: sitesIn(db, source, global("ENV")), db, source, root };
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

  it("read a key written as a template as one the program works out", async () => {
    const typescript = typescriptSites(
      "export function key(name: string) {\n  return process.env[`${name}_KEY`];\n}\n",
    ).sites;
    const python = await pythonSites(
      'import os\n\n\ndef key(name):\n    return os.environ[f"{name}_KEY"]\n',
    );
    const ruby = await rubySites('def key(name)\n  ENV["#{name}_KEY"]\nend\n');
    const keyed = (sites: Sites, text: string) => {
      const site = sites.at(text);
      return { entry: site.entry(), isOff: site.isOff(sites.object) };
    };
    const computed = { entry: null, isOff: true };
    expect(keyed(typescript, "process.env[`${name}_KEY`]")).toEqual(computed);
    expect(keyed(python.sites, 'os.environ[f"{name}_KEY"]')).toEqual(computed);
    expect(keyed(ruby.sites, 'ENV["#{name}_KEY"]')).toEqual(computed);
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

const MAPPING_TYPESCRIPT = `
const KEY = "K";

export function reads(name: string) {
  const a = process.env.A;
  const n = process.env[name];
  const k = process.env.get(KEY);
  const c = getenv("C", "c");
  const f = process.env.get("F") ?? "y";
  return [a, n, k, c, f];
}
`;

const MAPPING_PYTHON = `import os
from os import environ, getenv

KEY = "K"


def need(name):
    return os.environ[name]


def reads(name):
    a = os.environ["A"]
    n = os.environ[name]
    k = os.environ.get(KEY)
    c = os.getenv("C", "c")
    d = environ["D"]
    e = getenv("E")
    f = os.environ.get("F") or "y"
    h = need(name="H")
    if "R" in os.environ:
        r = os.environ["R"]
    del os.environ["Z"]
    os.environ["P"] += ":x"
    return a, n, k, c, d, e, f, h, r
`;

const MAPPING_RUBY = `module Settings
  KEY = "K"

  def self.need(name:)
    ENV[name]
  end

  def self.reads(name)
    a = ENV["A"]
    n = ENV[name]
    k = ENV.fetch(KEY)
    c = getenv("C", "c")
    d = ::ENV["D"]
    f = ENV.fetch("F") || "y"
    s = ENV.fetch("S") if ENV.key?("S")
    h = need(name: "H")
    ENV["Z"] = "z"
    ENV["P"] ||= "x"
    [a, n, k, c, d, f, s, h]
  end
end
`;

const KEY_GETTER = { key: { at: 0 } };
const FALLBACK_GETTER = { key: { at: 0 }, fallback: { at: 1 } };

/** A chain over a mapping in a language whose own chain the adapter doesn't run yet. */
function mappingChain(object: string, getter: string) {
  return runtimeReads({ object: global(object), entriesBy: "key" })
    .entries({}, { reads: "config", callee: "keyed" })
    .getters({ [getter]: KEY_GETTER })
    .functions({ getenv: FALLBACK_GETTER });
}

/** What a site says about how it reads, by its text: at a key or as a member, and what a computed key comes from. */
function howRead(read: ReadOps) {
  return [read.byKey(), read.computedKey()?.source?.() ?? null];
}

/** The site at each text among the reads, members included, the facts state. */
function factSiteAt({ db, source }: Stated, text: string): ReadOps {
  const key =
    ["readsEntry", "readsKeyed", "readsProperty", "call"]
      .flatMap((relation) => db.facts(relation).map((row) => String(row[0])))
      .find((one) => source.textOf(one) === text) ?? raise(`no site ${text}`);
  return factReadOps(key, source);
}

/** A chain's config reads at each call or site whose text is given, in that order, over facts. */
function factReadsAt(
  stated: Stated,
  chain: ReturnType<typeof runtimeReads>,
  texts: readonly string[],
) {
  const recognize = compile(chain.declared, RECOGNITION);
  return texts.flatMap((text) => {
    const read = factSiteAt(stated, text);
    const call = stated.db
      .facts("call")
      .map((row) => String(row[0]))
      .find((key) => stated.source.textOf(key) === text);
    const ops = call === undefined ? null : factCallOps(call, stated.source);
    return configReadsIn(recognize(null, { read, ops }) ?? []);
  });
}

/** The same over TypeScript, through the access context its walk hands a chain. */
function typescriptReadsAt(
  chain: ReturnType<typeof runtimeReads>,
  texts: readonly string[],
) {
  const { file, store } = typescriptSites(MAPPING_TYPESCRIPT);
  const recognize = compile(chain.declared, RECOGNITION);
  return texts.flatMap((text) => {
    const node =
      file
        .getDescendants()
        .find(
          (one) =>
            (Node.isPropertyAccessExpression(one) ||
              Node.isElementAccessExpression(one) ||
              Node.isCallExpression(one)) &&
            one.getText() === text,
        ) ?? raise(`no site ${text}`);
    return configReadsIn(
      recognize(node, accessContextFor(node as never, file, store)) ?? [],
    );
  });
}

/** Python's own reads, through the adapter's dispatch and its own chain. */
async function pythonOwnReads(text = MAPPING_PYTHON, unit = "reads") {
  const stated = await pythonSites(text);
  const body =
    stated.root
      .descendantsOfType("function_definition")
      .find((one) => one?.childForFieldName("name")?.text === unit) ??
    raise(`no function ${unit}`);
  return {
    stated,
    reads: configReadsIn(
      stdlibReads(body, stated.db).map(({ effect }) => effect),
    ),
  };
}

/** Ruby's own reads, through the adapter's dispatch and its own chain. */
async function rubyOwnReads(text = MAPPING_RUBY, unit = "reads") {
  const stated = await rubySites(text);
  const body =
    stated.root
      .descendantsOfType(["method", "singleton_method"])
      .find((one) => one?.childForFieldName("name")?.text === unit) ??
    raise(`no method ${unit}`);
  return {
    stated,
    reads: configReadsIn(
      rubyStdlibReads(body, stated.db).map(({ effect }) => effect),
    ),
  };
}

describe("a read chain over a mapping, in every language", () => {
  it("reads an entry at a key, and says what a computed key comes from", async () => {
    const { sites } = typescriptSites(MAPPING_TYPESCRIPT);
    const python = await pythonSites(MAPPING_PYTHON);
    const ruby = await rubySites(MAPPING_RUBY);
    expect([
      howRead(sites.at("process.env.A")),
      howRead(sites.at("process.env[name]")),
    ]).toEqual([
      [false, null],
      [true, "name"],
    ]);
    expect(
      ['os.environ["A"]', "os.environ[name]", "os.environ.get"].map((text) =>
        howRead(factSiteAt(python, text)),
      ),
    ).toEqual([
      [true, null],
      [true, "name"],
      [false, null],
    ]);
    expect(
      ['ENV["A"]', "ENV[name]"].map((text) => howRead(factSiteAt(ruby, text))),
    ).toEqual([
      [true, null],
      [true, "name"],
    ]);
  });

  it("spells a keyed callee from the object's path, and a computed key's as written", async () => {
    const python = await pythonOwnReads();
    const ruby = await rubyOwnReads();
    expect(
      typescriptReadsAt(mappingChain("process.env", "get"), [
        "process.env[name]",
      ]),
    ).toEqual([["process.env[name]", null, false, null]]);
    expect(
      python.reads.filter(([, name]) => name === "A" || name === "D"),
    ).toEqual([
      ['os.environ["A"]', "A", false, null],
      ['os.environ["D"]', "D", false, null],
    ]);
    expect(
      python.reads.find(([callee]) => callee === "os.environ[name]"),
    ).toEqual(["os.environ[name]", null, false, null]);
    expect(
      ruby.reads.filter(([, name]) => name === "A" || name === "D"),
    ).toEqual([
      ['ENV["A"]', "A", false, null],
      ['ENV["D"]', "D", false, null],
    ]);
    expect(ruby.reads.find(([callee]) => callee === "ENV[name]")).toEqual([
      "ENV[name]",
      null,
      false,
      null,
    ]);
  });

  it("reads a member of a mapping as no entry", async () => {
    const python = await pythonSites(MAPPING_PYTHON);
    const ruby = await rubySites(MAPPING_RUBY);
    const mapping = (object: string) =>
      runtimeReads({ object: global(object), entriesBy: "key" }).entries(
        {},
        { reads: "config" },
      );
    expect(
      typescriptReadsAt(mapping("process.env"), ["process.env.A"]),
    ).toEqual([]);
    expect(
      factReadsAt(python, mapping("os.environ"), ["os.environ.get"]),
    ).toEqual([]);
    expect(factReadsAt(ruby, mapping("ENV"), ["ENV.fetch"])).toEqual([]);
  });

  it("reads a getter's key as the source writes it, with one read at the call", async () => {
    const python = await pythonOwnReads();
    expect(
      typescriptReadsAt(mappingChain("process.env", "get"), [
        "process.env.get(KEY)",
      ]),
    ).toEqual([["process.env.get(KEY)", null, false, null]]);
    expect(
      python.reads.filter(([callee]) => callee === "os.environ.get(KEY)"),
    ).toEqual([["os.environ.get(KEY)", null, false, null]]);
    expect(
      (await rubyOwnReads()).reads.filter(
        ([callee]) => callee === "ENV.fetch(KEY)",
      ),
    ).toEqual([["ENV.fetch(KEY)", null, false, null]]);
  });

  it("reads a function the runtime provides, called bare or off its module", async () => {
    const python = await pythonOwnReads();
    expect(
      typescriptReadsAt(mappingChain("process.env", "get"), [
        'getenv("C", "c")',
      ]),
    ).toEqual([['process.env["C"]', "C", true, "c"]]);
    expect(
      python.reads.filter(([, name]) => name === "C" || name === "E"),
    ).toEqual([
      ['os.environ["C"]', "C", true, "c"],
      ['os.environ["E"]', "E", false, null],
    ]);
    expect(
      factReadsAt(await rubySites(MAPPING_RUBY), mappingChain("ENV", "fetch"), [
        'getenv("C", "c")',
      ]),
    ).toEqual([['ENV["C"]', "C", true, "c"]]);
  });

  it("takes the adapter's rule for a getter that passes no fallback", async () => {
    const python = await pythonOwnReads();
    expect(
      typescriptReadsAt(mappingChain("process.env", "get"), [
        'process.env.get("F")',
      ]),
    ).toEqual([['process.env["F"]', "F", true, "y"]]);
    expect(python.reads.filter(([, name]) => name === "F")).toEqual([
      ['os.environ["F"]', "F", true, "y"],
    ]);
    expect(
      (await rubyOwnReads()).reads.filter(
        ([, name]) => name === "F" || name === "S",
      ),
    ).toEqual([
      ['ENV["F"]', "F", true, "y"],
      ['ENV["S"]', "S", true, null],
    ]);
  });

  it("says what a site reads before asking whether the program copes, and a test before a raising read copes", async () => {
    const python = await pythonOwnReads();
    const ruby = await rubyOwnReads();
    const saidIn =
      (stated: Stated, chain: typeof ENVIRONMENT.declared) =>
      (text: string) => {
        const call = stated.db
          .facts("call")
          .map((row) => String(row[0]))
          .find((key) => stated.source.textOf(key) === text);
        return siteReadOf(chain, {
          read: factSiteAt(stated, text),
          ops: call === undefined ? null : factCallOps(call, stated.source),
        });
      };
    const pythonSaid = saidIn(python.stated, ENVIRONMENT.declared);
    const rubySaid = saidIn(ruby.stated, RUBY_ENVIRONMENT.declared);
    expect([
      pythonSaid('os.environ["A"]'),
      pythonSaid("os.environ[name]"),
      pythonSaid('os.getenv("C", "c")'),
      pythonSaid("os.environ.get"),
    ]).toMatchObject([
      { entry: "A", raises: true, passesFallback: false },
      { entry: null, keySource: "name", raises: true },
      { entry: "C", raises: false, passesFallback: true },
      null,
    ]);
    expect([
      rubySaid('ENV["A"]'),
      rubySaid("ENV[name]"),
      rubySaid('ENV.fetch("S")'),
      rubySaid("ENV.fetch(KEY)"),
    ]).toMatchObject([
      { entry: "A", raises: false, passesFallback: false },
      { entry: null, keySource: "name", raises: false },
      { entry: "S", raises: true, passesFallback: false },
      { entry: null, keySource: "KEY", raises: true },
    ]);
    expect(python.reads.filter(([, name]) => name === "R")).toEqual([
      ['os.environ["R"]', "R", true, null],
    ]);
    expect(ruby.reads.filter(([, name]) => name === "S")).toEqual([
      ['ENV["S"]', "S", true, null],
    ]);
  });

  it("reads a key a helper is handed by keyword, and never an entry the code assigns", async () => {
    const python = await pythonOwnReads();
    const ruby = await rubyOwnReads();
    const pythonNames = python.reads.map(([, name]) => name);
    const rubyNames = ruby.reads.map(([, name]) => name);
    expect(python.reads.filter(([, name]) => name === "H")).toEqual([
      ['os.environ["H"]', "H", false, null],
    ]);
    expect(ruby.reads.filter(([, name]) => name === "H")).toEqual([
      ['ENV["H"]', "H", false, null],
    ]);
    expect([
      pythonNames.includes("Z"),
      pythonNames.includes("P"),
      rubyNames.includes("Z"),
      rubyNames.includes("P"),
    ]).toEqual([false, false, false, false]);
  });

  it("finds a helper's key by position in TypeScript and Ruby, with no keyword", async () => {
    const { sites } = typescriptSites();
    const ruby = await rubySites();
    const keyOf = (keys: readonly SuppliedKey[] | null) =>
      (keys ?? []).map((key) => [key.at, key.keyword]);
    expect([
      keyOf(sites.at('need("G")').keysSuppliedTo(sites.object)),
      keyOf(ruby.sites.at('need("G")').keysSuppliedTo(ruby.sites.object)),
    ]).toEqual([[[0, undefined]], [[0, undefined]]]);
  });

  it("finds a Ruby helper's key by keyword", async () => {
    const ruby = await rubySites(MAPPING_RUBY);
    expect(
      (
        ruby.sites.at('need(name: "H")').keysSuppliedTo(ruby.sites.object) ?? []
      ).map((key) => [key.at, key.keyword, key.value.evaluated?.()]),
    ).toEqual([[-1, "name", "H"]]);
  });
});

/**
 * A unit whose second parameter the platform fills, found the way a
 * Workers pack finds a trigger, and a function beside it with the same
 * parameter that no pattern finds. Ruby states no export for a hash it
 * writes, so its unit comes from a manifest instead of an exported
 * object's members.
 */
const HANDED_IN_SPEC: UnitSpec = {
  kind: "handler",
  name: "fetch",
  handedIn: [{ at: 1, name: "env" }],
};

const MEMBERS: DeclaredDiscoveryPattern = {
  kind: "handler",
  match: {
    type: "namedExport",
    names: ["default"],
    members: { named: { fetch: HANDED_IN_SPEC } },
  },
};

const MANIFEST: DeclaredDiscoveryPattern = {
  kind: "handler",
  match: {
    type: "manifest",
    entries: () => [{ path: ["serve"], units: [HANDED_IN_SPEC] }],
  },
};

const HANDED_TYPESCRIPT = `
interface Env { GREETING: string; OTHER: string; HELPER: string; LOCAL: string }
function helper(settings: Env) {
  return settings.HELPER;
}
export default {
  async fetch(request: Request, env: Env) {
    const scoped = env;
    return env.GREETING + scoped.LOCAL + helper(env);
  },
};
export function other(request: Request, env: Env) {
  return env.OTHER;
}
`;

const HANDED_PYTHON = `def helper(settings):
    return settings.HELPER


def serve(request, env):
    scoped = env
    return env.GREETING + scoped.LOCAL + helper(env)


def other(request, env):
    return env.OTHER


default = {"fetch": serve}
`;

const HANDED_RUBY = `def helper(settings)
  settings.helper
end

def serve(request, env)
  scoped = env
  env.greeting + scoped.local + helper(env)
end

def other(request, env)
  env.other
end
`;

/** The reads each language writes, in its own spelling: off the parameter, off another function's, through a helper, through a local. */
const HANDED_READS = ["GREETING", "OTHER", "HELPER", "LOCAL"];

const OFF_HANDED_IN = [true, false, true, true];

/** Whether the read of each entry is off the handed-in parameter, by entry. */
function offHandedIn(
  db: Database,
  source: FactSource,
  entries: readonly string[],
): boolean[] {
  return entries.map((entry) => {
    const site =
      db.facts("readsProperty").find((row) => String(row[2]) === entry)?.[0] ??
      raise(`no read of ${entry}`);
    return factReadOps(String(site), source).isOff(handedIn("env"));
  });
}

/** The units the pattern finds in one file, through the module ops over its facts. */
function foundIn(
  source: FactSource,
  file: string,
  pattern: DeclaredDiscoveryPattern,
): DeclaredUnit[] {
  const module = factModuleOps(file, source, { calls: () => [] });
  return discoverDeclared(pattern.match, pattern.kind, module);
}

/** The config reads the env chain gives at one property read. */
function envChainReadsAt(
  read: PropertyAccessExpression,
  file: SourceFile,
  store: ResolutionStore,
) {
  const env = runtimeReads({ object: handedIn("env") }).entries(
    {},
    { reads: "config" },
  );
  const recognize = compile(env.declared, RECOGNITION);
  return configReadsIn(
    recognize(read, accessContextFor(read, file, store)) ?? [],
  );
}

describe("a parameter the platform fills, in every language", () => {
  it("is what a TypeScript unit's reads are off, and the chain reads it as env", () => {
    const project = createTestProject();
    const file = project.createSourceFile("/src/worker.ts", HANDED_TYPESCRIPT);
    const store = ResolutionStore.forPacks([]);
    const units = discoverUnits(file, [MEMBERS], store);
    for (const unit of units) {
      if (unit.func !== null && unit.handedIn !== undefined) {
        store.stateHandedIn(unit.func, unit.handedIn);
      }
    }
    const reads = HANDED_READS.map(
      (entry) =>
        file
          .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
          .find((node) => node.getName() === entry) ??
        raise(`no read of ${entry}`),
    );

    expect(units.map((unit) => unit.name)).toEqual(["fetch"]);
    expect(
      reads.map((read) => readOpsAt(read, store).isOff(handedIn("env"))),
    ).toEqual(OFF_HANDED_IN);
    expect(
      [reads[0], reads[2]].flatMap((read) =>
        read === undefined ? [] : envChainReadsAt(read, file, store),
      ),
    ).toEqual([
      ["env.GREETING", "GREETING", false, null],
      ["env.HELPER", "HELPER", false, null],
    ]);
  });

  it("is what a Python unit's reads are off", async () => {
    const tree = await parsePython(HANDED_PYTHON);
    const root = tree.rootNode;
    const module = bindModule(root);
    const db = pythonFacts({ file: "worker.py", root, module, packs: [] });
    const source = pythonFactSource(db);
    const units = foundIn(source, "worker.py", MEMBERS);
    for (const unit of units) {
      const func = pythonNodeId("worker.py", unit.func as never);
      stateHandedIn(db, func, unit.handedIn ?? []);
    }
    expect(units.map((unit) => unit.name)).toEqual(["fetch"]);
    expect(offHandedIn(db, source, HANDED_READS)).toEqual(OFF_HANDED_IN);
  });

  it("is what a Ruby unit's reads are off", async () => {
    const tree = await parseRuby(HANDED_RUBY);
    const db = rubyFacts({ file: "worker.rb", root: tree.rootNode, packs: [] });
    const source = rubyFactSource(db);
    const units = foundIn(source, "worker.rb", MANIFEST);
    for (const unit of units) {
      const func = rubyNodeId("worker.rb", unit.func as never);
      stateHandedIn(db, func, unit.handedIn ?? []);
    }
    expect(units.map((unit) => unit.name)).toEqual(["fetch"]);
    expect(
      offHandedIn(
        db,
        source,
        HANDED_READS.map((entry) => entry.toLowerCase()),
      ),
    ).toEqual(OFF_HANDED_IN);
  });
});

/** A call on a member read off the parameter, the same member kept in a local, and one read off something else. */
const STORE_TYPESCRIPT = `
interface Store { get(key: string): unknown }
interface Env { SESSIONS: Store }
declare const other: Env;
export default {
  async fetch(request: Request, env: Env) {
    env.SESSIONS.get("a");
    const held = env.SESSIONS;
    held.get("b");
    other.SESSIONS.get("c");
  },
};
`;

const STORE_PYTHON = `def serve(request, env):
    env.sessions.get("a")
    held = env.sessions
    held.get("b")
    other.sessions.get("c")


default = {"fetch": serve}
`;

const STORE_RUBY = `def serve(request, env)
  env.sessions.get("a")
  held = env.sessions
  held.get("b")
  OTHER.sessions.get("c")
end
`;

const OFF_ENV = readOff(handedIn("env"));

/** What each origin says of the receiver of every `get`, in source order. */
function receiversTaken(calls: readonly CallOps[]) {
  return {
    readOff: calls.map((call) => call.receiverIsFrom(OFF_ENV)),
    allOf: calls.map((call) =>
      call.receiverIsFrom(allOf(OFF_ENV, readOff(handedIn("env")))),
    ),
    allOfRefused: calls.map((call) =>
      call.receiverIsFrom(allOf(OFF_ENV, global("process.env"))),
    ),
  };
}

const TAKEN = {
  readOff: [true, true, false],
  allOf: [true, true, false],
  allOfRefused: [false, false, false],
};

/** Every call to `get` the facts state, by where it starts. */
function getsIn(db: Database, source: FactSource): CallOps[] {
  return db
    .facts("call")
    .filter((row) => source.textOf(String(row[1])).endsWith(".get"))
    .map((row) => String(row[0]))
    .sort((a, b) => startOf(a) - startOf(b))
    .map((call) => factCallOps(call, source) ?? raise(`no call at ${call}`));
}

/** Where a node key starts in its file, `worker.py:120-180` giving 120. */
function startOf(key: string): number {
  return Number((key.split(":")[1] ?? "").split("-")[0]);
}

describe("a receiver read off the parameter the platform fills, in every language", () => {
  it("is a member read off it, as written or kept in a local, in TypeScript", () => {
    const project = createTestProject();
    const file = project.createSourceFile("/src/worker.ts", STORE_TYPESCRIPT);
    const store = ResolutionStore.forPacks([]);
    for (const unit of discoverUnits(file, [MEMBERS], store)) {
      if (unit.func !== null && unit.handedIn !== undefined) {
        store.stateHandedIn(unit.func, unit.handedIn);
      }
    }
    const source = factSourceFor(store);
    const calls = file
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText().endsWith(".get"))
      .map(
        (call) =>
          factCallOps(statedFactKey(call, store), source) ??
          raise(`no call at ${call.getText()}`),
      );

    expect(receiversTaken(calls)).toEqual(TAKEN);
  });

  it("is a member read off it, as written or kept in a local, in Python", async () => {
    const tree = await parsePython(STORE_PYTHON);
    const root = tree.rootNode;
    const db = pythonFacts({
      file: "worker.py",
      root,
      module: bindModule(root),
      packs: [],
    });
    const source = pythonFactSource(db);
    for (const unit of foundIn(source, "worker.py", MEMBERS)) {
      const func = pythonNodeId("worker.py", unit.func as never);
      stateHandedIn(db, func, unit.handedIn ?? []);
    }

    expect(receiversTaken(getsIn(db, source))).toEqual(TAKEN);
  });

  it("is a member read off it, as written or kept in a local, in Ruby", async () => {
    const tree = await parseRuby(STORE_RUBY);
    const db = rubyFacts({ file: "worker.rb", root: tree.rootNode, packs: [] });
    const source = rubyFactSource(db);
    for (const unit of foundIn(source, "worker.rb", MANIFEST)) {
      const func = rubyNodeId("worker.rb", unit.func as never);
      stateHandedIn(db, func, unit.handedIn ?? []);
    }

    expect(receiversTaken(getsIn(db, source))).toEqual(TAKEN);
  });
});
