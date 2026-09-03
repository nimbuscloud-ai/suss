import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  functionCallBinding,
  restBinding,
  storageBinding,
} from "@suss/behavioral-ir";

import { check, checkDir, checkDirectory } from "./check.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function transition(
  id: string,
  opts: {
    statusCode?: number;
    conditionStatus?: number;
    isDefault?: boolean;
    /** The response gets a record body with these fields. */
    bodyFields?: string[];
    /** The branch reads these fields off the response body. */
    readsBodyFields?: string[];
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
  const body =
    opts.bodyFields !== undefined
      ? {
          type: "record" as const,
          properties: Object.fromEntries(
            opts.bodyFields.map((field) => [field, { type: "text" as const }]),
          ),
        }
      : null;
  const expectedInput =
    opts.readsBodyFields !== undefined
      ? {
          type: "record" as const,
          properties: {
            body: {
              type: "record" as const,
              properties: Object.fromEntries(
                opts.readsBodyFields.map((field) => [
                  field,
                  { type: "unknown" as const },
                ]),
              ),
            },
          },
        }
      : undefined;
  return {
    id,
    conditions,
    output:
      opts.statusCode !== undefined
        ? {
            type: "response",
            statusCode: { type: "literal", value: opts.statusCode },
            body,
            headers: {},
          }
        : { type: "return", value: null },
    effects: [],
    location: { start: 1, end: 10 },
    isDefault: opts.isDefault ?? false,
    ...(expectedInput !== undefined ? { expectedInput } : {}),
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
    // The 200 body has only "name"; the consumer's 200 branch reads
    // "email", so the body check reports an error-severity finding.
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", {
            statusCode: 200,
            isDefault: true,
            bodyFields: ["name"],
          }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-200", {
            conditionStatus: 200,
            readsBodyFields: ["email"],
          }),
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
      const errors = result.findings.filter((f) => f.severity === "error");
      expect(errors.map((f) => f.kind)).toContain("misreadProviderResponse");
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
    ).toThrow("No file at");
  });

  it("throws with parse issues when summary JSON is not an array", () => {
    fs.writeFileSync(providerPath, JSON.stringify({ not: "an array" }));
    fs.writeFileSync(consumerPath, JSON.stringify([]));
    expect(() =>
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
      }),
    ).toThrow(/could not read/);
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
    ).toThrow(/could not read/);
  });

  it("human output annotates sub-`high` confidence alongside the finding", () => {
    // Confidence is informational only: the checker's severity logic
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
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        all: true,
      });
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
  // .sussignore: suppression
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

  /** A pair that disagrees on both sides at once. */
  function writeTwoSidedScenario() {
    fs.writeFileSync(
      providerPath,
      JSON.stringify([
        provider("getUser", [
          transition("t-200", { statusCode: 200, isDefault: true }),
          transition("t-410", { statusCode: 410 }),
        ]),
      ]),
    );
    fs.writeFileSync(
      consumerPath,
      JSON.stringify([
        consumer("UserPage", [
          transition("ct-503", { conditionStatus: 503 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );
  }

  it("prints a rule that names the side the finding's transition sits on", () => {
    writeTwoSidedScenario();
    const output = captureStdout(() => {
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        all: true,
      });
    });
    expect(output).toContain('provider: { transitionId: "t-410" }');
    expect(output).toContain('consumer: { transitionId: "ct-503" }');
  });

  it("silences the finding whose printed rule was copied, and only that one", () => {
    writeTwoSidedScenario();
    const ignore = path.join(tmpDir, ".sussignore.yml");
    fs.writeFileSync(
      ignore,
      [
        "version: 1",
        "rules:",
        "  - kind: unhandledProviderCase",
        '    boundary: "GET /getUser"',
        '    provider: { transitionId: "t-410" }',
        "    reason: the caller retries anything unexpected",
      ].join("\n"),
    );

    captureStdout(() => {
      const result = check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        sussignore: ignore,
      });
      const suppressed = result.findings.filter(
        (f) => f.suppressed !== undefined,
      );
      expect(suppressed).toHaveLength(1);
      expect(suppressed[0].kind).toBe("unhandledProviderCase");
      expect(
        result.findings.some(
          (f) => f.kind === "deadConsumerBranch" && f.suppressed === undefined,
        ),
      ).toBe(true);
    });
  });

  it("stops offering a rule for a finding that a rule already covers", () => {
    writeTwoSidedScenario();
    const ignore = path.join(tmpDir, ".sussignore.yml");
    fs.writeFileSync(
      ignore,
      [
        "version: 1",
        "rules:",
        "  - kind: unhandledProviderCase",
        '    provider: { transitionId: "t-410" }',
        "    reason: the caller retries anything unexpected",
      ].join("\n"),
    );

    const output = captureStdout(() => {
      check({
        providerFile: providerPath,
        consumerFile: consumerPath,
        sussignore: ignore,
        all: true,
      });
    });
    expect(output).not.toContain('provider: { transitionId: "t-410" }');
    expect(output).toContain('consumer: { transitionId: "ct-503" }');
  });

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
// checkDir: automatic boundary pairing
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

  it("says which declared artifact a run left unread", () => {
    // A provider on its own, so the boundary pairs with nothing, and a
    // suss.json saying the project declares a schema nobody read.
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      path.join(tmpDir, "suss.json"),
      JSON.stringify({
        version: 1,
        read: [
          { kind: "contract", from: "prisma", file: "prisma/schema.prisma" },
        ],
      }),
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const output = captureStdout(() => checkDir({ dir: tmpDir }));
      expect(output).toContain("1 artifact this project declares was not read");
      expect(output).toContain(
        "suss contract --from prisma prisma/schema.prisma",
      );
    } finally {
      process.chdir(origCwd);
    }
  });

  it("says nothing about an artifact the run did read", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(
      path.join(tmpDir, "suss.json"),
      JSON.stringify({
        version: 1,
        read: [
          { kind: "contract", from: "prisma", file: "src/handlers/getUser.ts" },
        ],
      }),
    );

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const output = captureStdout(() => checkDir({ dir: tmpDir }));
      expect(output).not.toContain("was not read");
    } finally {
      process.chdir(origCwd);
    }
  });

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
    expect(output).toContain("Compared 1 boundary");
    expect(output).toContain("No findings");
  });

  it("says when two files claim the same boundary", () => {
    // suss tells HTTP boundaries apart by method and path alone, so two
    // services that both serve GET /users look like one, and whoever
    // calls either gets compared against both.
    for (const service of ["svc-a", "svc-b"]) {
      fs.writeFileSync(
        path.join(tmpDir, `${service}.json`),
        JSON.stringify([
          providerWithRoute(`${service}Handler`, "GET", "/users", [
            transition(`${service}-200`, { statusCode: 200, isDefault: true }),
          ]),
        ]),
      );
    }

    const output = captureStdout(() => {
      checkDir({ dir: tmpDir });
    });
    expect(output).toContain("claimed by more than one file");
    expect(output).toContain("GET /users");
    expect(output).toContain("svc-a.json and svc-b.json");
  });

  it("stays quiet when each boundary comes from one file", () => {
    fs.writeFileSync(
      path.join(tmpDir, "provider.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );

    const output = captureStdout(() => {
      checkDir({ dir: tmpDir });
    });
    expect(output).not.toContain("claimed by more than one file");
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
        // The intent was paired and compared: coverage accounting.
        expect(result.intent?.checked).toHaveLength(1);
        expect(result.intent?.unchecked).toHaveLength(0);
        // Provider summaries alone pair nothing, but checking them
        // against an intent doc is a comparison, so the run is not empty.
        expect(result.run).toBeUndefined();

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

        // JSON output includes the intent pass alongside behavioural findings.
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
        // The finding is still reported, annotated: but mark excludes
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
            // no link: a valid pending state
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
        // The dangling link is a warning: it gates at --fail-on warning
        // but not at the default error threshold.
        expect(result.hasErrors).toBe(false);
        expect(
          checkDir({
            dir: tmpDir,
            intent: intentDir,
            failOn: "warning",
          }).hasErrors,
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
        /no intent docs/,
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
      const result = checkDir({ dir: tmpDir, all: true });
      expect(result.result.pairs).toHaveLength(0);
      expect(result.result.unmatched.providers).toHaveLength(1);
      expect(result.result.unmatched.consumers).toHaveLength(1);
    });
    expect(output).toContain("Nothing was compared");
    expect(output).toContain("getUser");
    expect(output).toContain("OrgPage");
  });

  it("checks the summaries beside a file that is not summaries", () => {
    fs.writeFileSync(
      path.join(tmpDir, "summaries.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    fs.writeFileSync(path.join(tmpDir, "report.json"), "not json{");

    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      errors.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    let summaries = 0;
    try {
      summaries = checkDirectory({ dir: tmpDir }).summaries.length;
    } finally {
      process.stderr.write = original;
    }

    expect(summaries).toBe(1);
    expect(errors.join("")).toContain("report.json");
    expect(errors.join("")).toContain("not JSON suss can read");
  });

  it("turns down a folder where nothing is summaries", () => {
    fs.writeFileSync(path.join(tmpDir, "report.json"), "not json{");

    expect(() => checkDirectory({ dir: tmpDir })).toThrow(
      /Nothing in .* is a summaries file/,
    );
  });

  it("says a run with only one side has no other side once, not twice", () => {
    fs.writeFileSync(
      path.join(tmpDir, "summaries.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );

    const output = captureStdout(() => checkDir({ dir: tmpDir }));

    expect(output).toContain("none on the client side");
    expect(output).not.toContain("no client to compare against.");
  });

  it("counts the unmatched two instead of naming them, without --all", () => {
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

    const output = captureStdout(() => checkDir({ dir: tmpDir }));

    expect(output).toContain(
      "1 provider-side boundary has no client to compare against.",
    );
    expect(output).toContain(
      "1 client-side boundary has no provider to compare against.",
    );
    expect(output).toContain("--all to list them");
    expect(output).not.toContain("getUser");
    expect(output).not.toContain("OrgPage");
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
      "No directory at",
    );
  });

  it("throws when directory has no JSON files", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir);
    expect(() => checkDir({ dir: emptyDir })).toThrow("has no JSON files");
  });
});

// ---------------------------------------------------------------------------
// checkDir: what the report says was compared, and how it spells things
// ---------------------------------------------------------------------------

function storageTable(opts: {
  container: string;
  fields: string[];
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "infra/tables.tf",
      range: { start: 1, end: 12 },
      exportName: null,
    },
    identity: {
      id: `infra::infra/tables.tf::${opts.container}`,
      name: opts.container,
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: "terraform",
        storageSystem: "aws.dynamodb",
        scope: "default",
        container: opts.container,
        accessPath: null,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        fieldSet: "exhaustive",
        fields: opts.fields.map((name) => ({ name })),
      },
    },
  };
}

function storageReader(opts: {
  name: string;
  container: string;
  fields: string[];
}): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: `api/src/${opts.name}.ts`,
      range: { start: 1, end: 20 },
      exportName: opts.name,
    },
    identity: {
      id: `api::api/src/${opts.name}.ts::${opts.name}`,
      name: opts.name,
      exportPath: [opts.name],
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [
      {
        id: "t-read",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "interaction",
            binding: storageBinding({
              recognition: "dynamodb-sdk",
              storageSystem: "aws.dynamodb",
              scope: "default",
              container: opts.container,
              accessPath: null,
            }),
            interaction: {
              class: "storage-access",
              kind: "read",
              fields: opts.fields,
            },
          },
        ],
        location: { start: 5, end: 12 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("checkDir over a run whose only comparison is a storage pass", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-storagedir-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The fixture the three problems in the report were found on. */
  function monorepo(): BehavioralSummary[] {
    return [
      storageTable({ container: "orders", fields: ["id", "customerId"] }),
      storageReader({
        name: "listOrders",
        container: "orders",
        fields: ["id", "customerId"],
      }),
      providerWithRoute("health", "GET", "/health", [
        transition("t-200", { statusCode: 200, isDefault: true }),
      ]),
    ];
  }

  it("counts the storage pair in the header instead of saying nothing was compared", () => {
    fs.writeFileSync(path.join(tmpDir, "all.json"), JSON.stringify(monorepo()));
    const { output } = captureQuietly(() =>
      checkDir({ dir: tmpDir, all: true }),
    );

    expect(output).toContain("Compared 1 boundary:");
    expect(output).not.toContain("Nothing was compared");
    expect(output).toContain("aws.dynamodb:orders");
  });

  it("stops listing a compared table as a boundary nothing paired with", () => {
    fs.writeFileSync(path.join(tmpDir, "all.json"), JSON.stringify(monorepo()));
    const { output, result } = captureQuietly(() =>
      checkDir({ dir: tmpDir, all: true }),
    );

    expect(output).not.toContain("Nothing in this run paired with");
    expect(result.result.unmatched.unpairable).toEqual([]);
  });

  it("stops counting the reader as internal code that pairs with nothing", () => {
    fs.writeFileSync(path.join(tmpDir, "all.json"), JSON.stringify(monorepo()));
    const { output } = captureQuietly(() => checkDir({ dir: tmpDir }));

    expect(output).not.toContain("internal code with no boundary");
  });

  it("spells every side as a boundary key or a summary id, never a bare name", () => {
    fs.writeFileSync(path.join(tmpDir, "all.json"), JSON.stringify(monorepo()));
    const { output } = captureQuietly(() =>
      checkDir({ dir: tmpDir, all: true }),
    );

    expect(output).toContain(
      "  aws.dynamodb:orders\n    infra::infra/tables.tf::orders <-> api::api/src/listOrders.ts::listOrders",
    );
    expect(output).toContain(
      "  GET /health\n    src/handlers/health.ts::health",
    );
    // A bare name would sit on a line of its own, which no line here has.
    expect(output).not.toMatch(/^\s+listOrders$/m);
    expect(output).not.toMatch(/^\s+orders$/m);
    expect(output).not.toMatch(/^\s+health$/m);
  });

  it("says how much of the code the comparison stood for", () => {
    const withGap = storageReader({
      name: "listOrders",
      container: "orders",
      fields: ["id", "customerId"],
    });
    withGap.gaps = [
      {
        type: "unfollowedCall",
        conditions: [],
        consequence: "unknown",
        description:
          "The call to this.dao.getEditions lands on a declaration with no body, so whatever runs there is missing from this summary",
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "all.json"),
      JSON.stringify([
        storageTable({ container: "orders", fields: ["id", "customerId"] }),
        withGap,
      ]),
    );
    const { output } = captureQuietly(() => checkDir({ dir: tmpDir }));

    expect(output).toContain(
      "suss met a call it could not follow in one unit, of 2",
    );
    expect(output).toContain("suss inspect");
  });

  it("says nothing about coverage when no summary records a gap", () => {
    fs.writeFileSync(path.join(tmpDir, "all.json"), JSON.stringify(monorepo()));
    const { output } = captureQuietly(() => checkDir({ dir: tmpDir }));

    expect(output).not.toContain("could not read");
  });

  it("keeps saying nothing was compared when a run really compared nothing", () => {
    fs.writeFileSync(
      path.join(tmpDir, "all.json"),
      JSON.stringify([
        storageTable({ container: "orders", fields: ["id"] }),
        providerWithRoute("health", "GET", "/health", [
          transition("t-200", { statusCode: 200, isDefault: true }),
        ]),
      ]),
    );
    const { output } = captureQuietly(() =>
      checkDir({ dir: tmpDir, all: true }),
    );

    expect(output).toContain("Nothing was compared.");
    expect(output).toContain("Nothing in this run paired with this boundary");
    expect(output).toContain("    infra::infra/tables.tf::orders");
  });

  it("counts one boundary when a table is read from two places", () => {
    fs.writeFileSync(
      path.join(tmpDir, "all.json"),
      JSON.stringify([
        storageTable({ container: "orders", fields: ["id", "customerId"] }),
        storageReader({
          name: "listOrders",
          container: "orders",
          fields: ["id"],
        }),
        storageReader({
          name: "getOrder",
          container: "orders",
          fields: ["customerId"],
        }),
      ]),
    );
    const { output, result } = captureQuietly(() =>
      checkDir({ dir: tmpDir, all: true }),
    );

    expect(result.result.pairs).toHaveLength(2);
    expect(output).toContain("Compared 1 boundary:");
    expect(output).toContain(
      "    infra::infra/tables.tf::orders <-> api::api/src/listOrders.ts::listOrders",
    );
    expect(output).toContain(
      "    infra::infra/tables.tf::orders <-> api::api/src/getOrder.ts::getOrder",
    );
  });
});

function captureQuietly<T>(fn: () => T): { output: string; result: T } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = fn();
    return { output: chunks.join(""), result };
  } finally {
    process.stdout.write = orig;
  }
}

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

  it("failOn: none: never triggers hasErrors even with error findings", () => {
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

  it("failOn: warning: triggers on warning-severity findings", () => {
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

// ---------------------------------------------------------------------------
// What a default run prints, and what --all adds back
// ---------------------------------------------------------------------------

describe("the collapsed report", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-collapse-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** One error and one warning, over one paired route. */
  function mixedSeverities(): void {
    fs.writeFileSync(
      path.join(tmpDir, "all.json"),
      JSON.stringify([
        providerWithRoute("getUser", "GET", "/users/:id", [
          transition("t-200", { statusCode: 200, isDefault: true }),
          transition("t-404", { statusCode: 404, bodyFields: ["code"] }),
        ]),
        consumerWithRoute("UserPage", "GET", "/users/:id", [
          // Reads a field the 404 body does not include: the error.
          transition("ct-404", {
            conditionStatus: 404,
            readsBodyFields: ["message"],
          }),
          // Expects a status the provider never produces: the warning.
          transition("ct-410", { conditionStatus: 410 }),
          transition("ct-default", { isDefault: true }),
        ]),
      ]),
    );
  }

  it("writes the error out and counts the warning", () => {
    mixedSeverities();
    const { output } = captureQuietly(() => checkDir({ dir: tmpDir }));

    expect(output).toContain("[ERROR] misreadProviderResponse");
    expect(output).not.toContain("[WARNING]");
    expect(output).toContain("Not shown: 1 deadConsumerBranch (warning).");
    expect(output).toContain("--all to see it");
  });

  it("writes both out under --all", () => {
    mixedSeverities();
    const { output } = captureQuietly(() =>
      checkDir({ dir: tmpDir, all: true }),
    );

    expect(output).toContain("[ERROR] misreadProviderResponse");
    expect(output).toContain("[WARNING] deadConsumerBranch");
    expect(output).not.toContain("Not shown:");
  });

  it("keeps the tally over every finding, shown or not", () => {
    mixedSeverities();
    const { output } = captureQuietly(() => checkDir({ dir: tmpDir }));

    expect(output).toContain("2 findings: 1 error, 1 warning, 0 info");
  });

  it("writes out whatever --fail-on gates the run on", () => {
    mixedSeverities();
    const { output } = captureQuietly(() =>
      checkDir({ dir: tmpDir, failOn: "warning" }),
    );

    expect(output).toContain("[WARNING] deadConsumerBranch");
    expect(output).not.toContain("Not shown:");
  });

  it("leaves --json reporting every finding", () => {
    mixedSeverities();
    const { output } = captureQuietly(() =>
      checkDir({ dir: tmpDir, json: true }),
    );

    const parsed = JSON.parse(output) as { findings: Array<{ kind: string }> };
    expect(parsed.findings).toHaveLength(2);
  });

  it("decides the exit code on the threshold, not on what got printed", () => {
    mixedSeverities();
    const { result } = captureQuietly(() =>
      checkDir({ dir: tmpDir, failOn: "warning" }),
    );

    expect(result.hasErrors).toBe(true);
  });
});

describe("failing when the run compares nothing", () => {
  it("exits non-zero by default, and --allow-empty opts back out", () => {
    // A check that pairs nothing reports nothing, which reads the same
    // as both sides agreeing. A build gated on green needs the two
    // told apart, so this is the default rather than an opt-in.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-empty-"));
    fs.writeFileSync(
      path.join(dir, "providers.json"),
      JSON.stringify([providerWithRoute("getUser", "GET", "/users/:id", [])]),
    );

    expect(checkDir({ dir }).hasErrors).toBe(true);
    expect(checkDir({ dir, allowEmpty: true }).hasErrors).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("says what went wrong in the report, not only in the exit code", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-empty-finding-"));
    fs.writeFileSync(
      path.join(dir, "providers.json"),
      JSON.stringify([providerWithRoute("getUser", "GET", "/users/:id", [])]),
    );

    // A fixer that reacts to a red run and finds nothing to act on
    // makes no change and gives up, so the exit code alone is not
    // enough. The finding says what happened and what to do.
    const { run } = checkDir({ dir });
    expect(run).toHaveLength(1);
    expect(run?.[0]?.kind).toBe("nothingPaired");
    expect(run?.[0]?.severity).toBe("error");
    expect(run?.[0]?.description).toContain("1 summary");
    expect(run?.[0]?.remedy).not.toBe("");

    expect(checkDir({ dir, allowEmpty: true }).run).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stays quiet when something did pair", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-paired-"));
    fs.writeFileSync(
      path.join(dir, "providers.json"),
      JSON.stringify([providerWithRoute("getUser", "GET", "/users/:id", [])]),
    );
    fs.writeFileSync(
      path.join(dir, "consumers.json"),
      JSON.stringify([
        consumerWithRoute("callsGetUser", "GET", "/users/:id", []),
      ]),
    );

    expect(checkDir({ dir }).hasErrors).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
