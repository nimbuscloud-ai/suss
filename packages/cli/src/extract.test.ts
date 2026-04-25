import { describe, expect, it } from "vitest";

import { formatCacheDiagnostic } from "./extract.js";

import type { CacheDiagnostic } from "@suss/adapter-typescript";

describe("formatCacheDiagnostic", () => {
  it("renders a hit", () => {
    const out = formatCacheDiagnostic({ kind: "hit" });
    expect(out).toContain("hit");
  });

  it("renders a miss with no manifest", () => {
    const out = formatCacheDiagnostic({
      kind: "miss",
      missReason: "no-manifest",
    });
    expect(out).toContain("miss");
    expect(out).toContain("no-manifest");
  });

  it("renders a partial-hit with the file-churn breakdown", () => {
    const diag: CacheDiagnostic = {
      kind: "partial-hit",
      partial: {
        reusedSummaries: 2585,
        filesToReExtract: 1,
        addedFiles: 0,
        removedFiles: 0,
        changedFiles: 1,
      },
    };
    const out = formatCacheDiagnostic(diag);
    expect(out).toContain("partial-hit");
    expect(out).toContain("1 changed");
    expect(out).toContain("reused 2585");
    expect(out).toContain("re-extracted 1");
  });

  it("includes added / removed counts in the partial-hit breakdown", () => {
    const diag: CacheDiagnostic = {
      kind: "partial-hit",
      partial: {
        reusedSummaries: 100,
        filesToReExtract: 6,
        addedFiles: 3,
        removedFiles: 2,
        changedFiles: 1,
      },
    };
    const out = formatCacheDiagnostic(diag);
    expect(out).toContain("1 changed");
    expect(out).toContain("3 added");
    expect(out).toContain("2 removed");
  });

  it("falls back when missReason is set without a partial breakdown", () => {
    const out = formatCacheDiagnostic({
      kind: "miss",
      missReason: "schema-mismatch",
    });
    expect(out).toContain("schema-mismatch");
  });
});
