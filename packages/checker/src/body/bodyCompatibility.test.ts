import { describe, expect, it } from "vitest";

import {
  consumer,
  provider,
  response,
  statusEq,
  transition,
} from "../__fixtures__/pairs.js";
import {
  checkBodyCompatibility,
  findOptionalAccesses,
  providerCoversConsumerFields,
} from "./bodyCompatibility.js";

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";

// Helpers for building shapes
const record = (properties: Record<string, TypeShape>): TypeShape => ({
  type: "record",
  properties,
});

const text: TypeShape = { type: "text" };
const num: TypeShape = { type: "number" };

describe("checkBodyCompatibility", () => {
  it("returns no findings when consumer has no expectedInput", () => {
    const p = provider("api", [
      transition("t-200", {
        output: response(200, record({ name: text, email: text })),
        isDefault: true,
      }),
    ]);
    const c = consumer("client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    expect(checkBodyCompatibility(p, c)).toEqual([]);
  });

  it("returns no findings when provider body matches consumer expected fields", () => {
    const p = provider("api", [
      transition("t-200", {
        output: response(200, record({ name: text, email: text, age: num })),
        isDefault: true,
      }),
    ]);
    const c = consumer("client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);
    // Consumer reads body.name and body.email
    c.transitions[0] = {
      ...c.transitions[0],
      expectedInput: record({
        body: record({ name: { type: "unknown" }, email: { type: "unknown" } }),
      }),
    };

    const findings = checkBodyCompatibility(p, c);
    expect(findings).toEqual([]);
  });

  it("emits error when consumer reads field not in provider body", () => {
    const p = provider("api", [
      transition("t-200", {
        output: response(200, record({ name: text })),
        isDefault: true,
      }),
    ]);
    const c = consumer("client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);
    // Consumer reads body.name AND body.email, but provider only has name
    c.transitions[0] = {
      ...c.transitions[0],
      expectedInput: record({
        body: record({
          name: { type: "unknown" },
          email: { type: "unknown" },
        }),
      }),
    };

    const findings = checkBodyCompatibility(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("unhandledProviderCase");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].description).toContain("a 200 body");
    expect(findings[0].description).toContain(
      "the provider can send does not include",
    );
  });

  it("emits lowConfidence when provider body has unknown/ref shapes", () => {
    const p = provider("api", [
      transition("t-200", {
        output: response(200, { type: "ref", name: "User" }),
        isDefault: true,
      }),
    ]);
    const c = consumer("client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);
    c.transitions[0] = {
      ...c.transitions[0],
      expectedInput: record({
        body: record({ name: { type: "unknown" } }),
      }),
    };

    const findings = checkBodyCompatibility(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("lowConfidence");
    expect(findings[0].severity).toBe("info");
  });

  it("checks multiple status codes independently", () => {
    const p = provider("api", [
      transition("t-200", {
        output: response(200, record({ data: text })),
      }),
      transition("t-404", {
        output: response(404, record({ error: text })),
      }),
    ]);
    const c = consumer("client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
      transition("ct-404", {
        conditions: [statusEq(404)],
        output: { type: "return", value: null },
      }),
    ]);

    // Consumer reads data.result from 200 (missing) and error from 404 (present)
    c.transitions[0] = {
      ...c.transitions[0],
      expectedInput: record({
        body: record({ result: { type: "unknown" } }),
      }),
    };
    c.transitions[1] = {
      ...c.transitions[1],
      expectedInput: record({
        body: record({ error: { type: "unknown" } }),
      }),
    };

    const findings = checkBodyCompatibility(p, c);
    // Status 200: consumer reads "result" but provider has "data" → error
    // Status 404: consumer reads "error" and provider has "error" → ok
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("a 200 body");
  });

  it("handles consumer expectedInput without body wrapper", () => {
    const p = provider("api", [
      transition("t-200", {
        output: response(200, record({ name: text })),
        isDefault: true,
      }),
    ]);
    const c = consumer("client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);
    // Direct access without body wrapper (e.g. result.name)
    c.transitions[0] = {
      ...c.transitions[0],
      expectedInput: record({
        name: { type: "unknown" },
        missing: { type: "unknown" },
      }),
    };

    const findings = checkBodyCompatibility(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("unhandledProviderCase");
  });

  it("emits info when consumer reads a field the provider declares optional", () => {
    // Provider's `name` is required, `email` is optional (modeled as
    // union<text, undefined>). Consumer reads both.
    const optionalText: TypeShape = {
      type: "union",
      variants: [text, { type: "undefined" }],
    };
    const p = provider("api", [
      transition("t-200", {
        output: response(200, record({ name: text, email: optionalText })),
        isDefault: true,
      }),
    ]);
    const c = consumer("client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);
    c.transitions[0] = {
      ...c.transitions[0],
      expectedInput: record({
        body: record({
          name: { type: "unknown" },
          email: { type: "unknown" },
        }),
      }),
    };

    const findings = checkBodyCompatibility(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("consumerContractViolation");
    expect(findings[0].severity).toBe("info");
    expect(findings[0].description).toContain("email");
    expect(findings[0].description).toContain("optional");
  });

  it("does not emit a missing-field error for required fields wrapped in optional unions", () => {
    // Regression: when providerCoversConsumerFields encounters a
    // union<T, undefined> wrapping a record, it must unwrap and recurse
    // rather than treating the union as a non-record mismatch.
    const optionalRecord: TypeShape = {
      type: "union",
      variants: [record({ name: text }), { type: "undefined" }],
    };
    const p = provider("api", [
      transition("t-200", {
        output: response(200, record({ profile: optionalRecord })),
        isDefault: true,
      }),
    ]);
    const c = consumer("client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);
    c.transitions[0] = {
      ...c.transitions[0],
      expectedInput: record({
        body: record({
          profile: record({ name: { type: "unknown" } }),
        }),
      }),
    };

    const findings = checkBodyCompatibility(p, c);
    // Two findings: profile is optional (info), and we descend into profile
    // and find name is required so no nomatch.
    const errorFindings = findings.filter((f) => f.severity === "error");
    expect(errorFindings).toHaveLength(0);
    const optionalFindings = findings.filter(
      (f) => f.kind === "consumerContractViolation",
    );
    expect(optionalFindings).toHaveLength(1);
    expect(optionalFindings[0].description).toContain("profile");
  });

  it("skips comparison when provider has no body shape", () => {
    const p = provider("api", [
      transition("t-200", {
        output: response(200),
        isDefault: true,
      }),
    ]);
    const c = consumer("client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);
    c.transitions[0] = {
      ...c.transitions[0],
      expectedInput: record({
        body: record({ name: { type: "unknown" } }),
      }),
    };

    // No body on provider → nothing to compare
    expect(checkBodyCompatibility(p, c)).toEqual([]);
  });

  it("treats a non-record consumer expectedInput as opaque (no comparison, no findings)", () => {
    // expectedInput is a bare leaf rather than a `{ body: ... }` record.
    // unwrapBodyField returns it untouched and providerCoversConsumerFields
    // accepts an unknown consumer leaf, so the provider is never inspected.
    const p = provider("api", [
      transition("t-200", {
        output: response(200, record({ name: text })),
        isDefault: true,
      }),
    ]);
    const c = consumer("client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);
    c.transitions[0] = {
      ...c.transitions[0],
      expectedInput: { type: "unknown" },
    };

    expect(checkBodyCompatibility(p, c)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Default-branch matching: a consumer transition with `isDefault: true`
  // and no status conditions is compared against every provider 2xx body.
  // -------------------------------------------------------------------------
  describe("default consumer branch", () => {
    const defaultConsumer = (expectedBody: TypeShape): BehavioralSummary => {
      const c = consumer("client", [
        transition("ct-default", {
          output: { type: "return", value: null },
          isDefault: true,
        }),
      ]);
      c.transitions[0] = {
        ...c.transitions[0],
        expectedInput: record({ body: expectedBody }),
      };
      return c;
    };

    it("emits a default-branch error when a 2xx provider body misses a consumer field", () => {
      const p = provider("api", [
        transition("t-201", {
          output: response(201, record({ name: text })),
        }),
      ]);
      const c = defaultConsumer(record({ email: { type: "unknown" } }));

      const findings = checkBodyCompatibility(p, c);
      expect(findings).toHaveLength(1);
      expect(findings[0].kind).toBe("unhandledProviderCase");
      expect(findings[0].severity).toBe("error");
      expect(findings[0].description).toContain("default branch");
      expect(findings[0].description).toContain("a 201 body");
    });

    it("lets the default branch read a field only a failing body returns", () => {
      const p = provider("api", [
        transition("t-200", {
          output: response(200, record({ name: text })),
        }),
        transition("t-404", {
          output: response(404, record({ error: text })),
        }),
      ]);
      const c = defaultConsumer(
        record({ name: { type: "unknown" }, error: { type: "unknown" } }),
      );

      expect(checkBodyCompatibility(p, c)).toEqual([]);
    });

    it("does not read the accessor a client reaches the body through as a body field", () => {
      const p = provider("api", [
        transition("t-200", {
          output: response(200, record({ name: text })),
        }),
      ]);
      // `.then((r) => r.json()).then((r) => ...)` records the accessor
      // again inside the shape it already unwrapped once.
      const c = defaultConsumer(
        record({ name: { type: "unknown" }, body: { type: "unknown" } }),
      );

      expect(checkBodyCompatibility(p, c)).toEqual([]);
    });

    it("emits a default-branch optional finding when the 2xx body declares the field optional", () => {
      const optionalText: TypeShape = {
        type: "union",
        variants: [text, { type: "undefined" }],
      };
      const p = provider("api", [
        transition("t-200", {
          output: response(200, record({ email: optionalText })),
        }),
      ]);
      const c = defaultConsumer(record({ email: { type: "unknown" } }));

      const findings = checkBodyCompatibility(p, c);
      expect(findings).toHaveLength(1);
      expect(findings[0].kind).toBe("consumerContractViolation");
      expect(findings[0].severity).toBe("info");
      expect(findings[0].description).toContain("default branch");
      expect(findings[0].description).toContain("email");
      expect(findings[0].description).toContain("optional");
    });

    it("ignores non-2xx provider transitions in the default branch", () => {
      const p = provider("api", [
        transition("t-404", {
          output: response(404, record({ name: text })),
        }),
        transition("t-500", {
          output: response(500, record({ name: text })),
        }),
      ]);
      // Consumer reads a field absent from both 4xx/5xx bodies, but the
      // default branch only compares 2xx responses, so nothing is reported.
      const c = defaultConsumer(record({ missing: { type: "unknown" } }));

      expect(checkBodyCompatibility(p, c)).toEqual([]);
    });

    it("skips a 2xx provider transition whose body is null in the default branch", () => {
      const p = provider("api", [
        transition("t-204", {
          output: response(204, null),
        }),
      ]);
      const c = defaultConsumer(record({ name: { type: "unknown" } }));

      expect(checkBodyCompatibility(p, c)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// providerCoversConsumerFields: field-presence comparison, exported and
// tested directly for the leaf/edge shapes that the integration paths above
// don't naturally reach.
// ---------------------------------------------------------------------------
describe("providerCoversConsumerFields", () => {
  it("returns unknown when a provider record omits a key but carries spreads", () => {
    const provider: TypeShape = {
      type: "record",
      properties: { name: text },
      spreads: [{ sourceText: "...rest" }],
    };
    const consumer = record({ email: { type: "unknown" } });

    // The key isn't present, but a spread could supply it → can't be sure.
    expect(providerCoversConsumerFields(provider, consumer)).toBe("unknown");
  });

  it("returns nomatch when the consumer expects a record but the provider is a scalar", () => {
    const consumer = record({ name: { type: "unknown" } });
    expect(providerCoversConsumerFields(text, consumer)).toBe("nomatch");
  });

  it("returns match when the consumer expects a record and the provider is a dictionary", () => {
    const provider: TypeShape = { type: "dictionary", values: text };
    const consumer = record({ name: { type: "unknown" } });
    expect(providerCoversConsumerFields(provider, consumer)).toBe("match");
  });

  it("returns unknown for a non-record, non-unknown consumer leaf", () => {
    // Consumer leaf is a concrete scalar (not `unknown`, not a record):
    // field-presence tracking can't say anything, so it falls through to
    // unknown rather than asserting a match or mismatch.
    expect(providerCoversConsumerFields(record({ a: text }), num)).toBe(
      "unknown",
    );
  });

  it("propagates nomatch from a nested record up through combineResults", () => {
    // First key matches, second nested key is missing → overall nomatch.
    const provider = record({
      ok: record({ id: text }),
      nested: record({ present: text }),
    });
    const consumer = record({
      ok: record({ id: { type: "unknown" } }),
      nested: record({ absent: { type: "unknown" } }),
    });
    expect(providerCoversConsumerFields(provider, consumer)).toBe("nomatch");
  });

  it("propagates unknown (without nomatch) from a nested record up through combineResults", () => {
    // One nested branch is opaque (ref) → unknown; the sibling matches.
    // combineResults must surface unknown, not match.
    const provider = record({
      ok: record({ id: text }),
      opaque: { type: "ref", name: "Thing" },
    });
    const consumer = record({
      ok: record({ id: { type: "unknown" } }),
      opaque: record({ field: { type: "unknown" } }),
    });
    expect(providerCoversConsumerFields(provider, consumer)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// findOptionalAccesses: dot-paths where the consumer reads a provider field
// declared optional.
// ---------------------------------------------------------------------------
describe("findOptionalAccesses", () => {
  it("unwraps a multi-variant optional union and recurses into the union (no leaf path)", () => {
    // `union<recordA, recordB, undefined>`: unwrapOptional keeps the two
    // non-undefined variants as a union, which is not a record, so recursion
    // into the nested field stops. Only the optional field itself is reported.
    const optionalUnion: TypeShape = {
      type: "union",
      variants: [
        record({ name: text }),
        record({ name: num }),
        { type: "undefined" },
      ],
    };
    const provider = record({ profile: optionalUnion });
    const consumer = record({
      profile: record({ name: { type: "unknown" } }),
    });

    expect(findOptionalAccesses(provider, consumer)).toEqual([["profile"]]);
  });
});
