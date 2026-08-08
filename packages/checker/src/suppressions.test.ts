import { describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import {
  applySuppressions,
  countsForThreshold,
  type SuppressionRule,
  SuppressionRuleSchema,
  validateRule,
} from "./suppressions.js";

import type { Finding } from "@suss/behavioral-ir";

function finding(overrides: Partial<Finding> = {}): Finding {
  const base: Finding = {
    kind: "deadConsumerBranch",
    boundary: restBinding({
      transport: "http",
      recognition: "fetch",
      method: "GET",
      path: "/pet/:id",
    }),
    provider: {
      summary: "src/handlers/pet.ts::getPet",
      location: {
        file: "src/handlers/pet.ts",
        range: { start: 1, end: 20 },
        exportName: "getPet",
      },
    },
    consumer: {
      summary: "src/ui/pet.ts::PetPage",
      transitionId: "ct-500",
      location: {
        file: "src/ui/pet.ts",
        range: { start: 1, end: 30 },
        exportName: "PetPage",
      },
    },
    description: "Consumer expects status 500 but provider never produces it",
    severity: "warning",
  };
  return { ...base, ...overrides };
}

function rule(overrides: Partial<SuppressionRule> = {}): SuppressionRule {
  return SuppressionRuleSchema.parse({
    kind: "deadConsumerBranch",
    boundary: "GET /pet/:id",
    reason: "accepted",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// validateRule — shape preconditions
// ---------------------------------------------------------------------------

describe("validateRule", () => {
  it("accepts a narrow rule with kind + boundary", () => {
    expect(validateRule(rule())).toBeNull();
  });

  it("accepts a narrow rule with kind + consumer.transitionId", () => {
    const r = SuppressionRuleSchema.parse({
      kind: "deadConsumerBranch",
      consumer: { transitionId: "ct-500" },
      reason: "x",
    });
    expect(validateRule(r)).toBeNull();
  });

  it("rejects a narrow rule with only kind (no boundary or transitionId)", () => {
    const r = SuppressionRuleSchema.parse({
      kind: "deadConsumerBranch",
      reason: "x",
    });
    expect(validateRule(r)).toMatch(/narrow-scope/);
  });

  it("rejects a narrow rule with only boundary (no kind)", () => {
    const r = SuppressionRuleSchema.parse({
      boundary: "GET /pet/:id",
      reason: "x",
    });
    expect(validateRule(r)).toMatch(/narrow-scope/);
  });

  it("accepts a broad rule constraining kind only", () => {
    const r = SuppressionRuleSchema.parse({
      kind: "deadConsumerBranch",
      scope: "broad",
      reason: "x",
    });
    expect(validateRule(r)).toBeNull();
  });

  it("rejects a broad rule constraining nothing", () => {
    const r = SuppressionRuleSchema.parse({
      scope: "broad",
      reason: "x",
    });
    expect(validateRule(r)).toMatch(/must constrain at least one field/);
  });
});

// ---------------------------------------------------------------------------
// applySuppressions — matching
// ---------------------------------------------------------------------------

describe("applySuppressions", () => {
  it("leaves unmatched findings untouched", () => {
    const [out] = applySuppressions(
      [finding()],
      [rule({ kind: "lowConfidence" })],
    );
    expect(out.suppressed).toBeUndefined();
  });

  it("annotates a matching finding with reason + default effect 'mark'", () => {
    const [out] = applySuppressions(
      [finding()],
      [rule({ reason: "accepted outage" })],
    );
    expect(out.suppressed).toEqual({
      reason: "accepted outage",
      effect: "mark",
    });
    expect(out.severity).toBe("warning");
  });

  it("downgrades severity and records the original when effect is 'downgrade'", () => {
    const [out] = applySuppressions(
      [finding({ severity: "error" })],
      [rule({ effect: "downgrade" })],
    );
    expect(out.severity).toBe("warning");
    expect(out.suppressed).toEqual({
      reason: "accepted",
      effect: "downgrade",
      originalSeverity: "error",
    });
  });

  it("removes a 'hide'-effect finding from the output", () => {
    const out = applySuppressions([finding()], [rule({ effect: "hide" })]);
    expect(out).toHaveLength(0);
  });

  it("keeps a 'hide'-effect finding when keepHidden is true", () => {
    const [out] = applySuppressions([finding()], [rule({ effect: "hide" })], {
      keepHidden: true,
    });
    expect(out.suppressed?.effect).toBe("hide");
  });

  it("applies the first matching rule only", () => {
    const rules: SuppressionRule[] = [
      rule({ effect: "hide", reason: "first" }),
      rule({ effect: "mark", reason: "second" }),
    ];
    const out = applySuppressions([finding()], rules);
    expect(out).toHaveLength(0); // hidden by first rule
  });

  it("normalizes boundary syntax (`:id` vs `{id}`) when matching", () => {
    const [out1] = applySuppressions(
      [finding()],
      [rule({ boundary: "GET /pet/{id}" })],
    );
    expect(out1.suppressed).toBeDefined();
    // Also accept uppercase/lowercase differences in static segments
    const [out2] = applySuppressions(
      [finding()],
      [rule({ boundary: "get /Pet/:id" })],
    );
    expect(out2.suppressed).toBeDefined();
  });

  it("matches on consumer.transitionId", () => {
    const rules: SuppressionRule[] = [
      SuppressionRuleSchema.parse({
        kind: "deadConsumerBranch",
        consumer: { transitionId: "ct-500" },
        reason: "x",
      }),
    ];
    const [out] = applySuppressions([finding()], rules);
    expect(out.suppressed?.reason).toBe("x");
  });

  it("does not match when consumer.transitionId differs", () => {
    const rules: SuppressionRule[] = [
      SuppressionRuleSchema.parse({
        kind: "deadConsumerBranch",
        consumer: { transitionId: "ct-OTHER" },
        reason: "x",
      }),
    ];
    const [out] = applySuppressions([finding()], rules);
    expect(out.suppressed).toBeUndefined();
  });

  it("matches on provider.transitionId, and only that provider transition", () => {
    const providerFinding = finding({
      kind: "unhandledProviderCase",
      provider: { ...finding().provider, transitionId: "pt-410" },
    });
    const [hit] = applySuppressions(
      [providerFinding],
      [
        SuppressionRuleSchema.parse({
          kind: "unhandledProviderCase",
          provider: { transitionId: "pt-410" },
          reason: "x",
        }),
      ],
    );
    expect(hit.suppressed?.reason).toBe("x");

    const [miss] = applySuppressions(
      [providerFinding],
      [
        SuppressionRuleSchema.parse({
          kind: "unhandledProviderCase",
          provider: { transitionId: "pt-OTHER" },
          reason: "x",
        }),
      ],
    );
    expect(miss.suppressed).toBeUndefined();
  });

  it("leaves a consumer-side finding alone when the rule names a provider transition", () => {
    const [out] = applySuppressions(
      [finding()],
      [
        SuppressionRuleSchema.parse({
          kind: "deadConsumerBranch",
          provider: { transitionId: "ct-500" },
          reason: "x",
        }),
      ],
    );
    expect(out.suppressed).toBeUndefined();
  });

  it("matches on provider.summary", () => {
    const [out] = applySuppressions(
      [finding()],
      [
        SuppressionRuleSchema.parse({
          kind: "deadConsumerBranch",
          boundary: "GET /pet/:id",
          provider: { summary: "src/handlers/pet.ts::getPet" },
          reason: "x",
        }),
      ],
    );
    expect(out.suppressed?.reason).toBe("x");
  });

  it("keeps matching a document a rule names by file name, now that labels carry the path", () => {
    const declared = finding({
      provider: {
        summary: "cloudformation:services/alpha/template.yaml::OrdersQueue",
        location: {
          file: "cloudformation:services/alpha/template.yaml",
          range: { start: 1, end: 1 },
          exportName: null,
        },
      },
    });
    const [out] = applySuppressions(
      [declared],
      [
        SuppressionRuleSchema.parse({
          kind: "deadConsumerBranch",
          boundary: "GET /pet/:id",
          provider: { summary: "cloudformation:template.yaml::OrdersQueue" },
          reason: "x",
        }),
      ],
    );

    expect(out.suppressed?.reason).toBe("x");
  });

  it("does not read a rule naming source code as a file name to search for", () => {
    const [out] = applySuppressions(
      [finding()],
      [
        SuppressionRuleSchema.parse({
          kind: "deadConsumerBranch",
          boundary: "GET /pet/:id",
          provider: { summary: "pet.ts::getPet" },
          reason: "x",
        }),
      ],
    );

    expect(out.suppressed).toBeUndefined();
  });

  it("keeps a rule for one reader off another reader's document", () => {
    const declared = finding({
      provider: {
        summary: "serverless:services/alpha/template.yaml::OrdersQueue",
        location: {
          file: "serverless:services/alpha/template.yaml",
          range: { start: 1, end: 1 },
          exportName: null,
        },
      },
    });
    const [out] = applySuppressions(
      [declared],
      [
        SuppressionRuleSchema.parse({
          kind: "deadConsumerBranch",
          boundary: "GET /pet/:id",
          provider: { summary: "cloudformation:template.yaml::OrdersQueue" },
          reason: "x",
        }),
      ],
    );

    expect(out.suppressed).toBeUndefined();
  });

  it("broad-scope kind-only rule matches any finding of that kind", () => {
    const rules: SuppressionRule[] = [
      SuppressionRuleSchema.parse({
        kind: "deadConsumerBranch",
        scope: "broad",
        effect: "hide",
        reason: "x",
      }),
    ];
    const out = applySuppressions(
      [
        finding({ consumer: { ...finding().consumer, transitionId: "ct-a" } }),
        finding({ consumer: { ...finding().consumer, transitionId: "ct-b" } }),
        finding({ kind: "lowConfidence" }),
      ],
      rules,
    );
    // Both deadConsumerBranch findings hidden; lowConfidence left alone
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("lowConfidence");
  });
});

// ---------------------------------------------------------------------------
// countsForThreshold — exit-code logic
// ---------------------------------------------------------------------------

describe("countsForThreshold", () => {
  it("un-suppressed findings count", () => {
    expect(countsForThreshold(finding())).toBe(true);
  });

  it("'mark' suppressions do not count", () => {
    expect(
      countsForThreshold({
        ...finding(),
        suppressed: { reason: "x", effect: "mark" },
      }),
    ).toBe(false);
  });

  it("'hide' suppressions do not count", () => {
    expect(
      countsForThreshold({
        ...finding(),
        suppressed: { reason: "x", effect: "hide" },
      }),
    ).toBe(false);
  });

  it("'downgrade' suppressions DO count, at the downgraded severity", () => {
    expect(
      countsForThreshold({
        ...finding(),
        suppressed: {
          reason: "x",
          effect: "downgrade",
          originalSeverity: "error",
        },
      }),
    ).toBe(true);
  });
});

describe("rules against deduped sources", () => {
  it("suppresses via a provider listed in sources, not only the representative", () => {
    const collapsed = finding({
      sources: [
        "src/handlers/pet.ts::getPet",
        "template.yml::cfn::GetPetIntegration",
      ],
    });
    const byContributor = rule({
      provider: { summary: "template.yml::cfn::GetPetIntegration" },
    });
    const [out] = applySuppressions([collapsed], [byContributor]);
    expect(out.suppressed).toBeDefined();
  });

  it("does not match sources when the rule also names a transition", () => {
    const collapsed = finding({
      sources: ["template.yml::cfn::GetPetIntegration"],
    });
    const withTransition = rule({
      provider: {
        summary: "template.yml::cfn::GetPetIntegration",
        transitionId: "t-200",
      },
    });
    const [out] = applySuppressions([collapsed], [withTransition]);
    expect(out.suppressed).toBeUndefined();
  });
});
