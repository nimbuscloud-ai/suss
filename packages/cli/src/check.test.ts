import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { functionCallBinding, restBinding } from "@suss/behavioral-ir";

import { check, checkDir } from "./check.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function transition(
  id: string,
  opts: {
    statusCode?: number;
    conditionStatus?: number;
    isDefault?: boolean;
  } = {},
): BehavioralSummary["transitions"][number] {
  const conditions =
    opts.conditionStatus !== undefined
      ? [
          {
            type: "comparison" as const,
            left: {
              type: "derived" as const,
              from: {
                type: "dependency" as const,
                name: "fetch",
                accessChain: [],
              },
              derivation: {
                type: "propertyAccess" as const,
                property: "status",
              },
            },
            op: "eq" as const,
            right: {
              type: "literal" as const,
              value: opts.conditionStatus,
            },
          },
        ]
      : [];
  return {
    id,
    conditions,
    output:
      opts.statusCode !== undefined
        ? {
            type: "response",
            statusCode: { type: "literal", value: opts.statusCode },
            body: null,
            headers: {},
          }
        : { type: "return", value: null },
    effects: [],
    location: { start: 1, end: 10 },
    isDefault: opts.isDefault ?? false,
  };
}

function provider(
  name: string,
  transitions: BehavioralSummary["transitions"],
): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: `src/handlers/${name}.ts`,
      range: { start: 1, end: 50 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "ts-rest",
        method: "GET",
        path: `/${name}`,
      }),
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function consumer(
  name: string,
  transitions: BehavioralSummary["transitions"],
): BehavioralSummary {
  return {
    kind: "client",
    location: {
      file: `src/ui/${name}.ts`,
      range: { start: 1, end: 30 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: functionCallBinding({
        transport: "http",
        recognition: "fetch",
      }),
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("check CLI command", () => {
  let tmpDir: string;
  let providerPath: string;
  let consumerPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-check-"));
    providerPath = path.join(tmpDir, "provider.json");
    consumerPath = path.join(tmpDir, "consumer.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureStdout(fn: () => void): string {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      fn();
    } finally {
      process.stdout.write = orig;
    }
    return chunks.join("");
  }

  it("emits zero findings when provider and consumer agree", () => {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
          transition("t-404", { statusCode: 404 }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-404", { conditionStatus: 404 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    const output = captureStdout(() => {
      const result = check({
        providerFile: providerPath,
        consumerFile: consumerPath,
      });
      expect(result.findings).toEqual([]);
      expect(result.hasErrors).toBe(false);
    });
    expect(output).toContain("No findings");
  });

  it("reports deadConsumerBranch when consumer expects a status the provider cannot produce", () => {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-410", { conditionStatus: 410 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    const result = check({
      providerFile: providerPath,
      consumerFile: consumerPath,
      output: path.join(tmpDir, "findings.txt"),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("deadConsumerBranch");
    expect(result.findings[0].severity).toBe("warning");
    expect(result.hasErrors).toBe(false);
  });

  it("hasErrors is true when any finding has error severity", () => {
    const providerSummary = provider("getUser", [
      transition("t-200", { statusCode: 200, isDefault: true }),
    ]);
    providerSummary.metadata = {
      http: {
        declaredContract: {
          framework: "ts-rest",
          responses: [{ statusCode: 200 }],
        },
      },
    };
    fs.writeFileSync(providerPath, JSON.stringify([providerSummary]));
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-418", { conditionStatus: 418 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    captureStdout(() => {
      const result = check({
        providerFile: providerPath,
        consumerFile: consumerPath,
      });
      expect(result.hasErrors).toBe(true);
      const kinds = result.findings.map((f) => f.kind);
      expect(kinds).toContain("consumerContractViolation");
    });
  });

  it("--json writes structured JSON to stdout", () => {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-410", { conditionStatus: 410 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    const output = captureStdout(() => {
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        json: true,
      });
    });
    const parsed = JSON.parse(output) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect((parsed as Array<{ kind: string }>)[0].kind).toBe(
      "deadConsumerBranch",
    );
  });

  it("-o output writes findings to the given file and skips stdout", () => {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-410", { conditionStatus: 410 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );
    const outPath = path.join(tmpDir, "findings.json");

    const stdout = captureStdout(() => {
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        json: true,
        output: outPath,
      });
    });
    expect(stdout).toBe("");
    const onDisk = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].kind).toBe("deadConsumerBranch");
  });

  it("throws on missing provider file", () => {
    fs.writeFileSync(consumerPath, JSON.stringify([]));
    expect(() =>
      check({
        providerFile: path.join(tmpDir, "does-not-exist.json"),
        consumerFile: consumerPath,
      }),
    ).toThrow("File not found");
  });

  it("throws with parse issues when summary JSON is not an array", () => {
    fs.writeFileSync(providerPath, JSON.stringify({ not: "an array" }));
    fs.writeFileSync(consumerPath, JSON.stringify([]));
    expect(() =>
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
      }),
    ).toThrow(/Invalid summary file/);
  });

  it("throws with parse issues when a summary element is malformed", () => {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([{ kind: "handler" /* missing required fields */ }]),
    );
    fs.writeFileSync(consumerPath, JSON.stringify([]));
    expect(() =>
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
      }),
    ).toThrow(/Invalid summary file/);
  });

  it("human output annotates sub-`high` confidence alongside the finding", () => {
    // Confidence is informational only — the checker's severity logic
    // doesn't look at it. The renderer surfaces it so reviewers can weigh
    // findings themselves.
    const prov = provider("getUser", [
      transition("t-200", { statusCode: 200, isDefault: true }),
    ]);
    prov.confidence = { source: "inferred_static", level: "medium" };
    const cons = consumer("UserPage", [
      transition("ct-410", { conditionStatus: 410 }),
      transition("ct-default", { isDefault: true }),
    ]);

    fs.writeFileSync(providerPath, JSON.stringify([prov]));
    fs.writeFileSync(consumerPath, JSON.stringify([cons]));

    const output = captureStdout(() => {
      check({ providerFile: providerPath, consumerFile: consumerPath });
    });

    // Provider is medium → annotation expected on the provider line.
    // Consumer is high (default) → no annotation.
    const providerLine = output
      .split("\n")
      .find((line) => line.includes("provider:"));
    const consumerLine = output
      .split("\n")
      .find((line) => line.includes("consumer:"));

    expect(providerLine).toMatch(/\(confidence: medium\)/);
    expect(consumerLine).not.toMatch(/confidence:/);
  });

  it("human output does not annotate when both sides are high confidence", () => {
    // Sanity check: high confidence is the default, no noise in output.
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-410", { conditionStatus: 410 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );
    const output = captureStdout(() => {
      check({ providerFile: providerPath, consumerFile: consumerPath });
    });
    expect(output).not.toMatch(/confidence:/);
  });

  // ---------------------------------------------------------------------
  // .sussignore — suppression
  // ---------------------------------------------------------------------

  function writeDeadBranchScenario() {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-410", { conditionStatus: 410 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );
  }

  it("marks a suppressed finding and excludes it from the failure threshold", () => {
    writeDeadBranchScenario();
    fs.writeFileSync(
      path.join(tmpDir, ".sussignore.yml"),
      [
        "version: 1",
        "rules:",
        "  - kind: deadConsumerBranch",
        "    boundary: GET /getUser",
        "    reason: consumer retries 410 via middleware",
      ].join("\n"),
    );

    const output = captureStdout(() => {
      const result = check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        sussignore: path.join(tmpDir, ".sussignore.yml"),
        failOn: "warning",
      });
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].suppressed).toEqual({
        reason: "consumer retries 410 via middleware",
        effect: "mark",
      });
      // Marked findings are excluded from --fail-on warning
      expect(result.hasErrors).toBe(false);
    });
    expect(output).toMatch(/suppressed \(mark\): consumer retries 410/);
    expect(output).toMatch(/WARNING, suppressed/);
  });

  it("hides a suppressed finding with effect=hide from the output entirely", () => {
    writeDeadBranchScenario();
    fs.writeFileSync(
      path.join(tmpDir, ".sussignore.yml"),
      [
        "version: 1",
        "rules:",
        "  - kind: deadConsumerBranch",
        "    boundary: GET /getUser",
        "    effect: hide",
        "    reason: legacy quirk",
      ].join("\n"),
    );

    const output = captureStdout(() => {
      const result = check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        sussignore: path.join(tmpDir, ".sussignore.yml"),
      });
      expect(result.findings).toEqual([]);
    });
    expect(output).toMatch(/No findings/);
  });

  it("downgrades severity when effect=downgrade and retains threshold participation", () => {
    writeDeadBranchScenario();
    fs.writeFileSync(
      path.join(tmpDir, ".sussignore.yml"),
      [
        "version: 1",
        "rules:",
        "  - kind: deadConsumerBranch",
        "    boundary: GET /getUser",
        "    effect: downgrade",
        "    reason: not blocking, still watch",
      ].join("\n"),
    );

    const output = captureStdout(() => {
      const result = check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        sussignore: path.join(tmpDir, ".sussignore.yml"),
        failOn: "info",
      });
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe("info");
      expect(result.findings[0].suppressed?.originalSeverity).toBe("warning");
      // downgrade DOES count at its post-downgrade severity;
      // fail-on=info catches it
      expect(result.hasErrors).toBe(true);
    });
    expect(output).toMatch(/downgraded from WARNING/);
  });

  it("auto-discovers .sussignore.yml next to the cwd when no --sussignore override", () => {
    writeDeadBranchScenario();
    fs.writeFileSync(
      path.join(tmpDir, ".sussignore.yml"),
      [
        "version: 1",
        "rules:",
        "  - kind: deadConsumerBranch",
        "    boundary: GET /getUser",
        "    effect: hide",
        "    reason: auto-discovery works",
      ].join("\n"),
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const result = captureStdout(() => {
        const r = check({
          providerFile: providerPath,
          consumerFile: consumerPath,
        });
        expect(r.findings).toEqual([]);
        return r;
      });
      expect(result).toMatch(/No findings/);
    } finally {
      process.chdir(origCwd);
    }
  });

  it("--no-suppressions skips the .sussignore even if one exists", () => {
    writeDeadBranchScenario();
    fs.writeFileSync(
      path.join(tmpDir, ".sussignore.yml"),
      [
        "version: 1",
        "rules:",
        "  - kind: deadConsumerBranch",
        "    boundary: GET /getUser",
        "    effect: hide",
        "    reason: would hide if applied",
      ].join("\n"),
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      captureStdout(() => {
        const r = check({
          providerFile: providerPath,
          consumerFile: consumerPath,
          noSuppressions: true,
        });
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].suppressed).toBeUndefined();
      });
    } finally {
      process.chdir(origCwd);
    }
  });

  it("throws when .sussignore has rules with invalid shape", () => {
    writeDeadBranchScenario();
    fs.writeFileSync(
      path.join(tmpDir, ".sussignore.yml"),
      [
        "version: 1",
        "rules:",
        // narrow-scope rule with only kind → invalid
        "  - kind: deadConsumerBranch",
        "    reason: too broad",
      ].join("\n"),
    );
    expect(() =>
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        sussignore: path.join(tmpDir, ".sussignore.yml"),
      }),
    ).toThrow(/narrow-scope/);
  });

  it("throws when --sussignore points at a missing file", () => {
    writeDeadBranchScenario();
    expect(() =>
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        sussignore: path.join(tmpDir, "does-not-exist.yml"),
      }),
    ).toThrow(/Suppressions file not found/);
  });
});

// ---------------------------------------------------------------------------
// checkDir — automatic boundary pairing
// ---------------------------------------------------------------------------

function providerWithRoute(
  name: string,
  method: string,
  routePath: string,
  transitions: BehavioralSummary["transitions"],
): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: `src/handlers/${name}.ts`,
      range: { start: 1, end: 50 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "ts-rest",
        method,
        path: routePath,
      }),
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function consumerWithRoute(
  name: string,
  method: string,
  routePath: string,
  transitions: BehavioralSummary["transitions"],
): BehavioralSummary {
  return {
    kind: "client",
    location: {
      file: `src/ui/${name}.ts`,
      range: { start: 1, end: 30 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "fetch",
        method,
        path: routePath,
      }),
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("checkDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-checkdir-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureStdout(fn: () => void): string {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      fn();
    } finally {
      process.stdout.write = orig;
    }
    return chunks.join("");
  }

  it("pairs provider and consumer from separate files by method+path", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
          transition("t-404", { statusCode: 404 }),
        ]),
      ]),
    );
    fs.writeFileSync(
      path.join(tmpDir, "consumer.json"),
      JSON.stringify([
        consumerWithRoute("UserPage", "GET", "/users/:id", [
          transition("ct-404", { conditionStatus: 404 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    const output = captureStdout(() => {
      const result = checkDir({ dir: tmpDir });
      expect(result.findings).toEqual([]);
      expect(result.hasErrors).toBe(false);
      expect(result.result.pairs).toHaveLength(1);
      expect(result.result.pairs[0].key).toBe("GET /users/{id}");
    });
    expect(output).toContain("Paired 1 provider-consumer combination");
    expect(output).toContain("No findings");
  });

  it("checks intent specs against code summaries via --intent", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    const intentDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-intentdir-"));
    fs.writeFileSync(
      path.join(intentDir, "users.intent.json"),
      JSON.stringify({
        kind: "boundary",
        name: "users-lookup",
        purpose: "Look up a user by id.",
        audience: "web-client",
        boundary: {
          transport: "http",
          semantics: "rest",
          method: "GET",
          path: "/users/:id",
        },
        transitions: [
          { id: "found", when: "user exists", response: { status: 200 } },
          {
            id: "not-found",
            when: "missing",
            response: {
              status: 404,
              body: { properties: { error: { type: "string" } } },
            },
          },
        ],
      }),
    );
    try {
      const output = captureStdout(() => {
        const result = checkDir({ dir: tmpDir, intent: intentDir });
        const kinds = (result.intent?.findings ?? []).map((f) => f.kind);
        // Code produces 200 but not the declared 404.
        expect(kinds).toContain("uncoveredOutcome");
        expect(result.hasErrors).toBe(true);
        // The intent was paired and compared — coverage accounting.
        expect(result.intent?.checked).toHaveLength(1);
        expect(result.intent?.unchecked).toHaveLength(0);

        // --fail-on none keeps the same intent findings but never fails.
        const lenient = checkDir({
          dir: tmpDir,
          intent: intentDir,
          failOn: "none",
        });
        expect(lenient.intent?.findings).toHaveLength(
          result.intent?.findings.length ?? 0,
        );
        expect(lenient.hasErrors).toBe(false);

        // JSON output carries the intent pass alongside behavioural findings.
        const asJson = checkDir({ dir: tmpDir, intent: intentDir, json: true });
        expect((asJson.intent?.findings ?? []).length).toBeGreaterThan(0);

        // Writing to a file works with --intent.
        const outFile = path.join(tmpDir, "out.txt");
        checkDir({ dir: tmpDir, intent: intentDir, output: outFile });
        expect(fs.readFileSync(outFile, "utf8")).toContain("Intent:");
      });
      expect(output).toContain("Intent:");
      expect(output).toContain("1 boundary intent checked against code");
      expect(output).toContain('"intent"');
    } finally {
      fs.rmSync(intentDir, { recursive: true, force: true });
    }
  });

  it("suppresses intent findings via .sussignore with the same rule shape", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    const intentDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-intsupp-"));
    fs.writeFileSync(
      path.join(intentDir, "users.intent.json"),
      JSON.stringify({
        kind: "boundary",
        name: "users-lookup",
        purpose: "Look up a user by id.",
        audience: "web-client",
        boundary: {
          transport: "http",
          semantics: "rest",
          method: "GET",
          path: "/users/:id",
        },
        transitions: [
          { id: "not-found", when: "missing", response: { status: 404 } },
        ],
      }),
    );
    const sussignore = path.join(intentDir, ".sussignore.json");
    fs.writeFileSync(
      sussignore,
      JSON.stringify({
        version: 1,
        rules: [
          {
            kind: "uncoveredOutcome",
            boundary: "GET /users/:id",
            reason: "404 path ships next sprint",
            effect: "mark",
          },
        ],
      }),
    );
    try {
      const output = captureStdout(() => {
        const result = checkDir({
          dir: tmpDir,
          intent: intentDir,
          sussignore,
        });
        // The finding is still reported, annotated — but mark excludes
        // it from gating, so the run passes.
        expect(result.intent?.findings[0].suppressed).toEqual({
          reason: "404 path ships next sprint",
          effect: "mark",
        });
        expect(result.hasErrors).toBe(false);
      });
      expect(output).toContain("suppressed (mark): 404 path ships next sprint");
    } finally {
      fs.rmSync(intentDir, { recursive: true, force: true });
    }
  });

  it("rejects .sussignore rules that target an unknown finding kind", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    const sussignore = path.join(tmpDir, ".sussignore.json");
    fs.writeFileSync(
      sussignore,
      JSON.stringify({
        version: 1,
        rules: [
          {
            kind: "unconvexedOutcome",
            boundary: "GET /users/:id",
            reason: "typo'd kind",
          },
        ],
      }),
    );
    expect(() => checkDir({ dir: tmpDir, sussignore })).toThrow(
      /unknown finding kind "unconvexedOutcome"/,
    );
  });

  it("checks PRD scenario coverage against loaded system intents", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    const intentDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-prd-"));
    // A system intent the PRD scenarios link into. Its single 200 outcome
    // is fully covered by the provider, so the boundary pass is silent and
    // every finding below comes from PRD coverage.
    fs.writeFileSync(
      path.join(intentDir, "users.intent.json"),
      JSON.stringify({
        kind: "boundary",
        name: "users-lookup",
        purpose: "Look up a user by id.",
        audience: "web-client",
        boundary: {
          transport: "http",
          semantics: "rest",
          method: "GET",
          path: "/users/:id",
        },
        transitions: [
          { id: "found", when: "user exists", response: { status: 200 } },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(intentDir, "profile.prd.json"),
      JSON.stringify({
        kind: "prd",
        title: "profile-lookup",
        purpose: "Fetch a user profile by id.",
        audience: "web-client",
        scenarios: [
          {
            title: "Successful lookup",
            when: "a request arrives with a known id",
            expect: "the caller receives the profile",
            link: "users-lookup.found",
          },
          {
            title: "Missing id",
            when: "the id is omitted",
            expect: "the caller is told the id is required",
            // no link — a valid pending state
          },
          {
            title: "Soft-deleted user",
            when: "the user was soft-deleted",
            expect: "the caller is told the user is gone",
            link: "users-lookup.gone",
          },
        ],
      }),
    );
    try {
      const output = captureStdout(() => {
        const result = checkDir({ dir: tmpDir, intent: intentDir });
        const kinds = (result.intent?.findings ?? []).map((f) => f.kind);
        expect(kinds).toContain("unlinkedScenario"); // Missing id
        expect(kinds).toContain("danglingScenarioLink"); // links to unknown outcome
        // Never silently dropped: the PRD is checked, not shelved.
        expect(result.intent?.unchecked).toHaveLength(0);
        expect(result.intent?.checked).toContainEqual({
          kind: "prd",
          intent: "profile-lookup",
          scenarios: 3,
          resolved: 1,
          unlinked: 1,
        });
        // The dangling link is a warning — it gates at --fail-on warning
        // but not at the default error threshold.
        expect(result.hasErrors).toBe(false);
        expect(
          checkDir({ dir: tmpDir, intent: intentDir, failOn: "warning" })
            .hasErrors,
        ).toBe(true);
      });
      expect(output).toContain("Intent:");
      expect(output).toContain(
        "1 PRD checked: 3 scenarios, 1 resolved, 1 unlinked",
      );
    } finally {
      fs.rmSync(intentDir, { recursive: true, force: true });
    }
  });

  it("rejects an intent directory containing no intent docs", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    const intentDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-noint-"));
    try {
      expect(() => checkDir({ dir: tmpDir, intent: intentDir })).toThrow(
        /No intent docs/,
      );
    } finally {
      fs.rmSync(intentDir, { recursive: true, force: true });
    }
  });

  it("pairs across param syntax styles (:id vs {id})", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      path.join(tmpDir, "consumer.json"),
      JSON.stringify([
        consumerWithRoute("UserPage", "GET", "/users/{id}", [
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    captureStdout(() => {
      const result = checkDir({ dir: tmpDir });
      expect(result.result.pairs).toHaveLength(1);
    });
  });

  it("reports unmatched providers and consumers", () => {
    fs.writeFileSync(
      path.join(tmpDir, "summaries.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
        consumerWithRoute("OrgPage", "GET", "/orgs/:id", [
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    const output = captureStdout(() => {
      const result = checkDir({ dir: tmpDir });
      expect(result.result.pairs).toHaveLength(0);
      expect(result.result.unmatched.providers).toHaveLength(1);
      expect(result.result.unmatched.consumers).toHaveLength(1);
    });
    expect(output).toContain("Unmatched");
    expect(output).toContain("getUser");
    expect(output).toContain("OrgPage");
  });

  it("detects findings across automatically paired summaries", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
          transition("t-404", { statusCode: 404 }),
        ]),
      ]),
    );
    fs.writeFileSync(
      path.join(tmpDir, "consumer.json"),
      JSON.stringify([
        consumerWithRoute("UserPage", "GET", "/users/:id", [
          // Consumer doesn't handle 404
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    captureStdout(() => {
      const result = checkDir({ dir: tmpDir });
      expect(result.findings.length).toBeGreaterThanOrEqual(1);
      expect(
        result.findings.some((f) => f.kind === "unhandledProviderCase"),
      ).toBe(true);
    });
  });

  it("--json emits structured output with pairs and unmatched", () => {
    fs.writeFileSync(
      path.join(tmpDir, "all.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
        consumerWithRoute("UserPage", "GET", "/users/:id", [
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    const output = captureStdout(() => {
      checkDir({ dir: tmpDir, json: true });
    });
    const parsed = JSON.parse(output) as {
      findings: unknown[];
      pairs: Array<{ key: string }>;
      unmatched: {
        providers: unknown[];
        consumers: unknown[];
        noBinding: unknown[];
      };
    };
    expect(parsed.pairs).toHaveLength(1);
    expect(parsed.pairs[0].key).toBe("GET /users/{id}");
    expect(parsed.findings).toEqual([]);
  });

  it("handles multiple endpoints across multiple files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "handlers.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
        providerWithRoute("listUsers", "GET", "/users", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      path.join(tmpDir, "clients.json"),
      JSON.stringify([
        consumerWithRoute("UserPage", "GET", "/users/:id", [
          transition("ct-default", { isDefault: true }),
        ]),
        consumerWithRoute("UserList", "GET", "/users", [
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );

    captureStdout(() => {
      const result = checkDir({ dir: tmpDir });
      expect(result.result.pairs).toHaveLength(2);
    });
  });

  it("throws when directory does not exist", () => {
    expect(() => checkDir({ dir: path.join(tmpDir, "nonexistent") })).toThrow(
      "Directory not found",
    );
  });

  it("throws when directory has no JSON files", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir);
    expect(() => checkDir({ dir: emptyDir })).toThrow("No JSON files");
  });
});

// ---------------------------------------------------------------------------
// --fail-on
// ---------------------------------------------------------------------------

describe("--fail-on threshold", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-failon-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function writeJson(name: string, data: unknown) {
    fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(data));
  }

  it("failOn: none — never triggers hasErrors even with error findings", () => {
    const p = provider("test", [
      transition("p1", { statusCode: 200 }),
      transition("p2", { statusCode: 500 }),
    ]);
    const c = consumer("test", [
      transition("c1", { conditionStatus: 200, isDefault: true }),
    ]);

    writeJson("p.json", [p]);
    writeJson("c.json", [c]);

    const result = check({
      providerFile: path.join(tmpDir, "p.json"),
      consumerFile: path.join(tmpDir, "c.json"),
      failOn: "none",
    });
    expect(result.hasErrors).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("failOn: warning — triggers on warning-severity findings", () => {
    const p = provider("test", [
      transition("p1", { statusCode: 200 }),
      transition("p2", { statusCode: 200 }),
    ]);
    const c = consumer("test", [
      transition("c1", { conditionStatus: 200, isDefault: true }),
    ]);

    writeJson("p.json", [p]);
    writeJson("c.json", [c]);

    const resultWarning = check({
      providerFile: path.join(tmpDir, "p.json"),
      consumerFile: path.join(tmpDir, "c.json"),
      failOn: "warning",
    });

    const resultError = check({
      providerFile: path.join(tmpDir, "p.json"),
      consumerFile: path.join(tmpDir, "c.json"),
      failOn: "error",
    });

    // Same findings, different threshold
    expect(resultWarning.findings).toEqual(resultError.findings);
    // warning threshold catches more
    if (resultWarning.findings.some((f) => f.severity === "warning")) {
      expect(resultWarning.hasErrors).toBe(true);
      expect(resultError.hasErrors).toBe(false);
    }
  });
});
