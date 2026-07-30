import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import expressFramework from "@suss/framework-express";

import { corroborateSummary } from "./corroborate.js";

import type { BehavioralSummary, Corroboration } from "@suss/behavioral-ir";

async function extractHandler(): Promise<{
  summary: BehavioralSummary;
  project: Project;
}> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      target: 99,
      module: 99,
      skipLibCheck: true,
    },
  });
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
