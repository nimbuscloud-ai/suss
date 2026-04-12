import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { tsRestFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project — adds fixtures/ts-rest/*.ts to an in-memory ts-morph project
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/ts-rest");

function runAdapter(): BehavioralSummary[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 100, // Bundler
      skipLibCheck: true,
    },
  });
  project.addSourceFilesAtPaths(path.join(fixturesDir, "*.ts"));

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [tsRestFramework()],
  });

  return adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Structural sanity checks
// ---------------------------------------------------------------------------

describe("tsRestFramework — pack shape", () => {
  it("exposes a single handler discovery, returnShape terminal, and contract reading", () => {
    const pack = tsRestFramework();
    expect(pack.name).toBe("ts-rest");
    expect(pack.discovery).toHaveLength(1);
    expect(pack.discovery[0].kind).toBe("handler");
    expect(pack.terminals).toHaveLength(1);
    expect(pack.terminals[0].kind).toBe("response");
    expect(pack.contractReading).toBeDefined();
    expect(pack.inputMapping.type).toBe("destructuredObject");
  });
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the ts-rest fixture
// ---------------------------------------------------------------------------

describe("tsRestFramework — integration", () => {
  // ts-morph project setup dominates — build the summaries once and reuse.
  let summaries: BehavioralSummary[];
  beforeAll(() => {
    summaries = runAdapter();
  }, 30_000);

  it("discovers every handler registered inside s.router(contract, {...})", () => {
    expect(summaries).toHaveLength(2);
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual(["createUser", "getUser"]);
    for (const s of summaries) {
      expect(s.kind).toBe("handler");
    }
  });

  it("getUser binds method/path from the contract", () => {
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser).toBeDefined();
    expect(getUser!.identity.boundaryBinding).toEqual({
      protocol: "http",
      method: "GET",
      path: "/users/:id",
      framework: "core",
    });
  });

  it("createUser binds method/path from the contract", () => {
    const createUser = summaries.find((s) => s.identity.name === "createUser");
    expect(createUser).toBeDefined();
    expect(createUser!.identity.boundaryBinding).toEqual({
      protocol: "http",
      method: "POST",
      path: "/users",
      framework: "core",
    });
  });

  it("getUser assembles the four returnShape transitions with correct status codes", () => {
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser).toBeDefined();

    // Branches in source order:
    //   1. !params.id    → 404
    //   2. !user         → 404
    //   3. user.deletedAt → 404
    //   4. default       → 200
    expect(getUser!.transitions).toHaveLength(4);
    const statusCodes = getUser!.transitions.map((t) =>
      t.output.type === "response" && t.output.statusCode?.type === "literal"
        ? t.output.statusCode.value
        : null,
    );
    expect(statusCodes).toEqual([404, 404, 404, 200]);
    expect(getUser!.transitions.map((t) => t.isDefault)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("createUser assembles two returnShape transitions (400, 201)", () => {
    const createUser = summaries.find((s) => s.identity.name === "createUser");
    expect(createUser).toBeDefined();
    expect(createUser!.transitions).toHaveLength(2);
    const statusCodes = createUser!.transitions.map((t) =>
      t.output.type === "response" && t.output.statusCode?.type === "literal"
        ? t.output.statusCode.value
        : null,
    );
    expect(statusCodes).toEqual([400, 201]);
    expect(createUser!.transitions.map((t) => t.isDefault)).toEqual([
      false,
      true,
    ]);
  });

  it("destructuredObject inputMapping maps params → pathParams and body → requestBody", () => {
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser).toBeDefined();
    const paramsInput = getUser!.inputs.find(
      (i) => i.type === "parameter" && i.name === "params",
    );
    expect(paramsInput).toBeDefined();
    if (paramsInput?.type === "parameter") {
      expect(paramsInput.role).toBe("pathParams");
    }

    const createUser = summaries.find((s) => s.identity.name === "createUser");
    const bodyInput = createUser!.inputs.find(
      (i) => i.type === "parameter" && i.name === "body",
    );
    expect(bodyInput).toBeDefined();
    if (bodyInput?.type === "parameter") {
      expect(bodyInput.role).toBe("requestBody");
    }
  });

  it("surfaces contract-side gaps (getUser declares 500 but never produces it)", () => {
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser).toBeDefined();
    const gap500 = getUser!.gaps.find((g) => g.description.includes("500"));
    expect(gap500).toBeDefined();
    expect(gap500!.type).toBe("unhandledCase");
    expect(gap500!.description).toContain("never produced");
    expect(gap500!.consequence).toBe("frameworkDefault");
  });

  it("attaches the declaredContract to summary metadata", () => {
    const getUser = summaries.find((s) => s.identity.name === "getUser");
    expect(getUser).toBeDefined();
    const contract = getUser!.metadata?.declaredContract as
      | { responses: Array<{ statusCode: number }> }
      | undefined;
    expect(contract).toBeDefined();
    const declaredStatuses = contract!.responses
      .map((r) => r.statusCode)
      .sort();
    expect(declaredStatuses).toEqual([200, 404, 500]);
  });

  it("has high confidence when all conditions resolve to structured predicates", () => {
    for (const s of summaries) {
      expect(s.confidence.level).toBe("high");
      for (const t of s.transitions) {
        for (const c of t.conditions) {
          expect(c.type).not.toBe("opaque");
        }
      }
    }
  });
});
