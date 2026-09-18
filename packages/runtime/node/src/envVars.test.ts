import { Node, type SourceFile } from "ts-morph";
import { describe, expect, it, vi } from "vitest";

import { accessContextFor, ResolutionStore } from "@suss/adapter-typescript";
import { createTestProject } from "@suss/test-project";

import { envVarRecognizer, findProcessEnvReads } from "./envVars.js";
import nodeRuntimePack from "./index.js";

import type { Accessed } from "@suss/adapter-typescript";
import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";
import type { Project } from "ts-morph";

const raise = (msg: string): never => {
  throw new Error(msg);
};

function makeProject(userSource: string): SourceFile {
  const project = createTestProject();
  return project.createSourceFile("user.ts", userSource);
}

/**
 * The store the adapter hands a recognizer, over the whole project: a
 * question about a parameter is answered from the files that call it,
 * which no query starting at the parameter reaches on its own.
 */
function storeOver(project: Project): ResolutionStore {
  const store = new ResolutionStore(
    [],
    nodeRuntimePack().environmentObjects ?? [],
  );
  const files = project
    .getSourceFiles()
    .filter((one) => !one.isInNodeModules());
  store.extractFiles(files);
  store.notePossibleCallers(files);
  return store;
}

function recognizeWith(
  recognizer: AccessRecognizer,
  sourceFile: SourceFile,
  resolution?: ResolutionStore,
): Effect[] {
  const effects: Effect[] = [];
  // The same node filter and dedupe the adapter's dispatch applies: a
  // helper call and the bracket read behind it give one effect, once.
  const seen = new Set<string>();
  sourceFile.forEachDescendant((node) => {
    if (
      !Node.isPropertyAccessExpression(node) &&
      !Node.isCallExpression(node)
    ) {
      return;
    }
    const ctx = accessContextFor(node as Accessed, sourceFile, resolution);
    const emitted = recognizer(node, ctx);
    for (const effect of emitted ?? []) {
      const key = JSON.stringify(effect);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      effects.push(effect);
    }
  });
  return effects;
}

function recognizeAll(sourceFile: SourceFile): Effect[] {
  return recognizeWith(envVarRecognizer(), sourceFile);
}

/** Every read the recognizer finds with the store the adapter would give it. */
function recognizeWithStore(sourceFile: SourceFile): Effect[] {
  return recognizeWith(
    envVarRecognizer(),
    sourceFile,
    storeOver(sourceFile.getProject()),
  );
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

  it("marks defaulted=true when used with || fallback", () => {
    const file = makeProject(`
      const port = process.env.PORT || "3000";
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads[0]?.interaction.defaulted).toBe(true);
  });

  it("marks every read before the tail of a || chain defaulted", () => {
    const file = makeProject(`
      const endpoint =
        process.env.SERVICE_ENDPOINT || process.env.GLOBAL_ENDPOINT || undefined;
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(
      reads.map((r) => [r.interaction.name, r.interaction.defaulted]),
    ).toEqual([
      ["SERVICE_ENDPOINT", true],
      ["GLOBAL_ENDPOINT", true],
    ]);
  });

  it("does NOT mark defaulted under an operator that supplies nothing", () => {
    const file = makeProject(`
      declare function warm(): void;
      const gated = process.env.FEATURE_ON && warm();
      const label = process.env.STAGE + "-suffix";
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads.map((r) => r.interaction.defaulted)).toEqual([false, false]);
  });

  it("looks a helper's callers up once and reuses the answer", () => {
    const file = makeProject(`
      function requireEnv(name: string): string | undefined {
        return process.env[name];
      }
      const table = requireEnv("TABLE_NAME");
    `);
    const first = configReadEffectsOf(recognizeAll(file));
    const second = configReadEffectsOf(recognizeAll(file));
    expect(second.map((r) => r.interaction.name)).toEqual(
      first.map((r) => r.interaction.name),
    );
  });

  it("sees through parentheses around the read", () => {
    const file = makeProject(`
      const port = (process.env.PORT) || "3000";
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
    expect(reads[0]?.interaction.defaulted).toBe(true);
  });

  it("does NOT mark defaulted when env-var ends a || chain", () => {
    const file = makeProject(`
      function fromFlag(): string | undefined { return undefined; }
      const port = fromFlag() || process.env.PORT;
    `);
    const reads = configReadEffectsOf(recognizeAll(file));
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
    expect(configReadEffectsOf(recognizeWithStore(file))).toEqual([]);
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
    expect(configReadEffectsOf(recognizeWithStore(sourceFile))).toEqual([]);
  });

  it("follows a helper written as an arrow on a const", () => {
    const sourceFile = makeProject(`
      const requireEnv = (name: string): string => process.env[name] ?? "";
      export const table = requireEnv("TABLE_NAME");
    `);
    const reads = configReadEffectsOf(recognizeAll(sourceFile));
    expect(reads.map((read) => read.interaction.name)).toEqual(["TABLE_NAME"]);
  });

  it("says nothing about a helper called where it is written", () => {
    const sourceFile = makeProject(`
      export const table = ((name: string) => process.env[name] ?? "")("TABLE_NAME");
    `);
    expect(configReadEffectsOf(recognizeWithStore(sourceFile))).toEqual([]);
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
    expect(configReadEffectsOf(recognizeWithStore(sourceFile))).toEqual([]);
  });

  it("never asks what an argument is worth when the callee reads no env var", () => {
    const sourceFile = makeProject(`
      function log(message: string): void { return; }
      function label(): string { return "started"; }
      log(label());
    `);
    const store = storeOver(sourceFile.getProject());
    const asked = vi.spyOn(store, "resolveCallable");
    const reads = configReadEffectsOf(
      recognizeWith(envVarRecognizer(), sourceFile, store),
    );
    expect(reads).toEqual([]);
    expect(asked).not.toHaveBeenCalled();
  });

  it("follows a literal across two helpers, each handing its parameter on", () => {
    const sourceFile = makeProject(`
      function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }
      function getEnv(key: string): string {
        return requireEnv(key);
      }
      export const table = getEnv("TABLE_NAME");
    `);
    const reads = configReadEffectsOf(recognizeWithStore(sourceFile));
    expect(reads.map((read) => read.interaction.name)).toEqual(["TABLE_NAME"]);
  });

  it("stops rather than going round two helpers that call each other", () => {
    const sourceFile = makeProject(`
      function one(name: string): string {
        return two(name);
      }
      function two(name: string): string {
        return process.env[name] ?? one(name);
      }
    `);
    expect(configReadEffectsOf(recognizeAll(sourceFile))).toEqual([]);
  });

  it("stops going round two forwarding helpers even once a literal reaches them", () => {
    const sourceFile = makeProject(`
      function one(name: string): string {
        return two(name);
      }
      function two(name: string): string {
        return one(name);
      }
      export const table = one("TABLE_NAME");
    `);
    expect(configReadEffectsOf(recognizeWithStore(sourceFile))).toEqual([]);
  });

  it("follows a literal into a method helper", () => {
    const sourceFile = makeProject(`
      class Config {
        get(key: string): string {
          return process.env[key] ?? "";
        }
      }
      const config = new Config();
      export const table = config.get("TABLE_NAME");
    `);
    const reads = configReadEffectsOf(recognizeAll(sourceFile));
    expect(reads.map((read) => read.interaction.name)).toEqual(["TABLE_NAME"]);
  });

  it("reads a name a caller keeps in a const", () => {
    const sourceFile = makeProject(`
      function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }
      const TABLE_KEY = "TABLE_NAME";
      export const table = requireEnv(TABLE_KEY);
    `);
    const reads = configReadEffectsOf(recognizeAll(sourceFile));
    expect(reads.map((read) => read.interaction.name)).toEqual(["TABLE_NAME"]);
  });

  it("reads a name kept in a let, taking the last value written to it", () => {
    const sourceFile = makeProject(`
      function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }
      let key = "TABLE_NAME";
      key = "OTHER_TABLE";
      export const table = requireEnv(key);
    `);
    const reads = configReadEffectsOf(recognizeAll(sourceFile));
    expect(reads.map((read) => read.interaction.name)).toEqual(["OTHER_TABLE"]);
  });

  it("reads a name a caller builds from a prefix and a constant", () => {
    const sourceFile = makeProject(`
      function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }
      const suffix = "TABLE";
      export const table = requireEnv("APP_" + suffix);
    `);
    const reads = configReadEffectsOf(recognizeAll(sourceFile));
    expect(reads.map((read) => read.interaction.name)).toEqual(["APP_TABLE"]);
  });

  it("says nothing about a caller that passes the helper no name at all", () => {
    const sourceFile = makeProject(`
      function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }
      export function boot() {
        return requireEnv();
      }
    `);
    expect(configReadEffectsOf(recognizeAll(sourceFile))).toEqual([]);
  });

  it("says nothing for a name only the run would know, passed at module scope", () => {
    const sourceFile = makeProject(`
      function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }
      declare const key: string;
      export const table = requireEnv(key);
    `);
    expect(configReadEffectsOf(recognizeAll(sourceFile))).toEqual([]);
  });
});

describe("a helper's body resolved from the callers' side", () => {
  it("follows a literal from a caller in another file", () => {
    const project = createTestProject();
    const helper = project.createSourceFile(
      "env.ts",
      `export function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }`,
    );
    project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv("TABLE_NAME");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(helper));
    expect(reads.map((read) => read.interaction.name)).toEqual(["TABLE_NAME"]);
  });

  it("reads a name the caller built from a prefix and a constant", () => {
    const project = createTestProject();
    const helper = project.createSourceFile(
      "env.ts",
      `export function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }`,
    );
    project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      const suffix = "TABLE";
      export const table = requireEnv("APP_" + suffix);`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(helper));
    expect(reads.map((read) => read.interaction.name)).toEqual(["APP_TABLE"]);
  });

  it("follows both literals back through a helper that hands its parameter on", () => {
    const project = createTestProject();
    const helper = project.createSourceFile(
      "env.ts",
      `function inner(name: string): string {
        return process.env[name] ?? "";
      }
      export function getEnv(key: string): string {
        return inner(key);
      }`,
    );
    project.createSourceFile(
      "a.ts",
      `import { getEnv } from "./env.js";
      export const table = getEnv("TABLE_NAME");`,
    );
    project.createSourceFile(
      "b.ts",
      `import { getEnv } from "./env.js";
      export const queue = getEnv("QUEUE_URL");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(helper));
    expect(reads.map((read) => read.interaction.name).sort()).toEqual([
      "QUEUE_URL",
      "TABLE_NAME",
    ]);
  });

  it("stops rather than going round two helpers that call each other", () => {
    const project = createTestProject();
    const helper = project.createSourceFile(
      "env.ts",
      `function first(name: string): string {
        return process.env[name] ?? second(name);
      }
      function second(name: string): string {
        return first(name);
      }
      export function getEnv(key: string): string {
        return first(key);
      }`,
    );
    project.createSourceFile(
      "a.ts",
      `import { getEnv } from "./env.js";
      export const table = getEnv("TABLE_NAME");`,
    );
    project.createSourceFile(
      "b.ts",
      `import { getEnv } from "./env.js";
      export const queue = getEnv("QUEUE_URL");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(helper));
    expect(reads.map((read) => read.interaction.name).sort()).toEqual([
      "QUEUE_URL",
      "TABLE_NAME",
    ]);
  });

  it("says nothing for a name only the run would know", () => {
    const project = createTestProject();
    const helper = project.createSourceFile(
      "env.ts",
      `export function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }`,
    );
    project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      declare const key: string;
      export const table = requireEnv(key);`,
    );
    expect(configReadEffectsOf(recognizeWithStore(helper))).toEqual([]);
  });

  it("says nothing for a name a caller works out at run time", () => {
    const project = createTestProject();
    const helper = project.createSourceFile(
      "env.ts",
      `export function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }`,
    );
    project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      declare function pickName(): string;
      export function boot(): string {
        const key = pickName();
        return requireEnv(key);
      }`,
    );
    expect(configReadEffectsOf(recognizeWithStore(helper))).toEqual([]);
  });

  it("says nothing when the recognizer runs without a store", () => {
    const project = createTestProject();
    const helper = project.createSourceFile(
      "env.ts",
      `export function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }`,
    );
    project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv("TABLE_NAME");`,
    );
    expect(configReadEffectsOf(recognizeAll(helper))).toEqual([]);
  });
});

describe("a helper call resolved from the caller's side", () => {
  it("reads the variable from a file that only calls the helper", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function requireEnv(name: string): string {
        return process.env[name] ?? "";
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv("TABLE_NAME");`,
    );
    const reads = configReadEffectsOf(recognizeAll(handler));
    expect(reads.map((read) => read.interaction.name)).toEqual(["TABLE_NAME"]);
  });

  it("follows the literal through a helper that hands its parameter on", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `function inner(key: string): string {
        return process.env[key] ?? "";
      }
      export function getEnv(name: string): string {
        return inner(name);
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { getEnv } from "./env.js";
      export const queue = getEnv("QUEUE_URL");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(reads.map((read) => read.interaction.name)).toEqual(["QUEUE_URL"]);
  });

  it("follows the literal through a helper in a second file into a third", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function requireEnv(key: string): string {
        return process.env[key] ?? "";
      }`,
    );
    project.createSourceFile(
      "settings.ts",
      `import { requireEnv } from "./env.js";
      export function setting(name: string): string {
        return requireEnv(name);
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { setting } from "./settings.js";
      export const url = setting("DATABASE_URL");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(reads.map((read) => read.interaction.name)).toEqual([
      "DATABASE_URL",
    ]);
  });

  it("reads a name kept in a constant another module exports", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function requireEnv(key: string): string {
        return process.env[key] ?? "";
      }`,
    );
    project.createSourceFile("names.ts", `export const TABLE = "TABLE_NAME";`);
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      import { TABLE } from "./names.js";
      export const table = requireEnv(TABLE);`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(reads.map((read) => read.interaction.name)).toEqual(["TABLE_NAME"]);
  });

  it("reads a helper a file keeps to itself and exports nothing of", () => {
    const project = createTestProject();
    // A test file states no facts, since extraction reaches what a file
    // exports, so the rules have nothing to say about `envInt`.
    const knobs = project.createSourceFile(
      "knobs.test.ts",
      `const envInt = (name: string, fallback: number): number => {
        const raw = process.env[name];
        return raw === undefined ? fallback : Number.parseInt(raw, 10);
      };
      const runs = envInt("FUZZ_RUNS", 60);`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(knobs));
    expect(reads.map((read) => read.interaction.name)).toEqual(["FUZZ_RUNS"]);
  });

  it("follows the chain from a store that has read none of it yet", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function requireEnv(key: string): string {
        return process.env[key] ?? "";
      }`,
    );
    project.createSourceFile(
      "settings.ts",
      `import { requireEnv } from "./env.js";
      export function setting(name: string): string {
        return requireEnv(name);
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { setting } from "./settings.js";
      export const url = setting("DATABASE_URL");`,
    );
    // The reader meets `setting("DATABASE_URL")` before anything has
    // read `settings.ts` or `env.ts`, and gets the same answer.
    const store = new ResolutionStore(
      [],
      nodeRuntimePack().environmentObjects ?? [],
    );
    const reads = configReadEffectsOf(
      recognizeWith(envVarRecognizer(), handler, store),
    );
    expect(reads.map((read) => read.interaction.name)).toEqual([
      "DATABASE_URL",
    ]);
  });

  it("calls a name defaulted only where every read of it supplies one", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function requireEnv(key: string): string {
        if (process.env[key]) {
          return process.env[key] ?? "";
        }
        return "";
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv("TABLE_NAME");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(
      reads.map((read) => [read.interaction.name, read.interaction.defaulted]),
    ).toEqual([["TABLE_NAME", false]]);
  });

  it("calls a name defaulted when the call itself carries the fallback", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function requireEnv(key: string): string | undefined {
        return process.env[key];
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv("TABLE_NAME") ?? "local";`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(
      reads.map((read) => [read.interaction.name, read.interaction.defaulted]),
    ).toEqual([["TABLE_NAME", true]]);
  });

  /** A project whose env helper is what a factory call gave back. */
  function projectWithFactory(): Project {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function makeReader(prefix: string) {
        return (name: string) => process.env[name] ?? prefix;
      }
      export const requireEnv = makeReader("");`,
    );
    return project;
  }

  it("reads a name passed to a helper a factory returned", () => {
    const project = projectWithFactory();
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv("TABLE_NAME");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(reads.map((read) => read.interaction.name)).toEqual(["TABLE_NAME"]);
  });

  it("reads a name forwarded through a helper to one a factory returned", () => {
    const project = projectWithFactory();
    project.createSourceFile(
      "settings.ts",
      `import { requireEnv } from "./env.js";
      export function setting(name: string): string {
        return requireEnv(name);
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { setting } from "./settings.js";
      export const url = setting("DATABASE_URL");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(reads.map((read) => read.interaction.name)).toEqual([
      "DATABASE_URL",
    ]);
  });

  it("says nothing for a helper a bound call gave back", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function readEnv(prefix: string, name: string): string {
        return process.env[name] ?? prefix;
      }
      export const requireEnv = readEnv.bind(null, "");`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv("TABLE_NAME");`,
    );
    // `.bind` is a hop to `readEnv` itself rather than to what calling
    // it gives back, and it moves every argument one place left, which
    // this reader has no way to undo. See the README.
    expect(configReadEffectsOf(recognizeWithStore(handler))).toEqual([]);
  });

  it("says nothing when the function a factory returned never reads the environment", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function requireEnv(key: string): string {
        return process.env[key] ?? "";
      }
      export function makeLogger(tag: string) {
        return (message: string) => tag + message;
      }
      export const log = makeLogger("app");`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { log } from "./env.js";
      export const said = log("TABLE_NAME");`,
    );
    expect(configReadEffectsOf(recognizeWithStore(handler))).toEqual([]);
  });

  it("says nothing for a name a helper takes off an options object", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function requireEnv(options: { key: string }): string {
        return process.env[options.key] ?? "";
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv({ key: "TABLE_NAME" });`,
    );
    expect(configReadEffectsOf(recognizeWithStore(handler))).toEqual([]);
  });

  it("skips an unrelated call in the helper's body on the way to the forwarding one", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `function inner(key: string): string {
        return process.env[key] ?? "";
      }
      export function getEnv(name: string): string {
        console.log("reading", "config");
        return inner(name);
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { getEnv } from "./env.js";
      export const queue = getEnv("QUEUE_URL");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(reads.map((read) => read.interaction.name)).toEqual(["QUEUE_URL"]);
  });

  it("says nothing when a forwarding call's callee is a wrapper factory's result", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `export function read(key: string): string {
        return process.env[key] ?? "";
      }`,
    );
    project.createSourceFile(
      "wrapFactory.ts",
      `import { read } from "./env.js";
      export function withLogging(fn: (key: string) => string) {
        return (key: string) => fn(key);
      }
      export const loggedRead = withLogging(read);`,
    );
    project.createSourceFile(
      "helpers.ts",
      `import { loggedRead } from "./wrapFactory.js";
      export function getEnv(name: string): string {
        return loggedRead(name);
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { getEnv } from "./helpers.js";
      export const table = getEnv("TABLE_NAME");`,
    );
    // The returned function calls `fn`, which is a parameter, so which
    // function the name ends up at depends on who called `withLogging`.
    expect(configReadEffectsOf(recognizeWithStore(handler))).toEqual([]);
  });

  it("skips an unrelated element access on the way to a direct read", () => {
    const sourceFile = makeProject(`
      const flags = ["a", "b"];
      function requireEnv(name: string): string {
        const first = flags[0];
        return first + (process.env[name] ?? "");
      }
      export const table = requireEnv("TABLE_NAME");
    `);
    const reads = configReadEffectsOf(recognizeWithStore(sourceFile));
    expect(reads.map((read) => read.interaction.name)).toEqual(["TABLE_NAME"]);
  });

  it("does not credit the parameter with a read done by a local that shadows its name", () => {
    const sourceFile = makeProject(`
      function wrap(name: string): string {
        const compute = (): string => {
          const name = "SHADOWED";
          return process.env[name] ?? "";
        };
        return compute();
      }
      export const table = wrap("TABLE_NAME");
    `);
    expect(configReadEffectsOf(recognizeWithStore(sourceFile))).toEqual([]);
  });

  it("stops when a forwarded call lands on a position the callee has no parameter for", () => {
    const sourceFile = makeProject(`
      function read(key: string): string {
        return process.env[key] ?? "";
      }
      function wrap(name: string): string {
        return read(0, name);
      }
      export const table = wrap("TABLE_NAME");
    `);
    expect(configReadEffectsOf(recognizeWithStore(sourceFile))).toEqual([]);
  });

  it("does not follow a parameter handed to a constructor rather than a call", () => {
    const sourceFile = makeProject(`
      class Marker {
        constructor(key: string) {}
      }
      function wrap(name: string): unknown {
        return new Marker(name);
      }
      export const table = wrap("TABLE_NAME");
    `);
    expect(configReadEffectsOf(recognizeWithStore(sourceFile))).toEqual([]);
  });

  it("stops at a callee nothing calling wrap ever supplies", () => {
    const sourceFile = makeProject(`
      function wrap(name: string, fn: (key: string) => string): string {
        return fn(name);
      }
      export const table = wrap("TABLE_NAME");
    `);
    expect(configReadEffectsOf(recognizeWithStore(sourceFile))).toEqual([]);
  });

  it("says nothing about a call whose callee nothing in the run defines", () => {
    const sourceFile = makeProject(`
      declare function requireEnv(name: string): string;
      export const table = requireEnv("TABLE_NAME");
    `);
    expect(configReadEffectsOf(recognizeAll(sourceFile))).toEqual([]);
  });

  it("stops rather than going round two helpers that call each other", () => {
    const sourceFile = makeProject(`
      function first(name: string): string {
        return second(name);
      }
      function second(name: string): string {
        return first(name);
      }
      export const table = first("TABLE_NAME");
    `);
    expect(configReadEffectsOf(recognizeAll(sourceFile))).toEqual([]);
  });

  it("reads a name through a helper closed over an environment it was handed", () => {
    const project = createTestProject();
    project.createSourceFile(
      "reader.ts",
      `export function makeReader(env: NodeJS.ProcessEnv) {
        return (name: string) => env[name];
      }`,
    );
    project.createSourceFile(
      "env.ts",
      `import { makeReader } from "./reader.js";
      export const requireEnv = makeReader(process.env);`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv("TABLE_NAME");`,
    );
    // The helper's own file never writes `process.env`, so it arrives
    // through the demand of the call that hands it the object.
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(
      reads.map((read) => [read.interaction.name, read.interaction.defaulted]),
    ).toEqual([["TABLE_NAME", false]]);
  });

  it("reads a name off a name declared as the environment object", () => {
    const project = createTestProject();
    project.createSourceFile(
      "env.ts",
      `const env = process.env;
      export function requireEnv(name: string): string {
        return env[name] ?? "";
      }`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv("TABLE_NAME");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(
      reads.map((read) => [read.interaction.name, read.interaction.defaulted]),
    ).toEqual([["TABLE_NAME", true]]);
  });

  it("follows the environment object through two calls", () => {
    const project = createTestProject();
    project.createSourceFile(
      "reader.ts",
      `export function makeReader(env: NodeJS.ProcessEnv) {
        return (name: string) => env[name];
      }
      export function build(source: NodeJS.ProcessEnv) {
        return makeReader(source);
      }`,
    );
    project.createSourceFile(
      "env.ts",
      `import { build } from "./reader.js";
      export const requireEnv = build(process.env);`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const url = requireEnv("DATABASE_URL");`,
    );
    const reads = configReadEffectsOf(recognizeWithStore(handler));
    expect(reads.map((read) => read.interaction.name)).toEqual([
      "DATABASE_URL",
    ]);
  });

  it("says nothing when the factory is handed a plain object instead", () => {
    const project = createTestProject();
    project.createSourceFile(
      "reader.ts",
      `export function makeReader(source: Record<string, string>) {
        return (name: string) => source[name];
      }`,
    );
    project.createSourceFile(
      "env.ts",
      `import { makeReader } from "./reader.js";
      const settings = { TABLE_NAME: "orders" };
      export const requireEnv = makeReader(settings);`,
    );
    const handler = project.createSourceFile(
      "handler.ts",
      `import { requireEnv } from "./env.js";
      export const table = requireEnv("TABLE_NAME");`,
    );
    expect(configReadEffectsOf(recognizeWithStore(handler))).toEqual([]);
  });
});
