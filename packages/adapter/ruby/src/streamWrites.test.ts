import { describe, expect, it } from "vitest";

import { parseRuby } from "./parser.js";
import { streamWriteEffects } from "./streamWrites.js";

import type { Effect } from "@suss/behavioral-ir";

interface Write {
  target: string | null;
  callee: string | undefined;
  serialized: string;
}

async function writesIn(source: string): Promise<Effect[]> {
  const tree = await parseRuby(source);
  return streamWriteEffects(tree.rootNode).map((one) => one.effect);
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
      ].join("\n"),
    );
    expect(summarized(effects)).toEqual([
      { target: "stdout", callee: "puts", serialized: "text" },
      { target: "stdout", callee: "print", serialized: "text" },
      { target: "stderr", callee: "warn", serialized: "text" },
      { target: "stdout", callee: "$stdout.write", serialized: "text" },
      { target: "stdout", callee: "STDOUT.puts", serialized: "text" },
      { target: "stderr", callee: "$stderr.puts", serialized: "text" },
    ]);
    expect(new Set(groupIdsOf(effects)).size).toBe(6);
  });

  it("keys a write on what it writes and numbers a repeat, so moving the code keeps the key", async () => {
    const lines = ['puts "sending"', 'warn "careful"', 'puts "sending"'];
    const before = groupIdsOf(await writesIn(lines.join("\n")));
    expect(before[0]).toMatch(/^puts:[0-9a-f]{7}$/);
    expect(before[2]).toBe(`${before[0]}#2`);

    const moved = ["", "", "", ...lines].join("\n");
    expect(groupIdsOf(await writesIn(moved))).toEqual(before);
  });

  it("reads a JSON report as the shape of what was serialized", async () => {
    const [generated, converted] = await writesIn(
      [
        "puts JSON.generate({ run: [], passed: true })",
        "puts({ run: [] }.to_json)",
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
  });

  it("keys several printed values by position, and reads arrays, hashes and other dumps", async () => {
    const [several, list, hash, other] = await writesIn(
      [
        'puts "id", 7',
        "puts [1, 2]",
        "puts({ ok: true, **rest })",
        "puts Marshal.dump(report)",
        "abort",
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

  it("leaves a method call on anything else, and a nested method, alone", async () => {
    const effects = await writesIn(
      [
        'logger.puts "not a stream"',
        'file.write("row")',
        "def later",
        '  puts "later"',
        "end",
      ].join("\n"),
    );
    expect(effects).toEqual([]);
  });
});
