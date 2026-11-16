import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { parseRuby } from "./parser.js";
import { RunFacts } from "./project.js";
import { stdlibEffects } from "./stdlib/dispatch.js";
import { STREAM_WRITES } from "./stdlib/streams.js";

import type { Effect } from "@suss/behavioral-ir";
import type { RbNode } from "./parser.js";

interface Write {
  target: string | null;
  callee: string | undefined;
  serialized: string;
}

/** The writes a file makes when it loads, or one of its methods, over the facts a run with no pack states. */
async function writesIn(source: string, inMethod?: string): Promise<Effect[]> {
  const run = new RunFacts(new Database(), []);
  const tree = await parseRuby(source);
  run.addFile("report.rb", tree.rootNode);
  run.finish();
  const root =
    inMethod === undefined
      ? tree.rootNode
      : findMethod(tree.rootNode, inMethod);
  return stdlibEffects(root, run.db).writes.map((one) => one.effect);
}

function findMethod(node: RbNode, name: string): RbNode {
  const found = node
    .descendantsOfType(["method", "singleton_method"])
    .find((one) => one?.childForFieldName("name")?.text === name);
  if (found === undefined || found === null) {
    throw new Error(`no method ${name}`);
  }
  return found;
}

function summarized(effects: Effect[]): Write[] {
  return effects.map((effect) => {
    if (
      effect.type !== "interaction" ||
      effect.interaction.class !== "stream-write" ||
      effect.binding.semantics.name !== "io"
    ) {
      throw new Error(`not a stream write: ${JSON.stringify(effect)}`);
    }
    return {
      target: effect.binding.semantics.target,
      callee: effect.callee,
      serialized: effect.interaction.serialized,
    };
  });
}

function groupIdsOf(effects: Effect[]): Array<string | undefined> {
  return effects.map((effect) =>
    effect.type === "interaction" ? effect.groupId : undefined,
  );
}

describe("what a Ruby body prints", () => {
  it("reads Kernel's printing methods and the stream globals", async () => {
    const effects = await writesIn(
      [
        'puts "order received"',
        'print "no newline"',
        'warn "careful"',
        '$stdout.write("done")',
        'STDOUT.puts "again"',
        '$stderr.puts "failed"',
        'STDERR.print "and again"',
      ].join("\n"),
    );
    expect(summarized(effects)).toEqual([
      { target: "stdout", callee: "puts", serialized: "text" },
      { target: "stdout", callee: "print", serialized: "text" },
      { target: "stderr", callee: "warn", serialized: "text" },
      { target: "stdout", callee: "$stdout.write", serialized: "text" },
      { target: "stdout", callee: "STDOUT.puts", serialized: "text" },
      { target: "stderr", callee: "$stderr.puts", serialized: "text" },
      { target: "stderr", callee: "STDERR.print", serialized: "text" },
    ]);
    expect(new Set(groupIdsOf(effects)).size).toBe(7);
  });

  it("keys a write on what it writes and numbers a repeat, so moving the code keeps the key", async () => {
    const lines = ['puts "sending"', 'warn "careful"', 'puts "sending"'];
    const before = groupIdsOf(await writesIn(lines.join("\n")));
    expect(before[0]).toMatch(/^puts:[0-9a-f]{7}$/);
    expect(before[2]).toBe(`${before[0]}#2`);

    const moved = ["", "", "", ...lines].join("\n");
    expect(groupIdsOf(await writesIn(moved))).toEqual(before);
  });

  it("places a write at its call, with the location before the group id", async () => {
    const [write] = await writesIn(["", 'puts "done"'].join("\n"));
    expect(write?.location).toEqual({ start: 2, end: 2 });
    expect(Object.keys(write ?? {}).slice(-2)).toEqual(["location", "groupId"]);
  });

  it("reads a JSON report as the shape of what was serialized, alone or with only whitespace around it", async () => {
    const [generated, converted, templated] = await writesIn(
      [
        "puts JSON.generate({ run: [], passed: true })",
        "puts({ run: [] }.to_json)",
        '$stdout.puts "#{{ ok: true }.to_json}\\n"',
      ].join("\n"),
    );
    expect(generated).toMatchObject({
      interaction: {
        serialized: "json",
        payload: {
          type: "record",
          properties: { run: { type: "array" }, passed: { type: "boolean" } },
        },
      },
      groupId: expect.stringMatching(/^puts:[0-9a-f]{7}$/),
    });
    expect(converted).toMatchObject({
      interaction: { serialized: "json", payload: { type: "record" } },
    });
    expect(templated).toMatchObject({
      interaction: {
        serialized: "json",
        payload: { type: "record", properties: { ok: { type: "boolean" } } },
      },
    });
  });

  it("keys several printed values by position, and reads arrays, hashes and other dumps", async () => {
    const [several, list, hash, other] = await writesIn(
      [
        'puts "id", 7',
        "puts [1, 2]",
        "puts({ ok: true, **rest })",
        "puts Marshal.dump(report)",
      ].join("\n"),
    );
    expect(several).toMatchObject({
      interaction: {
        payload: {
          type: "record",
          properties: {
            "0": { type: "literal", value: "id" },
            "1": { type: "integer" },
          },
        },
      },
    });
    expect(list).toMatchObject({
      interaction: { payload: { type: "array", items: { type: "integer" } } },
    });
    expect(hash).toMatchObject({
      interaction: {
        payload: { type: "record", properties: { ok: { type: "boolean" } } },
      },
    });
    expect(other).toMatchObject({
      interaction: { serialized: "text", payload: { type: "unknown" } },
    });
  });

  it("reads abort with a message as a write to stderr, and abort with none as no write", async () => {
    const effects = await writesIn(
      ["abort", "abort()", 'abort("giving up")'].join("\n"),
    );
    expect(summarized(effects)).toEqual([
      { target: "stderr", callee: "abort", serialized: "text" },
    ]);
  });

  it("writes to the stream a helper's parameter is handed, a local is set to, or a top-level constant spells", async () => {
    const source = [
      "module Out",
      "  def self.say(out, line)",
      "    out.puts(line)",
      "  end",
      "",
      "  def self.run",
      '    say($stderr, "x")',
      "    held = $stdout",
      '    held.write("y")',
      '    ::STDERR.puts "z"',
      "  end",
      "end",
    ].join("\n");
    expect(summarized(await writesIn(source, "say"))).toEqual([
      { target: "stderr", callee: "out.puts", serialized: "text" },
    ]);
    expect(summarized(await writesIn(source, "run"))).toEqual([
      { target: "stdout", callee: "held.write", serialized: "text" },
      { target: "stderr", callee: "::STDERR.puts", serialized: "text" },
    ]);
  });

  it("reads a bare warn or puts in a class that defines its own as a call of that method", async () => {
    const source = [
      "class Lock",
      "  def warn(message)",
      "    Rails.logger.warn(message)",
      "  end",
      "",
      "  def puts(line)",
      "    @lines << line",
      "  end",
      "",
      "  def release",
      '    warn "lock lost"',
      '    puts "released"',
      '    print "done"',
      '    $stderr.puts "still a stream"',
      "  end",
      "end",
    ].join("\n");
    expect(summarized(await writesIn(source, "release"))).toEqual([
      { target: "stdout", callee: "print", serialized: "text" },
      { target: "stderr", callee: "$stderr.puts", serialized: "text" },
    ]);
  });

  it("keeps a write in a method's own parameter default on the method", async () => {
    const source = [
      "class Report",
      '  def render(header = puts("rendering"))',
      "    header",
      "  end",
      "end",
    ].join("\n");
    expect(summarized(await writesIn(source, "render"))).toEqual([
      { target: "stdout", callee: "puts", serialized: "text" },
    ]);
  });

  it("leaves a method call on anything else, and a nested method, alone", async () => {
    const effects = await writesIn(
      [
        'logger.puts "not a stream"',
        'file.write("row")',
        'Logger::STDOUT.puts "not the top-level constant"',
        "def later",
        '  puts "later"',
        "end",
      ].join("\n"),
    );
    expect(effects).toEqual([]);
  });

  it("matches each chain's own example", async () => {
    for (const chain of STREAM_WRITES) {
      const example = chain.declared.example ?? "";
      expect(await writesIn(example), example).toHaveLength(1);
    }
  });
});
