import { describe, expect, it } from "vitest";

import { discoverUnits, ResolutionStore } from "@suss/adapter-typescript";
import { effectsOverFile, packWithOnly } from "@suss/pack-harness";
import { runExamples } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import { cloudflareWorkersFramework } from "./index.js";

import type { Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

/** The effects the pack's access chains give for a line written in a trigger's body. */
function inTrigger(pack: PatternPack, code: string): Effect[] {
  const file = createTestProject().createSourceFile(
    "/worker.ts",
    [
      "interface Env { GREETING_TABLE?: string }",
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
  return effectsOverFile(
    file,
    packWithOnly(pack, { access: pack.accessRecognizers ?? [] }),
    store,
  );
}

describe("cloudflareWorkersFramework", () => {
  it("declares the env chain and the two trigger patterns", () => {
    const pack = cloudflareWorkersFramework();
    expect(pack.discoverUnits).toBeUndefined();
    expect(
      pack.declarations?.declarations.map((declared) => declared.name),
    ).toEqual(["runtimeRead", "namedExport", "registeredFunction"]);
  });

  it("matches the line the env chain says it matches, in a trigger's body", () => {
    const pack = cloudflareWorkersFramework({ scriptName: "edge" });
    const ran = runExamples(pack, (code) => inTrigger(pack, code));
    expect(ran.map((one) => one.effects)).toEqual([
      [
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
      ],
    ]);
  });
});
