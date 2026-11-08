/**
 * The stream-write ending on the same three writes in TypeScript, Python
 * and Ruby: a direct write, a write of a JSON encoding, and a write
 * through a parameter a caller passed a stream to. TypeScript runs the
 * Node pack's own declarations. Python and Ruby each get a declaration
 * here, since their adapters still record stream writes themselves, and
 * the summaries keep that effect beside the declared one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Node } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import {
  invocationContextFor,
  ResolutionStore,
} from "@suss/adapter-typescript";
import nodeRuntimePack from "@suss/packs/node";
import { compile, global, streamWrites } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

const RECOGNITION = "@suss/stream-write-test";

/** A pack of declared stream writes, the way the Python and Ruby adapters load one. */
function declaredPack(
  name: string,
  writes: readonly ReturnType<typeof streamWrites>[],
) {
  return {
    name,
    protocol: "in-process",
    discovery: [],
    invocationRecognizers: writes.map((one) =>
      compile(one.declared, RECOGNITION),
    ),
    accessRecognizers: [],
  };
}

const PYTHON_PACK = declaredPack("python-streams", [
  streamWrites({
    streams: { "sys.stdout": "stdout", "sys.stderr": "stderr" },
    client: global("sys.stdout", "sys.stderr"),
  }).methods({ write: { to: "receiver" } }),
  streamWrites({ streams: {}, client: global("print") }).methods({
    print: { to: "stdout" },
  }),
]);

const RUBY_PACK = declaredPack("ruby-streams", [
  streamWrites({
    streams: { $stdout: "stdout", $stderr: "stderr" },
    client: global("$stdout", "$stderr"),
  }).methods({ write: { to: "receiver" } }),
  streamWrites({ streams: {}, client: global("puts") }).methods({
    puts: { to: "stdout" },
  }),
]);

const TYPESCRIPT = `
function say(out, line: string) {
  out.write(line);
}

export function run() {
  console.log({ a: 1 });
  process.stdout.write(JSON.stringify({ b: 2 }));
  say(process.stderr, "c");
}
`;

const PYTHON = `import json
import sys


def say(out, line):
    out.write(line)


def run():
    print({"a": 1})
    sys.stdout.write(json.dumps({"b": 2}))
    say(sys.stderr, "c")
`;

const RUBY = `require "json"

module Out
  def self.say(out, line)
    out.write(line)
  end

  def self.run
    puts({ a: 1 })
    $stdout.write(JSON.generate({ b: 2 }))
    say($stderr, "c")
  end
end
`;

type StreamWrite = Extract<Effect, { type: "interaction" }> & {
  interaction: { class: "stream-write" };
};

/** What a write says, without the parts every language spells its own way. */
function writeOf(effect: StreamWrite) {
  return {
    target:
      effect.binding.semantics.name === "io"
        ? effect.binding.semantics.target
        : "not io",
    serialized: effect.interaction.serialized,
    payload: effect.interaction.payload,
  };
}

function streamWritesIn(
  effects: readonly Effect[],
  recognition: string,
): ReturnType<typeof writeOf>[] {
  return effects
    .filter(
      (effect): effect is StreamWrite =>
        effect.type === "interaction" &&
        effect.interaction.class === "stream-write" &&
        effect.binding.recognition === recognition,
    )
    .map(writeOf);
}

function typescriptEffects(written: string): Effect[] {
  const project = createTestProject();
  const file = project.createSourceFile("/cli.ts", written);
  const pack = nodeRuntimePack();
  const store = ResolutionStore.forPacks([pack]);
  const effects: Effect[] = [];
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const context = invocationContextFor(node, store);
    for (const hook of pack.invocationRecognizers ?? []) {
      effects.push(...(hook(node, context) ?? []));
    }
  });
  return effects;
}

function effectsIn(summaries: readonly BehavioralSummary[]): Effect[] {
  return summaries.flatMap((summary) =>
    summary.transitions.flatMap((transition) => transition.effects),
  );
}

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-stream-writes-")),
  );
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "out/__init__.py"), PYTHON);
  fs.mkdirSync(path.join(root, "lib/out"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/out.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function pythonEffects(): Promise<Effect[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "out/__init__.py")],
    roots: [root],
    packs: [PYTHON_PACK],
    modules: [{ name: "out", root: path.join(root, "out") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return effectsIn(summaries);
}

async function rubyEffects(): Promise<Effect[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/out.rb")],
    packs: [RUBY_PACK],
    modules: [{ name: "out", root: path.join(root, "lib/out") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return effectsIn(summaries);
}

/** A literal shape. TypeScript also records how the source wrote a number. */
function literal(value: number | string, raw?: string) {
  return { type: "literal", value, ...(raw === undefined ? {} : { raw }) };
}

describe("the stream-write ending, in every language", () => {
  it("reads the three writes in TypeScript", () => {
    expect(
      streamWritesIn(typescriptEffects(TYPESCRIPT), "@suss/runtime-node"),
    ).toEqual([
      {
        target: "stderr",
        serialized: "text",
        payload: expect.anything(),
      },
      {
        target: "stdout",
        serialized: "text",
        payload: { type: "record", properties: { a: literal(1, "1") } },
      },
      {
        target: "stdout",
        serialized: "json",
        payload: { type: "record", properties: { b: literal(2, "2") } },
      },
    ]);
  });

  it("reads the same three in Python, beside the adapter's own two", async () => {
    const effects = await pythonEffects();
    expect(streamWritesIn(effects, RECOGNITION)).toEqual(
      expect.arrayContaining([
        { target: "stderr", serialized: "text", payload: expect.anything() },
        {
          target: "stdout",
          serialized: "text",
          payload: { type: "record", properties: { a: literal(1) } },
        },
        {
          target: "stdout",
          serialized: "json",
          payload: { type: "record", properties: { b: literal(2) } },
        },
      ]),
    );
    expect(streamWritesIn(effects, RECOGNITION)).toHaveLength(3);
    expect(streamWritesIn(effects, "python-stdlib")).toHaveLength(2);
  });

  it("reads the same three in Ruby, beside the adapter's own two", async () => {
    const effects = await rubyEffects();
    const integer = { type: "integer" };
    expect(streamWritesIn(effects, RECOGNITION)).toEqual(
      expect.arrayContaining([
        { target: "stderr", serialized: "text", payload: expect.anything() },
        {
          target: "stdout",
          serialized: "text",
          payload: { type: "record", properties: { a: integer } },
        },
        {
          target: "stdout",
          serialized: "json",
          payload: { type: "record", properties: { b: integer } },
        },
      ]),
    );
    expect(streamWritesIn(effects, RECOGNITION)).toHaveLength(3);
    expect(streamWritesIn(effects, "ruby-stdlib")).toHaveLength(2);
  });

  // The fact ops read the method off any member read, so this matches
  // where the recognizer the declarations replaced did not.
  it("reads a console method written as an element access in TypeScript", () => {
    const effects = typescriptEffects(
      'export function run() { console["log"]("d"); }',
    );
    expect(streamWritesIn(effects, "@suss/runtime-node")).toEqual([
      { target: "stdout", serialized: "text", payload: literal("d") },
    ]);
  });
});
