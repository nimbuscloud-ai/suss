import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { emitEnvFacts, envReadEffects } from "./envReads.js";
import {
  collectFileConstants,
  emitConstantBindings,
} from "./facts/constants.js";
import { emitValueFacts } from "./facts/values.js";
import { parseRuby } from "./parser.js";
import { bindEvaluator, methodDefinitionsIn } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { RbNode } from "./parser.js";

interface Read {
  name: string;
  defaulted: boolean;
}

function readsOf(effects: Effect[]): Read[] {
  return effects.map((effect) => {
    if (
      effect.type !== "interaction" ||
      effect.interaction.class !== "config-read"
    ) {
      throw new Error(`not a config read: ${JSON.stringify(effect)}`);
    }
    return {
      name: effect.interaction.name,
      defaulted: effect.interaction.defaulted,
    };
  });
}

async function fileReads(source: string): Promise<Read[]> {
  const tree = await parseRuby(source);
  return readsOf(envReadEffects(tree.rootNode));
}

async function methodReads(source: string, name: string): Promise<Read[]> {
  const tree = await parseRuby(source);
  return readsOf(envReadEffects(findMethod(tree.rootNode, name)));
}

function findMethod(node: RbNode, name: string): RbNode {
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (
      child.type === "method" &&
      child.childForFieldName("name")?.text === name
    ) {
      return child;
    }
    const inner = findMethodOrNull(child, name);
    if (inner !== null) {
      return inner;
    }
  }
  throw new Error(`no method ${name}`);
}

function findMethodOrNull(node: RbNode, name: string): RbNode | null {
  try {
    return findMethod(node, name);
  } catch {
    return null;
  }
}

/** The facts a run over these files would have, with the evaluator bound to them. */
async function projectFacts(files: Record<string, string>) {
  const db = new Database();
  const parsed: { file: string; root: RbNode }[] = [];
  const constants = [];
  const definitions = new Map<string, RbNode>();
  for (const [file, source] of Object.entries(files)) {
    const tree = await parseRuby(source);
    parsed.push({ file, root: tree.rootNode });
    emitValueFacts(db, file, tree.rootNode);
    emitEnvFacts(db, file, tree.rootNode);
    for (const [key, method] of methodDefinitionsIn(file, tree.rootNode)) {
      definitions.set(key, method);
    }
    constants.push(collectFileConstants(file, tree.rootNode));
  }
  emitConstantBindings(db, constants);
  bindEvaluator(db, { files: parsed, definitions });
  return { db, parsed };
}

/** What `use.rb` reports when it loads, with every other file in the run beside it. */
async function projectReads(files: Record<string, string>): Promise<Read[]> {
  const { db, parsed } = await projectFacts(files);
  const entry = parsed.find(({ file }) => file === "use.rb");
  if (entry === undefined) {
    throw new Error("no use.rb");
  }
  return readsOf(envReadEffects(entry.root, { db, file: "use.rb" }));
}

/** The same, for what one method of `use.rb` reads when it runs. */
async function projectMethodReads(
  files: Record<string, string>,
  name: string,
): Promise<Read[]> {
  const { db, parsed } = await projectFacts(files);
  const entry = parsed.find(({ file }) => file === "use.rb");
  if (entry === undefined) {
    throw new Error("no use.rb");
  }
  return readsOf(
    envReadEffects(findMethod(entry.root, name), { db, file: "use.rb" }),
  );
}

/** The helper from the issue: a module method that reads whatever name it is given. */
const SETTINGS = [
  "module Settings",
  "  def self.setting(key)",
  "    ENV.fetch(key)",
  "  end",
  "end",
  "",
].join("\n");

describe("ENV spellings", () => {
  it('reads ENV["X"] as a read with no fallback', async () => {
    expect(await fileReads("A = ENV[\"A\"]\nB = ENV['B']\n")).toEqual([
      { name: "A", defaulted: false },
      { name: "B", defaulted: false },
    ]);
  });

  it('reads ENV.fetch("X") as undefaulted, and defaulted with a second argument or a block', async () => {
    expect(
      await fileReads(
        'A = ENV.fetch("A")\nB = ENV.fetch("B", "d")\nC = ENV.fetch("C") { "d" }\nD = ENV.fetch("D") do\n  "d"\nend\nE = ENV.fetch("E", nil)\n',
      ),
    ).toEqual([
      { name: "A", defaulted: false },
      { name: "B", defaulted: true },
      { name: "C", defaulted: true },
      { name: "D", defaulted: true },
      { name: "E", defaulted: true },
    ]);
  });

  it("counts an || fallback as a default, anywhere but the chain's tail", async () => {
    expect(
      await fileReads(
        'A = ENV["A"] || "d"\nB = (ENV.fetch("B")) || "d"\nC = other || ENV["C"] || "d"\nD = other || ENV["D"]\n',
      ),
    ).toEqual([
      { name: "A", defaulted: true },
      { name: "B", defaulted: true },
      { name: "C", defaulted: true },
      { name: "D", defaulted: false },
    ]);
  });

  it("reads ::ENV the same as ENV", async () => {
    expect(
      await fileReads('A = ::ENV["A"]\nB = ::ENV.fetch("B", "d")\n'),
    ).toEqual([
      { name: "A", defaulted: false },
      { name: "B", defaulted: true },
    ]);
  });

  it("skips a read whose name is not a string literal", async () => {
    expect(
      await fileReads(
        'A = ENV[name]\nB = ENV.fetch("#{prefix}_B")\nC = ENV[:C]\n',
      ),
    ).toEqual([]);
  });

  it("ignores writes, membership tests, and other objects' fetch", async () => {
    expect(
      await fileReads(
        'ENV["A"] = "1"\nif ENV.key?("B")\nend\nC = config.fetch("C")\nD = Settings::ENV["D"]\n',
      ),
    ).toEqual([]);
  });
});

describe("what runs when the file loads", () => {
  it("reads the file body, class bodies and blocks, and leaves method bodies to their own units", async () => {
    expect(
      await fileReads(
        'A = ENV["A"]\nclass Settings\n  B = ENV["B"]\n  def self.c\n    ENV["C"]\n  end\n  def d\n    ENV["D"]\n  end\nend\nconfigure { E = ENV["E"] }\nf = -> { ENV["F"] }\n',
      ),
    ).toEqual([
      { name: "A", defaulted: false },
      { name: "B", defaulted: false },
      { name: "E", defaulted: false },
    ]);
  });
});

describe("what a method body reads", () => {
  it("reads the body and stops at a nested method or lambda", async () => {
    expect(
      await methodReads(
        'class Handler\n  def call\n    a = ENV["A"]\n    later = -> { ENV["B"] }\n    a\n  end\nend\n',
        "call",
      ),
    ).toEqual([{ name: "A", defaulted: false }]);
  });

  it("spells every read as ENV[...] so the checker names one channel", async () => {
    const tree = await parseRuby('A = ENV.fetch("A")\n');
    const [effect] = envReadEffects(tree.rootNode);
    expect(effect).toMatchObject({
      type: "interaction",
      callee: 'ENV["A"]',
      binding: {
        transport: "os",
        semantics: { name: "runtime-config", deploymentTarget: "lambda" },
        recognition: "ruby-env",
      },
    });
  });
});

describe("a name handed to a project helper", () => {
  it("reports the read at the call, with the name the caller wrote", async () => {
    expect(
      await projectReads({
        "settings.rb": SETTINGS,
        "use.rb": 'Redis.new(url: Settings.setting("REDIS_URL"))\n',
      }),
    ).toEqual([{ name: "REDIS_URL", defaulted: false }]);
  });

  it("takes defaulted from the read inside the helper", async () => {
    expect(
      await projectReads({
        "settings.rb": [
          "module Settings",
          "  def self.setting(key, fallback)",
          "    ENV.fetch(key, fallback)",
          "  end",
          "end",
          "",
        ].join("\n"),
        "use.rb": 'URL = Settings.setting("REDIS_URL", "redis://localhost")\n',
      }),
    ).toEqual([{ name: "REDIS_URL", defaulted: true }]);
  });

  it("follows a helper that hands the name to another helper", async () => {
    expect(
      await projectReads({
        "settings.rb": SETTINGS,
        "wrap.rb": [
          "module Config",
          "  def self.get(name)",
          "    Settings.setting(name)",
          "  end",
          "end",
          "",
        ].join("\n"),
        "use.rb": 'URL = Config.get("DATABASE_URL")\n',
      }),
    ).toEqual([{ name: "DATABASE_URL", defaulted: false }]);
  });

  it("reads the name out of a keyword argument", async () => {
    expect(
      await projectReads({
        "settings.rb": [
          "module Settings",
          "  def self.setting(key:)",
          "    ENV[key]",
          "  end",
          "end",
          "",
        ].join("\n"),
        "use.rb": 'URL = Settings.setting(key: "QUEUE_URL")\n',
      }),
    ).toEqual([{ name: "QUEUE_URL", defaulted: false }]);
  });

  it("follows an instance method called on self inside a class", async () => {
    expect(
      await projectMethodReads(
        {
          "use.rb": [
            "class Loader",
            "  def setting(key)",
            "    ENV.fetch(key)",
            "  end",
            "",
            "  def call",
            '    setting("CACHE_URL")',
            "  end",
            "end",
            "",
          ].join("\n"),
        },
        "call",
      ),
    ).toEqual([{ name: "CACHE_URL", defaulted: false }]);
  });

  it("reads a constant the module sets by calling its own helper", async () => {
    expect(
      await projectReads({
        "use.rb": [
          "module Settings",
          "  def self.env(key, default = nil)",
          "    ENV.fetch(key, default)",
          "  end",
          "",
          "  def self.setting(name)",
          "    Settings.env(name)",
          "  end",
          "",
          '  DATABASE_URL = setting("DATABASE_URL")',
          '  REGION = env("AWS_REGION", "us-east-1")',
          "end",
          "",
        ].join("\n"),
      }),
    ).toEqual([
      { name: "DATABASE_URL", defaulted: true },
      { name: "AWS_REGION", defaulted: true },
    ]);
  });

  it("counts an || around the call as a default", async () => {
    expect(
      await projectReads({
        "settings.rb": SETTINGS,
        "use.rb":
          'URL = Settings.setting("REDIS_URL") || "redis://localhost"\n',
      }),
    ).toEqual([{ name: "REDIS_URL", defaulted: true }]);
  });

  it("reads a name a constant in the caller's file holds", async () => {
    expect(
      await projectReads({
        "settings.rb": SETTINGS,
        "use.rb": [
          'NAME = "SEARCH_URL"',
          "URL = Settings.setting(NAME)",
          "",
        ].join("\n"),
      }),
    ).toEqual([{ name: "SEARCH_URL", defaulted: false }]);
  });

  it("reports one read when two sites in the helper share a name, defaulted only if both are", async () => {
    expect(
      await projectReads({
        "settings.rb": [
          "module Settings",
          "  def self.setting(key)",
          '    ENV.fetch(key, "d")',
          "    ENV.fetch(key)",
          "  end",
          "end",
          "",
        ].join("\n"),
        "use.rb": 'URL = Settings.setting("REDIS_URL")\n',
      }),
    ).toEqual([{ name: "REDIS_URL", defaulted: false }]);
  });

  it("reads a name passed to a lambda a constant holds", async () => {
    expect(
      await projectReads({
        "use.rb": [
          "GET = ->(key) { ENV.fetch(key) }",
          'URL = GET.call("SEARCH_URL")',
          "",
        ].join("\n"),
      }),
    ).toEqual([{ name: "SEARCH_URL", defaulted: false }]);
  });

  it("reads a name passed to a lambda run without writing call", async () => {
    expect(
      await projectReads({
        "use.rb": [
          "GET = ->(key) { ENV.fetch(key) }",
          'URL = GET.("SEARCH_URL")',
          "",
        ].join("\n"),
      }),
    ).toEqual([{ name: "SEARCH_URL", defaulted: false }]);
  });

  it("reads a name passed to a lambda a method returned", async () => {
    expect(
      await projectReads({
        "use.rb": [
          "def make_reader",
          "  ->(key) { ENV.fetch(key) }",
          "end",
          "",
          "GET = make_reader",
          'URL = GET.call("SEARCH_URL")',
          "",
        ].join("\n"),
      }),
    ).toEqual([{ name: "SEARCH_URL", defaulted: false }]);
  });

  it("reads a name forwarded to a lambda a method returned", async () => {
    expect(
      await projectReads({
        "use.rb": [
          "def make_reader",
          "  ->(key) { ENV.fetch(key) }",
          "end",
          "",
          "GET = make_reader",
          "",
          "def setting(name)",
          "  GET.call(name)",
          "end",
          "",
          'URL = setting("SEARCH_URL")',
          "",
        ].join("\n"),
      }),
    ).toEqual([{ name: "SEARCH_URL", defaulted: false }]);
  });

  it("reads a name through a lambda closed over an environment it was handed", async () => {
    expect(
      await projectReads({
        "use.rb": [
          "def make_reader(env)",
          "  ->(name) { env.fetch(name) }",
          "end",
          "",
          "REQUIRE_ENV = make_reader(ENV)",
          'TABLE = REQUIRE_ENV.call("TABLE_NAME")',
          "",
        ].join("\n"),
      }),
    ).toEqual([{ name: "TABLE_NAME", defaulted: false }]);
  });

  it("reads a name off a constant declared as the environment", async () => {
    expect(
      await projectReads({
        "use.rb": [
          "ENVIRONMENT = ENV",
          "",
          "def read(name)",
          "  ENVIRONMENT[name]",
          "end",
          "",
          'TABLE = read("TABLE_NAME")',
          "",
        ].join("\n"),
      }),
    ).toEqual([{ name: "TABLE_NAME", defaulted: false }]);
  });

  it("follows the environment through two calls", async () => {
    expect(
      await projectReads({
        "use.rb": [
          "def make_reader(env)",
          "  ->(name) { env.fetch(name) }",
          "end",
          "",
          "def build(source)",
          "  make_reader(source)",
          "end",
          "",
          "REQUIRE_ENV = build(ENV)",
          'TABLE = REQUIRE_ENV.call("TABLE_NAME")',
          "",
        ].join("\n"),
      }),
    ).toEqual([{ name: "TABLE_NAME", defaulted: false }]);
  });

  it("says nothing when the factory is handed a plain hash instead", async () => {
    expect(
      await projectReads({
        "use.rb": [
          "def make_reader(source)",
          "  ->(name) { source.fetch(name) }",
          "end",
          "",
          'SETTINGS = { "TABLE_NAME" => "orders" }',
          "REQUIRE_ENV = make_reader(SETTINGS)",
          'TABLE = REQUIRE_ENV.call("TABLE_NAME")',
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("says nothing where the lambda a method returned never reads the environment", async () => {
    expect(
      await projectReads({
        "use.rb": [
          "def make_logger(tag)",
          "  ->(message) { tag + message }",
          "end",
          "",
          "def env(key)",
          "  ENV.fetch(key)",
          "end",
          "",
          "LOG = make_logger('app')",
          'SAID = LOG.call("SEARCH_URL")',
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("says nothing for a call whose parameter never reaches an env read", async () => {
    expect(
      await projectReads({
        "settings.rb": [
          "module Settings",
          "  def self.log(message)",
          "    message",
          "  end",
          "end",
          "",
        ].join("\n"),
        "use.rb": 'Settings.log("REDIS_URL")\n',
      }),
    ).toEqual([]);
  });

  it("says nothing when the argument is not a string the run can read", async () => {
    expect(
      await projectReads({
        "settings.rb": SETTINGS,
        "use.rb": "URL = Settings.setting(whatever)\n",
      }),
    ).toEqual([]);
  });

  it("calls no object the environment in a project whose every read is a literal", async () => {
    const { db } = await projectFacts({
      "use.rb": 'A = ENV["A"]\nB = ENV.fetch("B", "d")\n',
    });
    expect(db.facts("environmentObject")).toEqual([]);
    expect(db.facts("readsKeyed")).toEqual([]);
  });

  it("states the container and the name expression for a read through a parameter", async () => {
    const { db } = await projectFacts({ "settings.rb": SETTINGS });
    const funcKey = [
      ...methodDefinitionsIn(
        "settings.rb",
        (await parseRuby(SETTINGS)).rootNode,
      ).keys(),
    ];
    expect(funcKey).toHaveLength(1);
    const object = db.facts("environmentObject").map((row) => String(row[0]));
    expect(object).toHaveLength(1);
    expect(
      db.facts("readsKeyed").map((row) => [String(row[1]), String(row[2])]),
    ).toEqual([[String(object[0]), `${funcKey[0]}#key`]]);
  });
});
