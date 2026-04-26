import {
  Node,
  Project,
  type PropertyAccessExpression,
  ScriptTarget,
  type SourceFile,
} from "ts-morph";
import { describe, expect, it } from "vitest";

import { findProcessEnvReads, processEnvFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

const raise = (msg: string): never => {
  throw new Error(msg);
};

function makeProject(userSource: string): SourceFile {
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      strict: true,
      moduleResolution: 100,
    },
    useInMemoryFileSystem: true,
  });
  return project.createSourceFile("user.ts", userSource);
}

function recognizeAll(sourceFile: SourceFile): Effect[] {
  const pack = processEnvFramework();
  const recognizer = pack.accessRecognizers?.[0] ?? raise("no recognizer");
  const effects: Effect[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isPropertyAccessExpression(node)) {
      return;
    }
    const ctx = { access: node, sourceFile };
    const emitted = recognizer(node as PropertyAccessExpression, ctx);
    if (emitted !== null) {
      effects.push(...emitted);
    }
  });
  return effects;
}

function configReadEffectsOf(effects: Effect[]): Array<
  Extract<Effect, { type: "interaction" }> & {
    interaction: { class: "config-read" };
  }
> {
  const out: Array<
    Extract<Effect, { type: "interaction" }> & {
      interaction: { class: "config-read" };
    }
  > = [];
  for (const e of effects) {
    if (e.type === "interaction" && e.interaction.class === "config-read") {
      out.push(
        e as Extract<Effect, { type: "interaction" }> & {
          interaction: { class: "config-read" };
        },
      );
    }
  }
  return out;
}

describe("process-env recognizer — happy path", () => {
  it("recognizes process.env.X reads", () => {
    const file = makeProject(`
      const key = process.env.STRIPE_API_KEY;
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.interaction).toMatchObject({
      class: "config-read",
      name: "STRIPE_API_KEY",
      defaulted: false,
    });
  });

  it("recognizes process.env.X inside an arg position", () => {
    const file = makeProject(`
      function send(_key: string | undefined) {}
      send(process.env.QUEUE_URL);
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.interaction.name).toBe("QUEUE_URL");
  });

  it("marks defaulted=true when used with ?? fallback", () => {
    const file = makeProject(`
      const port = process.env.PORT ?? "3000";
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.interaction).toMatchObject({
      name: "PORT",
      defaulted: true,
    });
  });

  it("does NOT mark defaulted when env-var is the FALLBACK side of ??", () => {
    const file = makeProject(`
      function getPort(): string | undefined { return undefined; }
      const port = getPort() ?? process.env.PORT;
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.interaction.defaulted).toBe(false);
  });

  it("recognizes multiple env reads in one file", () => {
    const file = makeProject(`
      const a = process.env.AWS_REGION;
      const b = process.env.STRIPE_KEY;
      const c = process.env.DATABASE_URL;
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads.map((r) => r.interaction.name).sort()).toEqual([
      "AWS_REGION",
      "DATABASE_URL",
      "STRIPE_KEY",
    ]);
  });

  it("emits a config-read binding with runtime-config semantics", () => {
    const file = makeProject(`
      const x = process.env.FOO;
    `);
    const read = configReadEffectsOf(recognizeAll(file))[0] ?? raise("no read");
    expect(read.binding.semantics).toMatchObject({
      name: "runtime-config",
      deploymentTarget: "lambda",
    });
  });

  it("threads deploymentTarget option into the binding", () => {
    const file = makeProject(`
      const x = process.env.FOO;
    `);
    const pack = processEnvFramework({ deploymentTarget: "ecs-task" });
    const recognizer = pack.accessRecognizers?.[0] ?? raise("no recognizer");
    const effects: Effect[] = [];
    file.forEachDescendant((node) => {
      if (Node.isPropertyAccessExpression(node)) {
        const emitted = recognizer(node, { access: node, sourceFile: file });
        if (emitted !== null) {
          effects.push(...emitted);
        }
      }
    });
    const read = configReadEffectsOf(effects)[0] ?? raise("no read");
    expect(read.binding.semantics).toMatchObject({
      deploymentTarget: "ecs-task",
    });
  });
});

describe("process-env recognizer — rejection cases", () => {
  it("ignores property accesses that aren't process.env.X", () => {
    const file = makeProject(`
      const obj = { env: { X: "y" } };
      const x = obj.env.X;
      const y = process.argv;
      const z = process.platform;
    `);
    expect(configReadEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("ignores process.env.X.toString() (the .X is the chain root, not the leaf)", () => {
    const file = makeProject(`
      const x = process.env.NODE_ENV?.toString();
    `);
    // Should match process.env.NODE_ENV but not the .toString() chain.
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.interaction.name).toBe("NODE_ENV");
  });
});

describe("findProcessEnvReads helper", () => {
  it("walks property accesses and returns env reads with line numbers", () => {
    const file = makeProject(`
      const a = process.env.AWS_REGION;
      const b = process.env.PORT ?? "3000";
    `);
    const reads = findProcessEnvReads(file);
    expect(reads).toHaveLength(2);
    expect(reads.map((r) => r.name).sort()).toEqual(["AWS_REGION", "PORT"]);
    const port = reads.find((r) => r.name === "PORT") ?? raise("no PORT");
    expect(port.defaulted).toBe(true);
  });
});

describe("process-env pack metadata", () => {
  it("declares correct identity (no discovery, no terminals, accessRecognizer present)", () => {
    const pack = processEnvFramework();
    expect(pack.name).toBe("process-env");
    expect(pack.protocol).toBe("in-process");
    expect(pack.discovery).toEqual([]);
    expect(pack.terminals).toEqual([]);
    expect(pack.accessRecognizers).toHaveLength(1);
    expect(pack.invocationRecognizers).toBeUndefined();
  });
});
