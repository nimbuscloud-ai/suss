import { Node, Project, ScriptTarget, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { processSurfaceRecognizer } from "./processSurface.js";

import type { Effect } from "@suss/behavioral-ir";

function makeFile(source: string): SourceFile {
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      strict: true,
      moduleResolution: 100,
    },
    useInMemoryFileSystem: true,
  });
  return project.createSourceFile("user.ts", source);
}

function recognizeAll(file: SourceFile): Effect[] {
  const rec = processSurfaceRecognizer();
  const out: Effect[] = [];
  file.forEachDescendant((node) => {
    if (
      !Node.isPropertyAccessExpression(node) &&
      !Node.isElementAccessExpression(node)
    ) {
      return;
    }
    const emitted = rec(node, { sourceFile: file });
    if (emitted !== null) {
      out.push(...emitted);
    }
  });
  return out;
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

  it("recognizes process.argv[N] with the index in the channel name", () => {
    const file = makeFile(`
      function handler() {
        const script = process.argv[1];
        return script;
      }
    `);
    const reads = configReadsOf(recognizeAll(file));
    const indexed = reads.find((r) => r.interaction.name === "argv[1]");
    expect(indexed).toBeDefined();
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
    const reads = configReadsOf(recognizeAll(file));
    const names = reads.map((r) => r.interaction.name).sort();
    expect(names).toEqual([
      "process.cwd",
      "process.platform",
      "process.version",
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
    expect(configReadsOf(recognizeAll(file))).toHaveLength(0);
  });
});
