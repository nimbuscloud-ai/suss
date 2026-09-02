import { describe, expect, it } from "vitest";

import { envReadEffects } from "./envReads.js";
import { parseRuby } from "./parser.js";

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
