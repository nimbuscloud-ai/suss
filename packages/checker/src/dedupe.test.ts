import { describe, expect, it } from "vitest";

import { functionCallBinding, restBinding } from "@suss/behavioral-ir";

import { dedupeFindings, mergedSideOf } from "./dedupe.js";

import type { Finding } from "@suss/behavioral-ir";

function finding(overrides: Partial<Finding> = {}): Finding {
  const base: Finding = {
    kind: "deadConsumerBranch",
    boundary: restBinding({
      transport: "http",
      recognition: "openapi",
      method: "GET",
      path: "/pet/:id",
    }),
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
      boundary: restBinding({
        transport: "http",
        recognition: "openapi",
        method: "GET",
        path: "/order/:id",
      }),
    });
    const out = dedupeFindings([f1, f2]);
    expect(out).toHaveLength(2);
  });

  it("keeps two unkeyed boundaries apart instead of collapsing them", () => {
    // A function-call boundary with no package or export path has no
    // key, so nothing says these two findings are about one boundary.
    const unkeyed = functionCallBinding({
      transport: "in-process",
      recognition: "react",
    });
    const first = finding({
      boundary: unkeyed,
      provider: {
        summary: "src/a.tsx::Button",
        location: {
          file: "src/a.tsx",
          range: { start: 1, end: 10 },
          exportName: "Button",
        },
      },
    });
    const second = finding({
      boundary: unkeyed,
      provider: {
        summary: "src/b.tsx::Button",
        location: {
          file: "src/b.tsx",
          range: { start: 1, end: 10 },
          exportName: "Button",
        },
      },
    });
    const out = dedupeFindings([first, second]);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.provider.summary)).toEqual([
      "src/a.tsx::Button",
      "src/b.tsx::Button",
    ]);
  });

  it("still collapses one unkeyed boundary reported twice by one provider", () => {
    const unkeyed = functionCallBinding({
      transport: "in-process",
      recognition: "react",
    });
    const out = dedupeFindings([
      finding({ boundary: unkeyed }),
      finding({ boundary: unkeyed }),
    ]);
    expect(out).toHaveLength(1);
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

  describe("findings whose consumer side is a contract document", () => {
    const handler = {
      summary: "src/handlers/pet.ts::getPet",
      transitionId: "t-403",
      location: {
        file: "src/handlers/pet.ts",
        range: { start: 1, end: 20 },
        exportName: "getPet",
      },
    };
    const documentSide = (file: string) => ({
      summary: `openapi:${file}::getPet`,
      location: {
        file: `openapi:${file}`,
        range: { start: 1, end: 1 },
        exportName: null,
      },
    });
    const undeclared = (file: string, provider = handler): Finding =>
      finding({
        kind: "providerContractViolation",
        provider,
        consumer: documentSide(file),
        description:
          "Handler produces status 403 which the openapi document does not declare",
        severity: "error",
      });
    const documents = new Set([
      "openapi:bundle.json::getPet",
      "openapi:pets.yml::getPet",
    ]);

    it("reports one finding and lists every document it came from", () => {
      const out = dedupeFindings(
        [undeclared("bundle.json"), undeclared("pets.yml")],
        documents,
      );
      expect(out).toHaveLength(1);
      expect(out[0]?.consumer.summary).toBe("openapi:bundle.json::getPet");
      expect(out[0]?.sources).toEqual([
        "openapi:bundle.json::getPet",
        "openapi:pets.yml::getPet",
      ]);
      expect(mergedSideOf(out[0] as Finding)).toBe("consumer");
    });

    it("keeps two handlers apart when both are judged against the documents", () => {
      const other = { ...handler, summary: "src/handlers/pet.ts::getPetV2" };
      const out = dedupeFindings(
        [undeclared("bundle.json"), undeclared("pets.yml", other)],
        documents,
      );
      expect(out).toHaveLength(2);
    });

    it("reports an operation no handler serves once across the documents", () => {
      const unimplemented = (file: string): Finding =>
        finding({
          kind: "contractOperationUnimplemented",
          provider: documentSide(file),
          consumer: documentSide(file),
          description:
            "The openapi contract declares GET /pet/{id} and no extracted provider implements it.",
        });
      const out = dedupeFindings(
        [unimplemented("bundle.json"), unimplemented("pets.yml")],
        documents,
      );
      expect(out).toHaveLength(1);
      expect(out[0]?.sources).toEqual([
        "openapi:bundle.json::getPet",
        "openapi:pets.yml::getPet",
      ]);
    });

    it("keeps the documents apart when nothing says they are documents", () => {
      const out = dedupeFindings([
        undeclared("bundle.json"),
        undeclared("pets.yml"),
      ]);
      expect(out).toHaveLength(2);
    });
  });

  it("says a merge of providers lists providers", () => {
    const fromCfn = finding({
      provider: { ...finding().provider, summary: "template.yaml::getPet" },
    });
    const [merged] = dedupeFindings([finding(), fromCfn]);
    expect(mergedSideOf(merged as Finding)).toBe("provider");
    expect(mergedSideOf(finding())).toBeNull();
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
