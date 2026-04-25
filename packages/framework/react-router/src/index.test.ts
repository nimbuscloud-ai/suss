import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { reactRouterFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project — adds fixtures/react-router/*.ts to an in-memory ts-morph project
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(
  __dirname,
  "../../../../fixtures/react-router",
);

async function runAdapter(): Promise<BehavioralSummary[]> {
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
    frameworks: [reactRouterFramework()],
  });

  return await adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Structural sanity checks
// ---------------------------------------------------------------------------

describe("reactRouterFramework — pack shape", () => {
  it("exposes loader/action/component discovery entries", () => {
    const pack = reactRouterFramework();
    expect(pack.name).toBe("react-router");
    expect(pack.discovery.map((d) => d.kind).sort()).toEqual([
      "action",
      "component",
      "loader",
    ]);
    expect(pack.inputMapping.type).toBe("singleObjectParam");
    expect(pack.contractReading).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the react-router fixture
// ---------------------------------------------------------------------------

describe("reactRouterFramework — integration", () => {
  // ts-morph project setup dominates — build the summaries once and reuse.
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 90_000);

  it("discovers both loader and action kinds from named exports", () => {
    // The fixture exports `loader` and `action`. No `default` export in this
    // file, so we expect exactly those two code units.
    expect(summaries).toHaveLength(2);
    const kinds = summaries.map((s) => s.kind).sort();
    expect(kinds).toEqual(["action", "loader"]);
    for (const s of summaries) {
      expect(s.identity.boundaryBinding).toEqual({
        transport: "http",
        semantics: { name: "function-call" },
        recognition: "react-router",
      });
    }
  });

  it("loader assembles three response transitions from the json/redirect helpers", () => {
    const loader = summaries.find((s) => s.kind === "loader");
    expect(loader).toBeDefined();

    // Three detected terminals:
    //   1. json({ error: "not found" }, { status: 404 })  → response, 200 default
    //   2. redirect("/users")                             → response, 302 default
    //   3. json({ user })                                 → default response, 200
    // json()/data() default to 200, redirect() defaults to 302 via
    // the pack's defaultStatusCode extraction.
    expect(loader?.transitions).toHaveLength(3);
    const statuses = loader?.transitions.map((t) =>
      t.output.type === "response" && t.output.statusCode?.type === "literal"
        ? t.output.statusCode.value
        : null,
    );
    expect(statuses).toEqual([200, 302, 200]);
    expect(loader?.transitions.map((t) => t.isDefault)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("loader uses singleObjectParam mapping — params destructure is the sole input", () => {
    const loader = summaries.find((s) => s.kind === "loader");
    expect(loader).toBeDefined();
    if (!loader) {
      throw new Error("loader summary missing");
    }
    expect(loader.inputs).toHaveLength(1);
    const [input] = loader.inputs;
    expect(input.type).toBe("parameter");
    if (input.type === "parameter") {
      expect(input.position).toBe(0);
      expect(input.role).toBe("request");
    }
  });

  it("action assembles two response transitions from the json/redirect helpers", () => {
    const action = summaries.find((s) => s.kind === "action");
    expect(action).toBeDefined();

    // Two terminals:
    //   1. json({ error: "name required" }, { status: 400 })  → response, null status
    //   2. redirect(`/users/${params.id}`)                    → default response
    if (!action) {
      throw new Error("action summary missing");
    }
    expect(action.transitions).toHaveLength(2);
    expect(action.transitions.map((t) => t.isDefault)).toEqual([false, true]);
    for (const t of action.transitions) {
      expect(t.output.type).toBe("response");
    }
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

  it("has no gaps when no contract reading is configured", () => {
    for (const s of summaries) {
      expect(s.gaps).toEqual([]);
      expect(s.metadata).toBeUndefined();
    }
  });
});
