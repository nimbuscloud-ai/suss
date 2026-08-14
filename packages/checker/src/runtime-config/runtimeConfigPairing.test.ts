import { describe, expect, it } from "vitest";

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import { checkRuntimeConfig } from "./runtimeConfigPairing.js";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";

function makeRuntimeProvider(opts: {
  instanceName: string;
  envVars: string[];
  codeScope: { kind: "codeUri" | "unknown"; path?: string };
  namesUnit?: boolean;
  envVarSources?: Record<string, "template" | "globals" | "platform">;
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "template.yaml",
      range: { start: 1, end: 10 },
      exportName: null,
    },
    identity: {
      name: opts.instanceName,
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: "cloudformation",
        deploymentTarget: "lambda",
        instanceName: opts.instanceName,
      }),
      ...(opts.namesUnit === true
        ? {
            deployableUnit: {
              deploymentTarget: "lambda" as const,
              instanceName: opts.instanceName,
            },
          }
        : {}),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      runtimeContract: {
        envVars: opts.envVars,
        ...(opts.envVarSources !== undefined
          ? { envVarSources: opts.envVarSources }
          : {}),
      },
      codeScope: opts.codeScope,
    },
  };
}

function makeCodeSummary(opts: {
  name: string;
  file: string;
  envReads: string[];
  runsInUnit?: string;
}): BehavioralSummary {
  const transition: Transition = {
    id: "t0",
    conditions: [],
    output: { type: "return", value: null },
    effects: opts.envReads.map((varName) => ({
      type: "interaction" as const,
      binding: {
        transport: "os",
        semantics: {
          name: "runtime-config" as const,
          deploymentTarget: "lambda" as const,
          instanceName: "<unknown>",
        },
        recognition: "@suss/runtime-node",
      },
      callee: `process.env.${varName}`,
      interaction: {
        class: "config-read" as const,
        name: varName,
        defaulted: false,
      },
    })),
    location: { start: 5, end: 10 },
    isDefault: true,
  };
  return {
    kind: "handler",
    location: {
      file: opts.file,
      range: { start: 1, end: 20 },
      exportName: null,
    },
    identity: {
      name: opts.name,
      exportPath: [opts.name],
      boundaryBinding: null,
      ...(opts.runsInUnit !== undefined
        ? {
            deployableUnit: {
              deploymentTarget: "lambda" as const,
              instanceName: opts.runsInUnit,
            },
          }
        : {}),
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
      envVars: ["STRIPE_KEY"], // typo: code reads STRIPE_API_KEY
      codeScope: { kind: "codeUri", path: "src/checkout/" },
    });
    const code = makeCodeSummary({
      name: "checkoutHandler",
      file: "src/checkout/index.ts",
      envReads: ["STRIPE_API_KEY"],
    });
    const findings = checkRuntimeConfig([runtime, code]);
    const unprovided = findings.filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );
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
    const unused = findings.filter((f) => f.kind === "boundaryFieldUnused");
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

  it("scopes the same way however the template spelled the trailing slash", () => {
    for (const path of ["src/ok", "src/ok/", "./src/ok/"]) {
      const runtime = makeRuntimeProvider({
        instanceName: "ok",
        envVars: ["A"],
        codeScope: { kind: "codeUri", path },
      });
      const code = makeCodeSummary({
        name: "okHandler",
        file: "src/ok/index.ts",
        envReads: ["A"],
      });
      expect(checkRuntimeConfig([runtime, code])).toEqual([]);
    }
  });

  it("keeps a scope of src/foo from reaching code in src/foobar", () => {
    const runtime = makeRuntimeProvider({
      instanceName: "foo",
      envVars: ["A"],
      codeScope: { kind: "codeUri", path: "src/foo" },
    });
    const code = makeCodeSummary({
      name: "neighbour",
      file: "src/foobar/index.ts",
      envReads: ["A"],
    });
    const findings = checkRuntimeConfig([runtime, code]);
    // The neighbour is out of scope, so its read cannot count for A, and
    // A comes out as declared but never used.
    expect(findings.map((f) => f.kind)).toEqual(["boundaryFieldUnused"]);
  });

  it("lets a scope of . cover the whole project", () => {
    const runtime = makeRuntimeProvider({
      instanceName: "wholeService",
      envVars: ["A"],
      codeScope: { kind: "codeUri", path: "." },
    });
    const code = makeCodeSummary({
      name: "handler",
      file: "src/handlers/index.ts",
      envReads: ["A"],
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

  it("says which runtime runs a shared util cannot be told, rather than blaming both", () => {
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
    expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
      [],
    );
    const unplaced = findings.filter((f) => f.kind === "runtimeScopeUnknown");
    expect(unplaced).toHaveLength(1);
    expect(unplaced[0].severity).toBe("info");
    expect(unplaced[0].description).toContain("src/shared.ts");
    expect(unplaced[0].description).toContain("2 runtimes");
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
      location: {
        file: "src/index.ts",
        range: { start: 1, end: 5 },
        exportName: null,
      },
      identity: { name: "h", exportPath: ["h"], boundaryBinding: null },
      inputs: [],
      transitions: [
        {
          id: "t0",
          conditions: [],
          output: { type: "return", value: null },
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
    const unprovided = findings.filter(
      (f) => f.kind === "boundaryFieldUnknown",
    );
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
      location: {
        file: "src/index.ts",
        range: { start: 1, end: 5 },
        exportName: null,
      },
      identity: { name: "h", exportPath: ["h"], boundaryBinding: null },
      inputs: [],
      transitions: [
        {
          id: "t0",
          conditions: [],
          output: { type: "return", value: null },
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
    expect(
      findings.filter((f) => f.kind === "boundaryFieldUnknown"),
    ).toHaveLength(1);
  });

  describe("two runtimes built from one source directory", () => {
    const sharedScope = { kind: "codeUri" as const, path: "" };

    function twoRuntimes(): BehavioralSummary[] {
      return [
        makeRuntimeProvider({
          instanceName: "IndexerFunction",
          envVars: ["INDEX_TABLE_NAME"],
          codeScope: sharedScope,
          namesUnit: true,
        }),
        makeRuntimeProvider({
          instanceName: "NotifierFunction",
          envVars: ["NOTIFY_TOPIC_ARN"],
          codeScope: sharedScope,
          namesUnit: true,
        }),
      ];
    }

    it("pairs each read against the runtime it names", () => {
      const findings = checkRuntimeConfig([
        ...twoRuntimes(),
        makeCodeSummary({
          name: "indexer",
          file: "src/handlers/indexer.ts",
          envReads: ["INDEX_TABLE_NAME"],
          runsInUnit: "IndexerFunction",
        }),
        makeCodeSummary({
          name: "notifier",
          file: "src/handlers/notifier.ts",
          envReads: ["NOTIFY_TOPIC_ARN"],
          runsInUnit: "NotifierFunction",
        }),
      ]);
      expect(findings).toEqual([]);
    });

    it("still reports a read no runtime declares", () => {
      const findings = checkRuntimeConfig([
        ...twoRuntimes(),
        makeCodeSummary({
          name: "notifier",
          file: "src/handlers/notifier.ts",
          envReads: ["NOTIFY_TOPIC_ARN", "RETRY_LIMIT"],
          runsInUnit: "NotifierFunction",
        }),
        makeCodeSummary({
          name: "indexer",
          file: "src/handlers/indexer.ts",
          envReads: ["INDEX_TABLE_NAME"],
          runsInUnit: "IndexerFunction",
        }),
      ]);
      const unknown = findings.filter((f) => f.kind === "boundaryFieldUnknown");
      expect(unknown).toHaveLength(1);
      expect(unknown[0].description).toContain("RETRY_LIMIT");
      expect(unknown[0].description).toContain("NotifierFunction");
    });

    it("gives a helper the unit of the handler in its module", () => {
      const findings = checkRuntimeConfig([
        ...twoRuntimes(),
        makeCodeSummary({
          name: "handler",
          file: "src/handlers/indexer.ts",
          envReads: [],
          runsInUnit: "IndexerFunction",
        }),
        makeCodeSummary({
          name: "indexTable",
          file: "src/handlers/indexer.ts",
          envReads: ["INDEX_TABLE_NAME"],
        }),
        makeCodeSummary({
          name: "notifier",
          file: "src/handlers/notifier.ts",
          envReads: ["NOTIFY_TOPIC_ARN"],
          runsInUnit: "NotifierFunction",
        }),
      ]);
      expect(findings).toEqual([]);
    });

    it("runs a helper in both units its module is deployed as", () => {
      // A module with two handlers is deployed twice, so the helper
      // beside them runs in each and is bound by both contracts.
      const findings = checkRuntimeConfig([
        ...twoRuntimes(),
        makeCodeSummary({
          name: "indexHandler",
          file: "src/handlers/both.ts",
          envReads: [],
          runsInUnit: "IndexerFunction",
        }),
        makeCodeSummary({
          name: "notifyHandler",
          file: "src/handlers/both.ts",
          envReads: [],
          runsInUnit: "NotifierFunction",
        }),
        makeCodeSummary({
          name: "shared",
          file: "src/handlers/both.ts",
          envReads: ["INDEX_TABLE_NAME", "NOTIFY_TOPIC_ARN"],
        }),
      ]);
      const unknown = findings.filter((f) => f.kind === "boundaryFieldUnknown");
      expect(unknown).toHaveLength(2);
    });

    it("pairs code no summary places against neither runtime", () => {
      const findings = checkRuntimeConfig([
        ...twoRuntimes(),
        makeCodeSummary({
          name: "sharedConfig",
          file: "src/lib/config.ts",
          envReads: ["INDEX_TABLE_NAME"],
        }),
      ]);
      expect(findings.filter((f) => f.kind === "boundaryFieldUnknown")).toEqual(
        [],
      );
      const unplaced = findings.filter((f) => f.kind === "runtimeScopeUnknown");
      expect(unplaced).toHaveLength(1);
      expect(unplaced[0].description).toContain("sharedConfig");
    });

    it("does not call a variable unread when the code reading it went unplaced", () => {
      const findings = checkRuntimeConfig([
        ...twoRuntimes(),
        makeCodeSummary({
          name: "sharedConfig",
          file: "src/lib/config.ts",
          envReads: ["INDEX_TABLE_NAME", "NOTIFY_TOPIC_ARN"],
        }),
      ]);
      expect(findings.filter((f) => f.kind === "boundaryFieldUnused")).toEqual(
        [],
      );
    });

    it("still reports a handler reading what its own function does not declare", () => {
      const findings = checkRuntimeConfig([
        ...twoRuntimes(),
        makeCodeSummary({
          name: "indexer",
          file: "src/handlers/indexer.ts",
          envReads: ["NOTIFY_TOPIC_ARN"],
          runsInUnit: "IndexerFunction",
        }),
        makeCodeSummary({
          name: "sharedConfig",
          file: "src/lib/config.ts",
          envReads: ["ANYTHING"],
        }),
      ]);
      const unknown = findings.filter((f) => f.kind === "boundaryFieldUnknown");
      expect(unknown).toHaveLength(1);
      expect(unknown[0].description).toContain("NOTIFY_TOPIC_ARN");
      expect(unknown[0].description).toContain("IndexerFunction");
    });

    it("lets one runtime's directory answer on its own", () => {
      const findings = checkRuntimeConfig([
        makeRuntimeProvider({
          instanceName: "IndexerFunction",
          envVars: [],
          codeScope: { kind: "codeUri", path: "" },
          namesUnit: true,
        }),
        makeCodeSummary({
          name: "sharedConfig",
          file: "src/lib/config.ts",
          envReads: ["INDEX_TABLE_NAME"],
        }),
      ]);
      const unknown = findings.filter((f) => f.kind === "boundaryFieldUnknown");
      expect(unknown).toHaveLength(1);
      expect(unknown[0].description).toContain("INDEX_TABLE_NAME");
    });
  });

  describe("a variable the document supplies to every runtime", () => {
    const documentRuntimes = () => [
      makeRuntimeProvider({
        instanceName: "IndexerFunction",
        envVars: ["LOG_LEVEL", "SENTRY_DSN"],
        envVarSources: { LOG_LEVEL: "globals", SENTRY_DSN: "globals" },
        codeScope: { kind: "codeUri", path: "src/" },
        namesUnit: true,
      }),
      makeRuntimeProvider({
        instanceName: "NotifierFunction",
        envVars: ["LOG_LEVEL", "SENTRY_DSN"],
        envVarSources: { LOG_LEVEL: "globals", SENTRY_DSN: "globals" },
        codeScope: { kind: "codeUri", path: "src/" },
        namesUnit: true,
      }),
    ];

    it("stays quiet for the runtimes that do not read it", () => {
      const findings = checkRuntimeConfig([
        ...documentRuntimes(),
        makeCodeSummary({
          name: "indexer",
          file: "src/handlers/indexer.ts",
          envReads: ["LOG_LEVEL"],
          runsInUnit: "IndexerFunction",
        }),
      ]);
      const unused = findings.filter(
        (f) =>
          f.kind === "boundaryFieldUnused" &&
          f.description.includes("LOG_LEVEL"),
      );
      expect(unused).toEqual([]);
    });

    it("reports it once when no runtime in the document reads it", () => {
      const findings = checkRuntimeConfig([
        ...documentRuntimes(),
        makeCodeSummary({
          name: "indexer",
          file: "src/handlers/indexer.ts",
          envReads: ["LOG_LEVEL"],
          runsInUnit: "IndexerFunction",
        }),
      ]);
      const unused = findings.filter(
        (f) =>
          f.kind === "boundaryFieldUnused" &&
          f.description.includes("SENTRY_DSN"),
      );
      expect(unused).toHaveLength(1);
      expect(unused[0].description).toContain("template.yaml");
    });

    it("says the run recorded no reads rather than judging each variable, when it recorded none", () => {
      const findings = checkRuntimeConfig(documentRuntimes());
      const unused = findings.filter((f) => f.kind === "boundaryFieldUnused");
      expect(unused).toHaveLength(1);
      expect(unused[0].severity).toBe("info");
      expect(unused[0].description).toContain("no environment read anywhere");
      expect(unused[0].description).toContain("-f node");
    });

    it("abstains about a resource's own variable too, when the run recorded no reads", () => {
      const findings = checkRuntimeConfig([
        makeRuntimeProvider({
          instanceName: "IndexerFunction",
          envVars: ["LOG_LEVEL", "INDEX_TABLE_NAME"],
          envVarSources: {
            LOG_LEVEL: "globals",
            INDEX_TABLE_NAME: "template",
          },
          codeScope: { kind: "codeUri", path: "src/" },
          namesUnit: true,
        }),
      ]);
      const unused = findings.filter((f) => f.kind === "boundaryFieldUnused");
      expect(unused).toHaveLength(1);
      // A run with no read anywhere cannot judge this variable either, so
      // the one finding is the abstention.
      expect(unused[0].description).toContain("no environment read anywhere");
    });

    it("reports a resource's own unread variable once some read exists in the run", () => {
      const findings = checkRuntimeConfig([
        makeRuntimeProvider({
          instanceName: "IndexerFunction",
          envVars: ["LOG_LEVEL", "INDEX_TABLE_NAME"],
          envVarSources: {
            LOG_LEVEL: "globals",
            INDEX_TABLE_NAME: "template",
          },
          codeScope: { kind: "codeUri", path: "src/" },
          namesUnit: true,
        }),
        makeCodeSummary({
          name: "indexer",
          file: "src/indexer.ts",
          envReads: ["LOG_LEVEL"],
          runsInUnit: "IndexerFunction",
        }),
      ]);
      const unused = findings.filter((f) => f.kind === "boundaryFieldUnused");
      expect(unused).toHaveLength(1);
      expect(unused[0].description).toContain("INDEX_TABLE_NAME");
    });
  });
});
