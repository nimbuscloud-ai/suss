import { describe, expect, it } from "vitest";

import { discoverUnits, ResolutionStore } from "@suss/adapter-typescript";
import { effectsOverFile } from "@suss/pack-harness";
import { runExamples } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import { cloudflareWorkersFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

/** The bindings every example reads, typed the way a Worker's `Env` is. */
const ENV = [
  "interface Env {",
  "  GREETING_TABLE?: string;",
  "  SESSIONS: KVNamespace;",
  "  ARCHIVE: R2Bucket;",
  "  LEDGER: D1Database;",
  "}",
].join("\n");

/** The effects the pack's chains give for a line written in a trigger's body. */
function inTrigger(pack: PatternPack, code: string): Effect[] {
  const file = createTestProject().createSourceFile(
    "/worker.ts",
    [
      ENV,
      "export default {",
      `  async fetch(request: Request, env: Env) { return ${code}; },`,
      "};",
    ].join("\n"),
  );
  const store = ResolutionStore.forPacks([pack]);
  for (const unit of discoverUnits(file, pack.discovery, store)) {
    if (unit.func !== null && unit.handedIn !== undefined) {
      store.stateHandedIn(unit.func, unit.handedIn);
    }
  }
  return effectsOverFile(file, pack, store);
}

/** The class of each effect, and the store a storage access reaches. */
function summarized(effects: readonly Effect[]): string[] {
  return effects.flatMap((effect) => {
    if (effect.type !== "interaction") {
      return [];
    }
    const { semantics } = effect.binding;
    return semantics.name === "storage"
      ? [`storage ${semantics.storageSystem} ${semantics.container}`]
      : [effect.interaction.class];
  });
}

describe("cloudflareWorkersFramework", () => {
  it("declares the env chain, the three store chains and the two trigger patterns", () => {
    const pack = cloudflareWorkersFramework();
    expect(pack.discoverUnits).toBeUndefined();
    expect(
      pack.declarations?.declarations.map((declared) => declared.name),
    ).toEqual([
      "runtimeRead",
      "cloudflare-kv",
      "r2",
      "d1",
      "namedExport",
      "registeredFunction",
    ]);
  });

  it("matches the line the env chain says it matches, in a trigger's body", () => {
    const pack = cloudflareWorkersFramework({ scriptName: "edge" });
    const [env] = runExamples(pack, (code) => inTrigger(pack, code));
    expect(env?.effects).toEqual([
      expect.objectContaining({
        callee: "env.GREETING_TABLE",
        binding: expect.objectContaining({
          semantics: {
            name: "runtime-config",
            deploymentTarget: "worker",
            instanceName: "edge",
          },
        }),
        interaction: {
          class: "config-read",
          name: "GREETING_TABLE",
          defaulted: true,
          default: "greetings",
        },
      }),
    ]);
  });

  it("matches the line each store chain says it matches, beside the read of the binding", () => {
    const pack = cloudflareWorkersFramework();
    const [, ...stores] = runExamples(pack, (code) => inTrigger(pack, code));
    expect(stores.map((one) => summarized(one.effects))).toEqual([
      ["storage cloudflare-kv SESSIONS", "config-read"],
      ["storage r2 ARCHIVE", "config-read"],
      ["storage d1 LEDGER", "config-read"],
    ]);
  });
});
