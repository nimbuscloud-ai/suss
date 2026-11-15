import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parsePython } from "./parser.js";
import { factsForFile } from "./project.js";
import { bindModule } from "./scope.js";
import { stdlibEffects } from "./stdlib/dispatch.js";
import { STREAM_WRITES } from "./stdlib/streams.js";

import type { Effect } from "@suss/behavioral-ir";
import type { PyNode } from "./parser.js";

interface Write {
  target: string | null;
  callee: string | undefined;
  serialized: string;
}

/** The writes in a module and in each function it defines, with the facts a project run would emit. */
async function writesIn(
  source: string,
  inFunction?: string,
): Promise<Effect[]> {
  const file = path.join(os.tmpdir(), "suss-stream-writes", "report.py");
  const tree = await parsePython(source);
  const module = bindModule(tree.rootNode);
  const db = factsForFile({ file, root: tree.rootNode, module, packs: [] });
  const root =
    inFunction === undefined
      ? tree.rootNode
      : findFunction(tree.rootNode, inFunction);
  return stdlibEffects(root, db).writes.map((one) => one.effect);
}

function findFunction(node: PyNode, name: string): PyNode {
  const found = node
    .descendantsOfType("function_definition")
    .find((one) => one?.childForFieldName("name")?.text === name);
  if (found === undefined || found === null) {
    throw new Error(`no function ${name}`);
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
    expect(new Set(groupIdsOf(effects)).size).toBe(4);
  });

  it("keys a write on what it writes and numbers a repeat, so moving the code keeps the key", async () => {
    const lines = ['print("sending")', 'print("careful")', 'print("sending")'];
    const before = groupIdsOf(await writesIn(lines.join("\n")));
    expect(before[0]).toMatch(/^print:[0-9a-f]{7}$/);
    expect(before[2]).toBe(`${before[0]}#2`);

    const moved = ["", "", "", ...lines].join("\n");
    expect(groupIdsOf(await writesIn(moved))).toEqual(before);
  });

  it("places a write at its call, with the location before the group id", async () => {
    const [write] = await writesIn(["", 'print("done")'].join("\n"));
    expect(write?.location).toEqual({ start: 2, end: 2 });
    expect(Object.keys(write ?? {}).slice(-2)).toEqual(["location", "groupId"]);
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
      groupId: expect.stringMatching(/^print:[0-9a-f]{7}$/),
    });
  });

  it("reads a stream imported by name, or under another name", async () => {
    const effects = await writesIn(
      [
        "from sys import stderr",
        "from sys import stdout as out",
        "import sys as system",
        'stderr.write("no")',
        'out.write("yes")',
        'system.stderr.write("maybe")',
        'print("to", file=out)',
      ].join("\n"),
    );
    expect(summarized(effects)).toEqual([
      { target: "stderr", callee: "stderr.write", serialized: "text" },
      { target: "stdout", callee: "out.write", serialized: "text" },
      { target: "stderr", callee: "system.stderr.write", serialized: "text" },
      { target: "stdout", callee: "print", serialized: "text" },
    ]);
  });

  it("keys several printed values by position, leaves keywords out, and keeps dumps off anything but json as text", async () => {
    const [several, separated, other, bare, nested] = await writesIn(
      [
        "import json",
        'print("id", 7)',
        'print("id", 7, sep=",", end="")',
        'print(serializer.dumps({"a": 1}))',
        "print(json.dumps())",
        'print(vendor.json.dumps({"a": 1}))',
      ].join("\n"),
    );
    const idAndSeven = {
      type: "record",
      properties: {
        "0": { type: "literal", value: "id" },
        "1": { type: "literal", value: 7 },
      },
    };
    expect(several).toMatchObject({
      interaction: { serialized: "text", payload: idAndSeven },
    });
    expect(separated).toMatchObject({
      interaction: { serialized: "text", payload: idAndSeven },
    });
    expect(other).toMatchObject({ interaction: { serialized: "text" } });
    expect(bare).toMatchObject({ interaction: { serialized: "text" } });
    expect(nested).toMatchObject({ interaction: { serialized: "text" } });
  });

  it("writes to the stream a helper's parameter is handed, or a local is set to", async () => {
    const source = [
      "import sys",
      "",
      "def say(out, line):",
      "    out.write(line)",
      "",
      "def run():",
      '    say(sys.stderr, "x")',
      "    held = sys.stdout",
      '    held.write("y")',
    ].join("\n");
    expect(summarized(await writesIn(source, "say"))).toEqual([
      { target: "stderr", callee: "out.write", serialized: "text" },
    ]);
    expect(summarized(await writesIn(source, "run"))).toEqual([
      { target: "stdout", callee: "held.write", serialized: "text" },
    ]);
  });

  it("reads a json.dumps report a template puts only whitespace around as JSON", async () => {
    const [write] = await writesIn(
      ["import json", 'print(f"{json.dumps({"ok": True})}\\n")'].join("\n"),
    );
    expect(write).toMatchObject({
      interaction: {
        serialized: "json",
        payload: { type: "record", properties: { ok: { type: "boolean" } } },
      },
    });
  });

  it("leaves a print to a file, a rebound print and a nested function alone", async () => {
    const source = [
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
      'print("row", file=handle)',
    ].join("\n");
    expect(await writesIn(source)).toEqual([]);
    expect(await writesIn(source, "report")).toEqual([]);
    expect(await writesIn(source, "shadowed")).toEqual([]);
  });

  it("matches each chain's own example", async () => {
    for (const chain of STREAM_WRITES) {
      const example = chain.declared.example ?? "";
      const written = await writesIn(`import sys\n${example}`);
      expect(written, example).toHaveLength(1);
    }
  });
});
