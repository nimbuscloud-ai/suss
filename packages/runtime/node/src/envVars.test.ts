import { Node, type PropertyAccessExpression, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { envVarRecognizer, findProcessEnvReads } from "./envVars.js";
import nodeRuntimePack from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";

const raise = (msg: string): never => {
  throw new Error(msg);
};

function makeProject(userSource: string): SourceFile {
  const project = createTestProject();
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

  it("recognizes a bracket read, which the pack has always documented", () => {
    const file = makeProject(`
      const url = process.env["SERVICE_URL"];
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.interaction).toMatchObject({
      name: "SERVICE_URL",
      defaulted: false,
    });
  });

  it("marks a bracket read defaulted when it carries a ?? fallback", () => {
    const file = makeProject(`
      const url = process.env["SERVICE_URL"] ?? "http://localhost";
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads[0]?.interaction.defaulted).toBe(true);
  });

  it("names a bracket read the way it names a dotted one", () => {
    const file = makeProject(`
      const url = process.env["SERVICE_URL"];
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads[0]?.callee).toBe("process.env.SERVICE_URL");
  });

  it("reports nothing for an index it cannot read back as a name", () => {
    const file = makeProject(`
      declare const key: string;
      const value = process.env[key];
    `);
    expect(configReadEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("reports nothing for an index that names no variable", () => {
    const file = makeProject(`
      const value = process.env[""];
    `);
    expect(configReadEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("recognizes every variable destructured off process.env", () => {
    const file = makeProject(`
      const { AWS_REGION, SERVICE_URL: url } = process.env;
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads.map((r) => r.interaction.name).sort()).toEqual([
      "AWS_REGION",
      "SERVICE_URL",
    ]);
  });

  it("marks a destructured read defaulted when the binding supplies one", () => {
    const file = makeProject(`
      const { PORT = "3000", HOST } = process.env;
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    const byName = new Map(reads.map((r) => [r.interaction.name, r]));
    expect(byName.get("PORT")?.interaction.defaulted).toBe(true);
    expect(byName.get("HOST")?.interaction.defaulted).toBe(false);
  });

  it("names no variable for a rest element, which stands for the others", () => {
    const file = makeProject(`
      const { PORT, ...rest } = process.env;
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads.map((r) => r.interaction.name)).toEqual(["PORT"]);
  });

  it("names no variable for a computed binding it cannot read back", () => {
    const file = makeProject(`
      declare const key: string;
      const { [key]: value } = process.env;
    `);
    expect(configReadEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("names no variable for a binding whose property name is empty", () => {
    const file = makeProject(`
      const { "": value } = process.env;
    `);
    expect(configReadEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("reports nothing when process.env is bound whole rather than destructured", () => {
    const file = makeProject(`
      const settings = process.env;
    `);
    expect(configReadEffectsOf(recognizeAll(file))).toEqual([]);
  });

  it("reports a dotted read once, though the walk visits both its nodes", () => {
    const file = makeProject(`
      const key = process.env.STRIPE_API_KEY;
    `);
    expect(configReadEffectsOf(recognizeAll(file))).toHaveLength(1);
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

  it("skips accesses whose middle segment is not env", () => {
    const file = makeProject(`
      const a = process.argv.length;
      const b = config.env.MODE;
      const c = process.env.KEEP;
    `);
    const reads = findProcessEnvReads(file);
    expect(reads.map((r) => r.name)).toEqual(["KEEP"]);
  });

  it("does not mark defaulted for non-?? binary parents", () => {
    const file = makeProject(`
      const same = process.env.MODE === "production";
      const fallback = readFile() ?? process.env.BACKUP_PATH;
    `);
    const reads = findProcessEnvReads(file);
    expect(reads.find((r) => r.name === "MODE")?.defaulted).toBe(false);
    expect(reads.find((r) => r.name === "BACKUP_PATH")?.defaulted).toBe(false);
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

  it("follows a literal through a one-argument helper into a computed read", () => {
    const sourceFile = makeProject(`
      function requireEnv(name: string): string {
        const value = process.env[name];
        if (!value) throw new Error(name);
        return value;
      }
      export const table = requireEnv("TABLE_NAME");
      export const queue = requireEnv("QUEUE_URL");
    `);
    const reads = configReadEffectsOf(recognizeAll(sourceFile));
    expect(reads.map((read) => read.interaction.name).sort()).toEqual([
      "QUEUE_URL",
      "TABLE_NAME",
    ]);
  });

  it("anchors the read at the call that passed the literal", () => {
    const sourceFile = makeProject(`
      function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }
      export const table = requireEnv("TABLE_NAME");
    `);
    const reads = findProcessEnvReads(sourceFile);
    const callLine = sourceFile
      .getFullText()
      .split("\n")
      .findIndex((text) => text.includes('requireEnv("TABLE_NAME")'));
    expect(reads).toEqual([
      { name: "TABLE_NAME", defaulted: true, line: callLine + 1 },
    ]);
  });

  it("says nothing about a computed read of something other than the parameter", () => {
    const sourceFile = makeProject(`
      function requireEnv(name: string): string {
        const other = pick();
        return process.env[other] ?? "";
      }
      export const table = requireEnv("TABLE_NAME");
    `);
    expect(configReadEffectsOf(recognizeAll(sourceFile))).toEqual([]);
  });

  it("follows a helper written as an arrow on a const", () => {
    const sourceFile = makeProject(`
      const requireEnv = (name: string): string => process.env[name] ?? "";
      export const table = requireEnv("TABLE_NAME");
    `);
    const reads = configReadEffectsOf(recognizeAll(sourceFile));
    expect(reads.map((read) => read.interaction.name)).toEqual(["TABLE_NAME"]);
  });

  it("says nothing when the helper has no name to find callers by", () => {
    const sourceFile = makeProject(`
      export const table = ((name: string) => process.env[name] ?? "")("TABLE_NAME");
    `);
    expect(configReadEffectsOf(recognizeAll(sourceFile))).toEqual([]);
  });

  it("says nothing about a computed read of a non-name expression", () => {
    const sourceFile = makeProject(`
      export const value = process.env[compute()] ?? "";
    `);
    expect(configReadEffectsOf(recognizeAll(sourceFile))).toEqual([]);
  });

  it("says nothing about a computed read whose index no caller settles", () => {
    const sourceFile = makeProject(`
      function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }
      export const table = requireEnv(pickName());
    `);
    expect(configReadEffectsOf(recognizeAll(sourceFile))).toEqual([]);
  });
});
