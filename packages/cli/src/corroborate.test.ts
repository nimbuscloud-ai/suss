import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import expressFramework from "@suss/framework-express";
import { createTestProject } from "@suss/test-project";

import { corroborateSummary } from "./corroborate.js";

import type { BehavioralSummary, Corroboration } from "@suss/behavioral-ir";
import type { Project } from "ts-morph";

async function extractHandler(): Promise<{
  summary: BehavioralSummary;
  project: Project;
}> {
  const project = createTestProject();
  project.createSourceFile(
    "/gen/handler.ts",
    `import { Router } from "express";
const router = Router();
router.get("/users", (req, res) => {
  if (!req.query.id) {
    res.status(400).json({ error: "missing" });
    return;
  }
  if (req.headers.authorization === "admin") {
    res.status(403).json({ error: "no admins" });
    return;
  }
  const user = db.find(req.query.id);
  res.json({ user });
});
export default router;
`,
  );
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [expressFramework()],
    includeReachable: false,
  });
  const summaries = await adapter.extractAll();
  const summary = summaries.find((s) => s.kind === "handler");
  if (summary === undefined) {
    throw new Error("no handler extracted");
  }
  return { summary, project };
}

const corroborationOf = (
  summary: BehavioralSummary,
  status: number,
): Corroboration | undefined =>
  summary.transitions.find(
    (t) =>
      t.output.type === "response" &&
      t.output.statusCode?.type === "literal" &&
      t.output.statusCode.value === status,
  )?.confidence?.corroboration;

describe("corroborateSummary", () => {
  it("observes input-gated guards and marks dependency-gated paths untested", async () => {
    const { summary, project } = await extractHandler();
    const inScope = await corroborateSummary(summary, project, { runs: 10 });
    expect(inScope).toBe(true);

    // Guard transitions execute before any dependency is touched — the
    // harness observes their claimed statuses directly.
    expect(corroborationOf(summary, 400)?.outcome).toBe("observed");
    expect(corroborationOf(summary, 403)?.outcome).toBe("observed");

    // The 200 path touches `db` (not defined in the sandbox) — the
    // ReferenceError marks it dependency-gated rather than refuted.
    const success = corroborationOf(summary, 200);
    expect(success?.outcome).toBe("untested");
    expect(success?.reason).toBe("dependency-gated path");
  });

  it("refutes a doctored claim with a concrete counterexample", async () => {
    const { summary, project } = await extractHandler();
    // Sabotage: claim the 400 guard responds 401.
    const guard = summary.transitions.find(
      (t) =>
        t.output.type === "response" &&
        t.output.statusCode?.type === "literal" &&
        t.output.statusCode.value === 400,
    );
    if (guard === undefined || guard.output.type !== "response") {
      throw new Error("guard transition missing");
    }
    guard.output.statusCode = { type: "literal", value: 401 };

    await corroborateSummary(summary, project, { runs: 10 });
    const verdict = guard.confidence?.corroboration;
    expect(verdict?.outcome).toBe("refuted");
    expect(verdict?.counterexample).toMatchObject({
      observedStatus: 400,
      claimedStatus: 401,
    });
  });

  it("skips summaries outside the supported scope", async () => {
    const { summary, project } = await extractHandler();
    const outOfScope = {
      ...summary,
      kind: "component" as const,
    };
    expect(await corroborateSummary(outOfScope, project)).toBe(false);
  });
});

describe("corroborateSummary — execution edges", () => {
  it("marks a claim untested when every satisfying run errors", async () => {
    const { summary, project } = await extractHandler();
    // Doctor the 400 guard into an unconditional 200 claim over a
    // body that will throw a non-ReferenceError once the guard is
    // bypassed by sampling `id` present — the vm run errors, no
    // verdict lands, and the claim stays honest.
    project.createSourceFile(
      "/gen/throwing.ts",
      `import { Router } from "express";
const router = Router();
router.get("/boom", (req, res) => {
  if (!req.query.id) {
    res.status(400).json({ error: "missing" });
    return;
  }
  throw new TypeError("boom");
});
export default router;
`,
    );
    const adapter2 = createTypeScriptAdapter({
      project,
      frameworks: [expressFramework()],
      includeReachable: false,
    });
    const summaries = await adapter2.extractAll();
    const boom = summaries.find(
      (s) =>
        s.kind === "handler" &&
        s.identity.boundaryBinding?.semantics.name === "rest" &&
        s.identity.boundaryBinding.semantics.path === "/boom",
    );
    if (boom === undefined) {
      throw new Error("boom handler not extracted");
    }
    // Sabotage: claim the throwing path responds 200, unconditionally.
    boom.transitions.push({
      id: "boom:response:200:synthetic",
      conditions: [
        {
          type: "truthinessCheck",
          subject: {
            type: "derived",
            from: {
              type: "derived",
              from: { type: "input", inputRef: "req", path: [] },
              derivation: { type: "propertyAccess", property: "query" },
            },
            derivation: { type: "propertyAccess", property: "id" },
          },
          negated: false,
        },
      ],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 1, end: 1 },
      isDefault: false,
    });
    await corroborateSummary(boom, project, { runs: 5, attempts: 50 });
    const synthetic = boom.transitions.find(
      (t) => t.id === "boom:response:200:synthetic",
    );
    expect(synthetic?.confidence?.corroboration?.outcome).toBe("untested");
    expect(synthetic?.confidence?.corroboration?.reason).toBe(
      "no run produced a verdict",
    );
    expect(summary).toBeDefined();
  });

  it("treats a double-responding handler as no verdict", async () => {
    const { project } = await extractHandler();
    project.createSourceFile(
      "/gen/double.ts",
      `import { Router } from "express";
const router = Router();
router.get("/double", (req, res) => {
  res.status(200).json({ first: true });
  res.status(200).json({ second: true });
});
export default router;
`,
    );
    const adapter2 = createTypeScriptAdapter({
      project,
      frameworks: [expressFramework()],
      includeReachable: false,
    });
    const summaries = await adapter2.extractAll();
    const double = summaries.find(
      (s) =>
        s.kind === "handler" &&
        s.identity.boundaryBinding?.semantics.name === "rest" &&
        s.identity.boundaryBinding.semantics.path === "/double",
    );
    if (double === undefined) {
      throw new Error("double handler not extracted");
    }
    await corroborateSummary(double, project, { runs: 3, attempts: 20 });
    for (const t of double.transitions) {
      const verdict = t.confidence?.corroboration;
      if (verdict !== undefined) {
        // Two responses per run means no run is a clean observation.
        expect(verdict.outcome).toBe("untested");
      }
    }
  });

  it("returns false when the summary's location matches no function", async () => {
    const { summary, project } = await extractHandler();
    const displaced = {
      ...summary,
      location: {
        ...summary.location,
        range: { start: 9999, end: 9999 },
      },
    };
    expect(await corroborateSummary(displaced, project)).toBe(false);
  });
});

describe("corroborateSummary — responder and predicate coverage", () => {
  it("observes sendStatus and redirect responses, walking compound conditions", async () => {
    const { project } = await extractHandler();
    project.createSourceFile(
      "/gen/mixed.ts",
      `import { Router } from "express";
const router = Router();
router.get("/mixed", (req, res) => {
  if (!(req.query.a && req.query.b)) {
    res.sendStatus(422);
    return;
  }
  if (req.query.go) {
    res.redirect("/home");
    return;
  }
  res.status(200).json({ ok: true });
});
export default router;
`,
    );
    const adapter2 = createTypeScriptAdapter({
      project,
      frameworks: [expressFramework()],
      includeReachable: false,
    });
    const summaries = await adapter2.extractAll();
    const mixed = summaries.find(
      (s) =>
        s.kind === "handler" &&
        s.identity.boundaryBinding?.semantics.name === "rest" &&
        s.identity.boundaryBinding.semantics.path === "/mixed",
    );
    if (mixed === undefined) {
      throw new Error("mixed handler not extracted");
    }
    // Synthetic 302 claim gated on `go` — executing it drives the
    // redirect stub; the sendStatus guard drives that stub on its own
    // extracted transition when one exists.
    mixed.transitions.push({
      id: "mixed:response:302:synthetic",
      conditions: [
        {
          type: "compound",
          op: "and",
          operands: [
            {
              type: "truthinessCheck",
              subject: {
                type: "derived",
                from: {
                  type: "derived",
                  from: { type: "input", inputRef: "req", path: [] },
                  derivation: { type: "propertyAccess", property: "query" },
                },
                derivation: { type: "propertyAccess", property: "go" },
              },
              negated: false,
            },
            {
              type: "negation",
              operand: {
                type: "propertyExists",
                subject: {
                  type: "derived",
                  from: { type: "input", inputRef: "req", path: [] },
                  derivation: { type: "propertyAccess", property: "query" },
                },
                property: "missing",
                negated: false,
              },
            },
          ],
        },
      ],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 302 },
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 1, end: 1 },
      isDefault: false,
    });
    // The synthetic claim is UNSOUND on purpose (it omits the a/b
    // guard), so any verdict is acceptable — the point is exercising
    // the redirect stub and the compound/negation/propertyExists
    // fact-collection arms. It must produce SOME verdict.
    await corroborateSummary(mixed, project, { runs: 5, attempts: 200 });
    const synthetic = mixed.transitions.find(
      (t) => t.id === "mixed:response:302:synthetic",
    );
    expect(synthetic?.confidence?.corroboration).toBeDefined();
  });
});
