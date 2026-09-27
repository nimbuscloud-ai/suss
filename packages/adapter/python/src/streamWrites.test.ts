import { describe, expect, it } from "vitest";

import { EffectSchema } from "@suss/behavioral-ir/schemas";

import { parsePython } from "./parser.js";
import { bindModule } from "./scope.js";
import { streamWriteEffects } from "./streamWrites.js";

import type { Effect } from "@suss/behavioral-ir";

interface Write {
  target: string | null;
  callee: string | undefined;
  serialized: string;
}

async function writesIn(source: string): Promise<Effect[]> {
  const tree = await parsePython(source);
  return streamWriteEffects(tree.rootNode, bindModule(tree.rootNode));
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

describe("what a Python body prints", () => {
  it("reads print as a write to stdout, and to stderr when file says so", async () => {
    const effects = await writesIn(
      [
        "import sys",
        'print("order received")',
        'print("failed", file=sys.stderr)',
        'sys.stdout.write("done\\n")',
        'sys.stderr.write("oops\\n")',
      ].join("\n"),
    );
    expect(summarized(effects)).toEqual([
      { target: "stdout", callee: "print", serialized: "text" },
      { target: "stderr", callee: "print", serialized: "text" },
      { target: "stdout", callee: "sys.stdout.write", serialized: "text" },
      { target: "stderr", callee: "sys.stderr.write", serialized: "text" },
    ]);
    for (const effect of effects) {
      expect(EffectSchema.safeParse(effect).success).toBe(true);
    }
  });

  it("reads a json.dumps report as the shape of what was serialized", async () => {
    const [write] = await writesIn(
      ["import json", 'print(json.dumps({"run": [], "passed": True}))'].join(
        "\n",
      ),
    );
    expect(write).toMatchObject({
      interaction: {
        class: "stream-write",
        serialized: "json",
        payload: {
          type: "record",
          properties: { run: { type: "array" }, passed: { type: "boolean" } },
        },
      },
      groupId: "2:1",
    });
  });

  it("reads a stream imported by name", async () => {
    const effects = await writesIn(
      ["from sys import stderr", 'stderr.write("no")'].join("\n"),
    );
    expect(summarized(effects)).toEqual([
      { target: "stderr", callee: "stderr.write", serialized: "text" },
    ]);
  });

  it("leaves a print to a file, a rebound print and a nested function alone", async () => {
    const effects = await writesIn(
      [
        "def report(out):",
        '    print("row", file=out)',
        "    def later():",
        '        print("later")',
        "",
        "def shadowed(print):",
        '    print("not the builtin")',
        "",
        "handle = open('log.txt', 'w')",
        'handle.write("row")',
      ].join("\n"),
    );
    expect(effects).toEqual([]);
  });
});
