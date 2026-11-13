/**
 * The read ops over the facts, asked about the same environment reads in
 * TypeScript, Python and Ruby: a plain read, a read with a fallback, an
 * assignment to an entry, and a read through a helper `need("G")`.
 * TypeScript also has a destructured read, and runs the Node pack's
 * chains through the access context. Python and Ruby each get a getter
 * chain here, run over their own facts, since their adapters still record
 * environment reads themselves.
 */

import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import {
  bindEnvFacts,
  bindModule,
  envFactsIn,
  parsePython,
  pythonFactSource,
  factsForFile as pythonFacts,
  nodeId as pythonNodeId,
} from "@suss/adapter-python";
import {
  emitEnvFacts,
  parseRuby,
  rubyFactSource,
  factsForFile as rubyFacts,
  nodeId as rubyNodeId,
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
