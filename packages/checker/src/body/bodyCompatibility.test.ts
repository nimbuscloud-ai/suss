import { describe, expect, it } from "vitest";

import {
  consumer,
  provider,
  response,
  statusEq,
  transition,
} from "../__fixtures__/pairs.js";
import { checkBodyCompatibility } from "./bodyCompatibility.js";

import type { TypeShape } from "@suss/behavioral-ir";

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
    expect(findings[0].description).toContain("status 200");
    expect(findings[0].description).toContain("missing fields");
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
    expect(findings[0].description).toContain("status 200");
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
});
