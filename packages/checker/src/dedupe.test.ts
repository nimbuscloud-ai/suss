import { describe, expect, it } from "vitest";

import { dedupeFindings } from "./dedupe.js";

import type { Finding } from "@suss/behavioral-ir";

function finding(overrides: Partial<Finding> = {}): Finding {
  const base: Finding = {
    kind: "deadConsumerBranch",
    boundary: {
      protocol: "http",
      framework: "openapi",
      method: "GET",
      path: "/pet/:id",
    },
    provider: {
      summary: "src/stubs/petstore-openapi.json::getPet",
      location: {
        file: "src/stubs/petstore-openapi.json",
        range: { start: 1, end: 10 },
        exportName: null,
      },
    },
    consumer: {
      summary: "src/ui/pet.ts::PetPage",
      transitionId: "ct-400",
      location: {
        file: "src/ui/pet.ts",
        range: { start: 1, end: 30 },
        exportName: "PetPage",
      },
    },
    description: "Consumer expects status 400 but provider never produces it",
    severity: "warning",
  };
  return { ...base, ...overrides };
}

describe("dedupeFindings", () => {
  it("passes single-source findings through untouched (no sources field)", () => {
    const f1 = finding();
    const f2 = finding({ description: "different description" });
    const out = dedupeFindings([f1, f2]);
    expect(out).toHaveLength(2);
    expect(out[0].sources).toBeUndefined();
    expect(out[1].sources).toBeUndefined();
  });

  it("collapses two identical findings from different providers into one with sources", () => {
    const fromOpenapi = finding({
      provider: {
        summary: "src/stubs/petstore-openapi.json::getPet",
        location: {
          file: "src/stubs/petstore-openapi.json",
          range: { start: 1, end: 10 },
          exportName: null,
        },
      },
    });
    const fromCfn = finding({
      provider: {
        summary: "template.yaml::getPet",
        location: {
          file: "template.yaml",
          range: { start: 1, end: 10 },
          exportName: null,
        },
      },
    });

    const out = dedupeFindings([fromOpenapi, fromCfn]);
    expect(out).toHaveLength(1);
    expect(out[0].sources).toEqual(
      // sorted deterministically
      ["src/stubs/petstore-openapi.json::getPet", "template.yaml::getPet"],
    );
    // Representative is the first-seen finding's provider
    expect(out[0].provider.summary).toBe(
      "src/stubs/petstore-openapi.json::getPet",
    );
  });

  it("does not collapse findings that differ in consumer transition", () => {
    const f1 = finding({
      consumer: { ...finding().consumer, transitionId: "ct-400" },
    });
    const f2 = finding({
      consumer: { ...finding().consumer, transitionId: "ct-500" },
    });
    const out = dedupeFindings([f1, f2]);
    expect(out).toHaveLength(2);
  });

  it("does not collapse findings that differ in consumer summary", () => {
    const f1 = finding();
    const f2 = finding({
      consumer: {
        ...finding().consumer,
        summary: "src/ui/other.ts::OtherPage",
      },
    });
    const out = dedupeFindings([f1, f2]);
    expect(out).toHaveLength(2);
  });

  it("does not collapse findings that differ in kind", () => {
    const f1 = finding({ kind: "deadConsumerBranch" });
    const f2 = finding({ kind: "consumerContractViolation" });
    const out = dedupeFindings([f1, f2]);
    expect(out).toHaveLength(2);
  });

  it("does not collapse findings for different boundaries", () => {
    const f1 = finding();
    const f2 = finding({
      boundary: { ...finding().boundary, path: "/order/:id" },
    });
    const out = dedupeFindings([f1, f2]);
    expect(out).toHaveLength(2);
  });

  it("normalizes trivial whitespace differences in descriptions before keying", () => {
    const f1 = finding({
      description: "Consumer expects status 400 but provider never produces it",
    });
    const f2 = finding({
      description:
        "Consumer  expects   status 400 but provider never  produces it",
      provider: {
        summary: "template.yaml::getPet",
        location: {
          file: "template.yaml",
          range: { start: 1, end: 10 },
          exportName: null,
        },
      },
    });
    const out = dedupeFindings([f1, f2]);
    expect(out).toHaveLength(1);
    expect(out[0].sources).toHaveLength(2);
  });

  it("picks the more severe severity when collapsing differs across sources", () => {
    const info = finding({ severity: "info" });
    const err = finding({
      severity: "error",
      provider: {
        summary: "template.yaml::getPet",
        location: {
          file: "template.yaml",
          range: { start: 1, end: 10 },
          exportName: null,
        },
      },
    });
    const out = dedupeFindings([info, err]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("error");
  });

  it("merges existing sources lists when collapsing pre-deduped findings", () => {
    // Simulate calling dedupeFindings on already-deduped results.
    const pre = finding({ sources: ["a::x", "b::y"] });
    const fresh = finding({
      provider: {
        summary: "c::z",
        location: {
          file: "c",
          range: { start: 1, end: 10 },
          exportName: null,
        },
      },
    });
    const out = dedupeFindings([pre, fresh]);
    expect(out).toHaveLength(1);
    expect(out[0].sources).toEqual(["a::x", "b::y", "c::z"]);
  });

  it("preserves input order for representatives across unrelated groups", () => {
    const a = finding({
      consumer: { ...finding().consumer, transitionId: "ct-a" },
    });
    const b = finding({
      consumer: { ...finding().consumer, transitionId: "ct-b" },
    });
    const a2 = finding({
      consumer: { ...finding().consumer, transitionId: "ct-a" },
      provider: {
        summary: "template.yaml::getPet",
        location: {
          file: "template.yaml",
          range: { start: 1, end: 10 },
          exportName: null,
        },
      },
    });
    const out = dedupeFindings([a, b, a2]);
    expect(out).toHaveLength(2);
    expect(out[0].consumer.transitionId).toBe("ct-a");
    expect(out[1].consumer.transitionId).toBe("ct-b");
    expect(out[0].sources).toHaveLength(2);
  });
});
