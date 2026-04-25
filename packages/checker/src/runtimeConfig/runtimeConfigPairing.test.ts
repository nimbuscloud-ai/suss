import { describe, expect, it } from "vitest";

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import { checkRuntimeConfig } from "./runtimeConfigPairing.js";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";

function makeRuntimeProvider(opts: {
  instanceName: string;
  envVars: string[];
  codeScope: { kind: "codeUri" | "unknown"; path?: string };
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "template.yaml",
      range: { start: 1, end: 10 },
    },
    identity: {
      name: opts.instanceName,
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: "cloudformation",
        deploymentTarget: "lambda",
        instanceName: opts.instanceName,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      runtimeContract: { envVars: opts.envVars },
      codeScope: opts.codeScope,
    },
  };
}

function makeCodeSummary(opts: {
  name: string;
  file: string;
  envReads: string[];
}): BehavioralSummary {
  const transition: Transition = {
    id: "t0",
    conditions: [],
    output: { type: "return" },
    effects: opts.envReads.map((varName) => ({
      type: "invocation" as const,
      callee: "fetch",
      args: [
        // EffectArg.identifier shape produced by Gap 5b
        { kind: "identifier", name: `process.env.${varName}` },
      ],
      async: false,
    })),
    location: { start: 5, end: 10 },
    isDefault: true,
  };
  return {
    kind: "handler",
    location: {
      file: opts.file,
      range: { start: 1, end: 20 },
    },
    identity: {
      name: opts.name,
      exportPath: [opts.name],
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [transition],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("checkRuntimeConfig", () => {
  it("emits envVarUnprovided when code reads an env var the runtime doesn't supply", () => {
    const runtime = makeRuntimeProvider({
      instanceName: "checkout",
      envVars: ["STRIPE_KEY"], // typo — code reads STRIPE_API_KEY
      codeScope: { kind: "codeUri", path: "src/checkout/" },
    });
    const code = makeCodeSummary({
      name: "checkoutHandler",
      file: "src/checkout/index.ts",
      envReads: ["STRIPE_API_KEY"],
    });
    const findings = checkRuntimeConfig([runtime, code]);
    const unprovided = findings.filter((f) => f.kind === "envVarUnprovided");
    expect(unprovided).toHaveLength(1);
    expect(unprovided[0].severity).toBe("error");
    expect(unprovided[0].description).toContain("STRIPE_API_KEY");
    expect(unprovided[0].description).toContain("checkout");
  });

  it("emits envVarUnused when runtime supplies a var no code reads", () => {
    const runtime = makeRuntimeProvider({
      instanceName: "batch",
      envVars: ["DATABASE_URL", "LEGACY_FLAG"],
      codeScope: { kind: "codeUri", path: "src/batch/" },
    });
    const code = makeCodeSummary({
      name: "batchHandler",
      file: "src/batch/index.ts",
      envReads: ["DATABASE_URL"],
    });
    const findings = checkRuntimeConfig([runtime, code]);
    const unused = findings.filter((f) => f.kind === "envVarUnused");
    expect(unused).toHaveLength(1);
    expect(unused[0].severity).toBe("warning");
    expect(unused[0].description).toContain("LEGACY_FLAG");
  });

  it("emits no findings when reads and provided sets match exactly", () => {
    const runtime = makeRuntimeProvider({
      instanceName: "ok",
      envVars: ["A", "B"],
      codeScope: { kind: "codeUri", path: "src/ok/" },
    });
    const code = makeCodeSummary({
      name: "okHandler",
      file: "src/ok/index.ts",
      envReads: ["A", "B"],
    });
    expect(checkRuntimeConfig([runtime, code])).toEqual([]);
  });

  it("emits runtimeScopeUnknown when codeScope.kind is unknown", () => {
    const runtime = makeRuntimeProvider({
      instanceName: "noScope",
      envVars: ["X"],
      codeScope: { kind: "unknown" },
    });
    const code = makeCodeSummary({
      name: "h",
      file: "src/index.ts",
      envReads: ["X"],
    });
    const findings = checkRuntimeConfig([runtime, code]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("runtimeScopeUnknown");
    expect(findings[0].severity).toBe("info");
  });

  it("scopes reads by file-path prefix; out-of-scope reads do not pair", () => {
    const runtime = makeRuntimeProvider({
      instanceName: "alpha",
      envVars: [],
      codeScope: { kind: "codeUri", path: "src/alpha/" },
    });
    const code = makeCodeSummary({
      name: "betaHandler",
      file: "src/beta/index.ts", // out of alpha's scope
      envReads: ["ALPHA_KEY"],
    });
    const findings = checkRuntimeConfig([runtime, code]);
    expect(findings).toEqual([]);
  });

  it("multi-attributes a shared util read against every runtime that includes it", () => {
    const runtimeA = makeRuntimeProvider({
      instanceName: "alpha",
      envVars: [],
      codeScope: { kind: "codeUri", path: "src/" },
    });
    const runtimeB = makeRuntimeProvider({
      instanceName: "bravo",
      envVars: [],
      codeScope: { kind: "codeUri", path: "src/" },
    });
    const shared = makeCodeSummary({
      name: "sharedUtil",
      file: "src/shared.ts",
      envReads: ["SHARED_VAR"],
    });
    const findings = checkRuntimeConfig([runtimeA, runtimeB, shared]);
    const unprovided = findings.filter((f) => f.kind === "envVarUnprovided");
    expect(unprovided).toHaveLength(2); // one per runtime
  });

  it("recurses into call-shaped EffectArg for env reads inside nested calls", () => {
    const runtime = makeRuntimeProvider({
      instanceName: "wrapped",
      envVars: ["A"],
      codeScope: { kind: "codeUri", path: "src/" },
    });
    // log(formatError(process.env.NESTED_VAR))
    const summary: BehavioralSummary = {
      kind: "handler",
      location: { file: "src/index.ts", range: { start: 1, end: 5 } },
      identity: { name: "h", exportPath: ["h"], boundaryBinding: null },
      inputs: [],
      transitions: [
        {
          id: "t0",
          conditions: [],
          output: { type: "return" },
          effects: [
            {
              type: "invocation",
              callee: "log",
              args: [
                {
                  kind: "call",
                  callee: "formatError",
                  args: [
                    { kind: "identifier", name: "process.env.NESTED_VAR" },
                  ],
                },
              ],
              async: false,
            },
          ],
          location: { start: 2, end: 4 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };
    const findings = checkRuntimeConfig([runtime, summary]);
    const unprovided = findings.filter((f) => f.kind === "envVarUnprovided");
    expect(unprovided).toHaveLength(1);
    expect(unprovided[0].description).toContain("NESTED_VAR");
  });

  it("ignores identifier args that don't match the process.env pattern", () => {
    const runtime = makeRuntimeProvider({
      instanceName: "rt",
      envVars: [],
      codeScope: { kind: "codeUri", path: "src/" },
    });
    const summary: BehavioralSummary = {
      kind: "handler",
      location: { file: "src/index.ts", range: { start: 1, end: 5 } },
      identity: { name: "h", exportPath: ["h"], boundaryBinding: null },
      inputs: [],
      transitions: [
        {
          id: "t0",
          conditions: [],
          output: { type: "return" },
          effects: [
            {
              type: "invocation",
              callee: "f",
              args: [
                { kind: "identifier", name: "userId" },
                { kind: "identifier", name: "config.host" },
                { kind: "identifier", name: "process.env.OK" }, // matches
              ],
              async: false,
            },
          ],
          location: { start: 2, end: 4 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: { source: "inferred_static", level: "high" },
    };
    const findings = checkRuntimeConfig([runtime, summary]);
    expect(findings.filter((f) => f.kind === "envVarUnprovided")).toHaveLength(
      1,
    );
  });
});
