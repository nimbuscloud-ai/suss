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
  return streamWriteEffects(tree.rootNode);
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
    expect(
      effects.map((effect) => effect.type === "interaction" && effect.groupId),
    ).toEqual(["1:1", "2:1", "3:1", "4:1", "5:1", "6:1"]);
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
      groupId: "1:1",
    });
    expect(converted).toMatchObject({
      interaction: { serialized: "json", payload: { type: "record" } },
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
