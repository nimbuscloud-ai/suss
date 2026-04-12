import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { expressFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project — adds fixtures/express/*.ts to an in-memory ts-morph project
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/express");

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
    frameworks: [expressFramework()],
  });

  return adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Structural sanity checks — cheap, keep us honest about exported shape
// ---------------------------------------------------------------------------

describe("expressFramework — pack shape", () => {
  it("exposes the expected discovery, terminals, and inputMapping keys", () => {
    const pack = expressFramework();
    expect(pack.name).toBe("express");
    expect(pack.languages).toEqual(["typescript", "javascript"]);
    expect(pack.discovery).toHaveLength(2);
    expect(pack.contractReading).toBeUndefined();
    expect(pack.inputMapping.type).toBe("positionalParams");
  });
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the express fixture
// ---------------------------------------------------------------------------

describe("expressFramework — integration", () => {
  // ts-morph project setup dominates — build the summaries once and reuse.
  let summaries: BehavioralSummary[];
  beforeAll(() => {
    summaries = runAdapter();
  }, 90_000);

  it("discovers every router.<method> handler in the fixture", () => {
    // Three handlers — all registered via router.get(...) so identity.name
    // comes from the registration method verb. boundaryBinding today only
    // carries protocol + framework (method/path extraction for non-contract
    // frameworks is not wired up yet).
    expect(summaries).toHaveLength(3);
    for (const s of summaries) {
      expect(s.kind).toBe("handler");
      expect(s.identity.name).toBe("get");
      expect(s.identity.boundaryBinding).toEqual({
        protocol: "http",
        framework: "express",
      });
    }
  });

  it("maps positional params (req, res, next) to framework roles", () => {
    // The full guard-chain handler has 4 transitions; use that to pick it
    // unambiguously without depending on source order.
    const main = summaries.find((s) => s.transitions.length === 4);
    expect(main).toBeDefined();
    const roles = main!.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.role : null));
    expect(roles).toEqual(["request", "response", "next"]);
  });

  it("assembles the /users/:id guard chain into four response transitions", () => {
    const main = summaries.find((s) => s.transitions.length === 4);
    expect(main).toBeDefined();

    // Branch order:
    //   1. !id                       → res.status(400).json(...)   → 400
    //   2. !user                     → res.status(404).json(...)   → 404
    //   3. user.role === "admin"     → res.json(...)               → null (implicit 200)
    //   4. default                   → res.json(user)              → null (implicit 200)
    const statusCodes = main!.transitions.map((t) =>
      t.output.type === "response" ? t.output.statusCode : "not-response",
    );
    expect(statusCodes).toEqual([
      { type: "literal", value: 400 },
      { type: "literal", value: 404 },
      null,
      null,
    ]);

    // Only the last transition is implicit default.
    expect(main!.transitions.map((t) => t.isDefault)).toEqual([
      false,
      false,
      false,
      true,
    ]);

    // All four outputs are responses (no throws, no render in this fixture).
    for (const t of main!.transitions) {
      expect(t.output.type).toBe("response");
    }
  });

  it("redirect(url) → 1-arg form has no extractable status code", () => {
    // Exactly one redirect handler has a null statusCode (the 1-arg form).
    const singleTxn = summaries.filter((s) => s.transitions.length === 1);
    expect(singleTxn).toHaveLength(2);

    const oneArg = singleTxn.find((s) => {
      const out = s.transitions[0].output;
      return out.type === "response" && out.statusCode === null;
    });
    expect(oneArg).toBeDefined();
    // minArgs: 2 on the redirect terminal's status extraction ensures the
    // URL string does NOT leak in as a status code for the 1-arg form.
  });

  it("redirect(N, url) → 2-arg form extracts the status code from arg 0", () => {
    const twoArg = summaries
      .filter((s) => s.transitions.length === 1)
      .find((s) => {
        const out = s.transitions[0].output;
        return (
          out.type === "response" &&
          out.statusCode?.type === "literal" &&
          out.statusCode.value === 301
        );
      });
    expect(twoArg).toBeDefined();
  });

  it("has no gaps when there is no contract", () => {
    for (const s of summaries) {
      expect(s.gaps).toEqual([]);
    }
  });
});
