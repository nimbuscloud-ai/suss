/**
 * The stream-write ending on the same three writes in TypeScript, Python
 * and Ruby: a direct write, a write of a JSON encoding, and a write
 * through a parameter a caller passed a stream to. TypeScript runs the
 * Node pack's own declarations, and Python and Ruby their adapters' own.
 *
 * A test chain over a function the source calls as a global covers a
 * method that writes only when the call passes an argument, in every
 * language, and a keyword that says which stream, in the two languages
 * whose calls take keywords.
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
import type { InvocationRecognizer } from "@suss/extractor";

const RECOGNITION = "@suss/stream-write-test";

/** Writes only when the call passes an argument, as Ruby's `abort` does. */
const REPORT = streamWrites({ streams: {}, client: global("report") }).methods({
  report: { to: "stderr", onlyWithArguments: true },
});

/** A pack of declared stream writes, the way an adapter runs a pack's chains. */
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

const PYTHON_PACK = declaredPack("python-reports", [REPORT]);

const RUBY_PACK = declaredPack("ruby-logs", [
  streamWrites({
    streams: { $stdout: "stdout", $stderr: "stderr" },
    client: global("log"),
  }).methods({ log: { to: "stdout", streamAt: { keyword: "to" } } }),
  REPORT,
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

export function reports() {
  report();
  report("h");
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


def keywords(handle):
    print("d", file=sys.stderr)
    print("e", file=handle)
    print("f", "g", sep=",")


def reports():
    report()
    report("h")
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

  def self.keywords(handle)
    log("d", to: $stderr)
    log("e", to: handle)
    log("f", "g")
  end

  def self.reports
    report()
    report("h")
  end

  def self.quits
    abort()
  end

  def self.gives_up
    abort("i")
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

function typescriptEffects(
  written: string,
  recognizers: readonly InvocationRecognizer[] = nodeRuntimePack()
    .invocationRecognizers ?? [],
): Effect[] {
  const project = createTestProject();
  const file = project.createSourceFile("/cli.ts", written);
  const store = ResolutionStore.forPacks([nodeRuntimePack()]);
  const effects: Effect[] = [];
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const context = invocationContextFor(node, store);
    for (const hook of recognizers) {
      effects.push(...(hook(node, context) ?? []));
    }
  });
  return effects;
}

/** The effects of the summary whose name ends with the unit's own name. */
function effectsOf(
  summaries: readonly BehavioralSummary[],
  unit: string,
): Effect[] {
  return summaries
    .filter((summary) => summary.identity.name.endsWith(unit))
    .flatMap((summary) =>
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

async function pythonSummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "out/__init__.py")],
    roots: [root],
    packs: [PYTHON_PACK],
    modules: [{ name: "out", root: path.join(root, "out") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

async function rubySummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/out.rb")],
    packs: [RUBY_PACK],
    modules: [{ name: "out", root: path.join(root, "lib/out") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

/** A literal shape. TypeScript also records how the source wrote a number. */
function literal(value: number | string, raw?: string) {
  return { type: "literal", value, ...(raw === undefined ? {} : { raw }) };
}

const STDERR_TEXT = {
  target: "stderr",
  serialized: "text",
  payload: expect.anything(),
};

describe("the stream-write ending, in every language", () => {
  it("reads the three writes in TypeScript", () => {
    expect(
      streamWritesIn(typescriptEffects(TYPESCRIPT), "@suss/runtime-node"),
    ).toEqual([
      STDERR_TEXT,
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

  it("reads the same three in Python through the adapter's own chains", async () => {
    const summaries = await pythonSummaries();
    expect(
      streamWritesIn(effectsOf(summaries, "say"), "python-stdlib"),
    ).toEqual([STDERR_TEXT]);
    expect(
      streamWritesIn(effectsOf(summaries, "run"), "python-stdlib"),
    ).toEqual([
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
    ]);
  });

  it("reads the same three in Ruby through the adapter's own chains", async () => {
    const summaries = await rubySummaries();
    const integer = { type: "integer" };
    expect(streamWritesIn(effectsOf(summaries, "say"), "ruby-stdlib")).toEqual([
      STDERR_TEXT,
    ]);
    expect(streamWritesIn(effectsOf(summaries, "run"), "ruby-stdlib")).toEqual([
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
    ]);
  });

  it("writes only when the call passes an argument, when the method says so", async () => {
    const said = [
      { target: "stderr", serialized: "text", payload: literal("h") },
    ];
    const typescript = typescriptEffects(TYPESCRIPT, [
      compile(REPORT.declared, RECOGNITION),
    ]);
    expect(streamWritesIn(typescript, RECOGNITION)).toEqual(said);
    expect(
      streamWritesIn(
        effectsOf(await pythonSummaries(), "reports"),
        RECOGNITION,
      ),
    ).toEqual(said);
    const ruby = await rubySummaries();
    expect(streamWritesIn(effectsOf(ruby, "reports"), RECOGNITION)).toEqual(
      said,
    );
    expect(streamWritesIn(effectsOf(ruby, "quits"), "ruby-stdlib")).toEqual([]);
    expect(streamWritesIn(effectsOf(ruby, "gives_up"), "ruby-stdlib")).toEqual([
      { target: "stderr", serialized: "text", payload: literal("i") },
    ]);
  });

  it("writes to the stream a keyword spells, to none for a file, and only what is passed by position", async () => {
    const written = [
      { target: "stderr", serialized: "text", payload: literal("d") },
      {
        target: "stdout",
        serialized: "text",
        payload: {
          type: "record",
          properties: { "0": literal("f"), "1": literal("g") },
        },
      },
    ];
    expect(
      streamWritesIn(
        effectsOf(await pythonSummaries(), "keywords"),
        "python-stdlib",
      ),
    ).toEqual(written);
    expect(
      streamWritesIn(effectsOf(await rubySummaries(), "keywords"), RECOGNITION),
    ).toEqual(written);
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
