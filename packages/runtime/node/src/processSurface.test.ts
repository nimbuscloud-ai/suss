import { describe, expect, it } from "vitest";

import { effectsOverFile, packWithOnly } from "@suss/pack-harness";
import { runExamples } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import nodeRuntimePack from "./index.js";
import { compiledReads, runtimeReadMatches } from "./runtimeReads.js";

import type { Effect } from "@suss/behavioral-ir";
import type { SourceFile } from "ts-morph";

function makeFile(source: string): SourceFile {
  const project = createTestProject();
  return project.createSourceFile("user.ts", source);
}

/** The chains over `process`, `import.meta` and the module globals. */
function recognizeAll(file: SourceFile): Effect[] {
  return effectsOverFile(
    file,
    packWithOnly(nodeRuntimePack(), {
      access: compiledReads(runtimeReadMatches({}).rest),
    }),
  );
}

function configReadsOf(effects: Effect[]) {
  return effects.filter(
    (e) => e.type === "interaction" && e.interaction.class === "config-read",
  ) as Array<
    Extract<Effect, { type: "interaction" }> & {
      interaction: { class: "config-read" };
    }
  >;
}

function metadataReadsOf(effects: Effect[]) {
  return effects.filter(
    (e) => e.type === "interaction" && e.interaction.class === "metadata-read",
  ) as Array<
    Extract<Effect, { type: "interaction" }> & {
      interaction: { class: "metadata-read" };
    }
  >;
}

describe("process-surface recognizer", () => {
  it("recognizes process.argv as a config-read", () => {
    const file = makeFile(`
      function handler() {
        const all = process.argv;
        return all;
      }
    `);
    const reads = configReadsOf(recognizeAll(file));
    const argv = reads.filter((r) => r.interaction.name === "argv");
    expect(argv).toHaveLength(1);
  });

  it("recognizes process.cwd / .platform / .version as runtime metadata", () => {
    const file = makeFile(`
      function handler() {
        const a = process.cwd;
        const b = process.platform;
        const c = process.version;
        return [a, b, c];
      }
    `);
    const reads = metadataReadsOf(recognizeAll(file));
    const names = reads.map((r) => r.interaction.name).sort();
    expect(names).toEqual([
      "process.cwd",
      "process.platform",
      "process.version",
    ]);
    for (const read of reads) {
      expect(read.binding.semantics).toEqual({ name: "runtime-config" });
    }
  });

  it("keeps process metadata out of the config reads a template is paired against", () => {
    const file = makeFile(`
      function handler() {
        const a = process.cwd;
        const b = process.pid;
        return [a, b];
      }
    `);
    expect(configReadsOf(recognizeAll(file))).toHaveLength(0);
  });

  it("keeps process.argv a config read, since a deployment sets the arguments", () => {
    const file = makeFile(`
      function handler() {
        return process.argv[2];
      }
    `);
    const effects = recognizeAll(file);
    expect(metadataReadsOf(effects)).toHaveLength(0);
    expect(configReadsOf(effects).map((r) => r.interaction.name)).toEqual([
      "argv",
      "argv[2]",
    ]);
  });

  it("recognizes process.argv[N] with the index in the channel name, written as the source writes it", () => {
    const file = makeFile(`
      function handler() {
        const script = process.argv[1] || "";
        const command = process.argv[next()];
        return [script, command];
      }
    `);
    const reads = configReadsOf(recognizeAll(file));
    expect(
      reads.map((r) => [r.callee, r.interaction.name, r.interaction.defaulted]),
    ).toEqual([
      ["process.argv", "argv", false],
      ["process.argv[1]", "argv[1]", true],
      ["process.argv", "argv", false],
    ]);
  });

  it("does NOT match process.env reads (handled by env-var pack)", () => {
    const file = makeFile(`
      function handler() {
        const k = process.env.STRIPE_API_KEY;
        return k;
      }
    `);
    const reads = configReadsOf(recognizeAll(file));
    expect(reads).toHaveLength(0);
  });

  it("does NOT match property accesses on a non-process root", () => {
    const file = makeFile(`
      const myProcess = { argv: [] as string[], cwd: () => "/" };
      function handler() {
        return [myProcess.argv, myProcess.cwd];
      }
    `);
    const effects = recognizeAll(file);
    expect(configReadsOf(effects)).toHaveLength(0);
    expect(metadataReadsOf(effects)).toHaveLength(0);
  });

  it("matches the line each read chain says it matches", () => {
    const pack = nodeRuntimePack();
    const ran = runExamples(pack, (code) =>
      effectsOverFile(
        makeFile(`export function example() { return ${code}; }`),
        packWithOnly(pack, { access: pack.accessRecognizers ?? [] }),
      ),
    ).filter((one) => one.match === "runtimeRead");
    expect(
      ran.map((one) =>
        one.effects.map((effect) =>
          effect.type === "interaction" ? effect.interaction.class : null,
        ),
      ),
    ).toEqual([
      ["config-read"],
      ["config-read"],
      ["config-read"],
      ["metadata-read"],
      ["metadata-read"],
    ]);
  });

  it("records a write of process.exitCode as the code it sets, and ignores a read of it", () => {
    const file = makeFile(`
      function finish(code: number) {
        process.exitCode = 1;
        process.exitCode = code;
        return process.exitCode;
      }
    `);
    expect(
      recognizeAll(file).filter((effect) => effect.type === "stateChange"),
    ).toEqual([
      { type: "stateChange", variable: "process.exitCode", newValue: 1 },
      { type: "stateChange", variable: "process.exitCode", newValue: "code" },
    ]);
  });
});
