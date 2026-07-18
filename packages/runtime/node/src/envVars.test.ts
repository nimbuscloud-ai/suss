import {
  Node,
  Project,
  type PropertyAccessExpression,
  ScriptTarget,
  type SourceFile,
} from "ts-morph";
import { describe, expect, it } from "vitest";

import { envVarRecognizer, findProcessEnvReads } from "./envVars.js";
import nodeRuntimePack from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";

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

function recognizeWith(
  recognizer: AccessRecognizer,
  sourceFile: SourceFile,
): Effect[] {
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

function recognizeAll(sourceFile: SourceFile): Effect[] {
  return recognizeWith(envVarRecognizer(), sourceFile);
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

describe("env-var recognizer — happy path", () => {
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
    expect(read.binding.recognition).toBe("@suss/runtime-node");
  });

  it("threads deploymentTarget option into the binding", () => {
    const file = makeProject(`
      const x = process.env.FOO;
    `);
    const recognizer = envVarRecognizer({ deploymentTarget: "ecs-task" });
    const read =
      configReadEffectsOf(recognizeWith(recognizer, file))[0] ??
      raise("no read");
    expect(read.binding.semantics).toMatchObject({
      deploymentTarget: "ecs-task",
    });
  });
});

describe("env-var recognizer — rejection cases", () => {
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

describe("node runtime pack — env-var wiring", () => {
  it("includes an access recognizer that recognizes process.env.X", () => {
    const pack = nodeRuntimePack();
    const recognizers = pack.accessRecognizers ?? raise("no recognizers");
    const file = makeProject(`
      const x = process.env.FOO;
    `);
    const effects: Effect[] = [];
    for (const rec of recognizers) {
      effects.push(...recognizeWith(rec, file));
    }
    const reads = configReadEffectsOf(effects);
    // Exactly one recognizer (the env-var one) claims process.env.FOO;
    // the process-surface recognizer skips it, so no duplication.
    expect(reads).toHaveLength(1);
    expect(reads[0]?.interaction.name).toBe("FOO");
  });

  it("declares a version stamp so the merge invalidates warm caches", () => {
    expect(nodeRuntimePack().version).toBe("0.1.0");
  });
});
