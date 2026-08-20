import { describe, expect, it } from "vitest";

import {
  bodyFieldTruthy,
  consumer,
  opaqueResponse,
  provider,
  rangeResponse,
  response,
  statusEq,
  successFlag,
  transition,
} from "../__fixtures__/pairs.js";
import { checkResponseMisread } from "./responseMisread.js";

import type { Predicate, TypeShape, ValueRef } from "@suss/behavioral-ir";

const record = (properties: Record<string, TypeShape>): TypeShape => ({
  type: "record",
  properties,
});

const unknown: TypeShape = { type: "unknown" };
const text: TypeShape = { type: "text" };

function reading(
  id: string,
  opts: {
    conditions?: Parameters<typeof transition>[1]["conditions"];
    isDefault?: boolean;
    fields: string[];
  },
) {
  const t = transition(id, {
    ...(opts.conditions !== undefined ? { conditions: opts.conditions } : {}),
    output: { type: "return", value: null },
    ...(opts.isDefault !== undefined ? { isDefault: opts.isDefault } : {}),
  });
  return {
    ...t,
    expectedInput: record({
      body: record(Object.fromEntries(opts.fields.map((f) => [f, unknown]))),
    }),
  };
}

describe("checkResponseMisread — provider ranges", () => {
  it("reports a branch on 404 that reads a field the 4XX body does not carry", () => {
    const p = provider("api", [
      transition("t-4xx", {
        output: rangeResponse(record({ error: text })),
        range: { min: 400, max: 499, spec: "4XX" },
      }),
      transition("t-200", {
        output: response(200, record({ message: text })),
      }),
    ]);
    const c = consumer("client", [
      reading("ct-404", { conditions: [statusEq(404)], fields: ["message"] }),
    ]);

    const findings = checkResponseMisread(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("misreadProviderResponse");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].provider.transitionId).toBe("t-4xx");
    expect(findings[0].description).toContain('reads "message"');
    expect(findings[0].description).toContain("the 4XX body");
    expect(findings[0].description).toContain("apart from the 200");
  });

  it("reports a fall-through path against a 2XX range body", () => {
    const p = provider("api", [
      transition("t-2xx", {
        output: rangeResponse(record({ name: text })),
        range: { min: 200, max: 299, spec: "2XX" },
      }),
    ]);
    const c = consumer("client", [
      reading("ct-default", { isDefault: true, fields: ["email"] }),
    ]);

    const findings = checkResponseMisread(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("the 2XX body");
    expect(findings[0].description).toContain("neither does any other response");
  });

  it("says nothing when the range's body carries the field", () => {
    const p = provider("api", [
      transition("t-4xx", {
        output: rangeResponse(record({ error: text })),
        range: { min: 400, max: 499, spec: "4XX" },
      }),
    ]);
    const c = consumer("client", [
      reading("ct-404", { conditions: [statusEq(404)], fields: ["error"] }),
    ]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("treats a field a guard tests as a discriminator on a range body too", () => {
    const p = provider("api", [
      transition("t-2xx", {
        output: rangeResponse(record({ link: text })),
        range: { min: 200, max: 299, spec: "2XX" },
      }),
      transition("t-4xx", {
        output: rangeResponse(record({ error: text })),
        range: { min: 400, max: 499, spec: "4XX" },
      }),
    ]);
    const c = consumer("client", [
      reading("ct-error", {
        conditions: [bodyFieldTruthy("error")],
        fields: ["error"],
      }),
      reading("ct-default", { isDefault: true, fields: ["link"] }),
    ]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("claims an arrival once, under a literal before the range that also spans it", () => {
    const p = provider("api", [
      transition("t-404", { output: response(404, record({ error: text })) }),
      transition("t-4xx", {
        output: rangeResponse(record({ error: text })),
        range: { min: 400, max: 499, spec: "4XX" },
      }),
    ]);
    const c = consumer("client", [
      reading("ct-404", { conditions: [statusEq(404)], fields: ["message"] }),
    ]);

    const findings = checkResponseMisread(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("the 404 body");
  });
});

describe("checkResponseMisread", () => {
  it("reports a branch that reads a field the status it runs on does not carry", () => {
    const p = provider("api", [
      transition("t-200", { output: response(200, record({ name: text })) }),
    ]);
    const c = consumer("client", [
      reading("ct-200", { conditions: [statusEq(200)], fields: ["email"] }),
    ]);

    const findings = checkResponseMisread(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("misreadProviderResponse");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].aspect).toBe("read");
    expect(findings[0].provider.transitionId).toBe("t-200");
    expect(findings[0].consumer.transitionId).toBe("ct-200");
    expect(findings[0].description).toContain('reads "email"');
    expect(findings[0].description).toContain("the 200 body");
    expect(findings[0].description).toContain("does not include it");
  });

  it("checks each status a consumer branches on independently", () => {
    const p = provider("api", [
      transition("t-200", { output: response(200, record({ data: text })) }),
      transition("t-404", { output: response(404, record({ error: text })) }),
    ]);
    const c = consumer("client", [
      reading("ct-200", { conditions: [statusEq(200)], fields: ["result"] }),
      reading("ct-404", { conditions: [statusEq(404)], fields: ["error"] }),
    ]);

    const findings = checkResponseMisread(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain('reads "result"');
    expect(findings[0].description).toContain("the 200 body");
  });

  it("says which other response does include the field", () => {
    const p = provider("api", [
      transition("t-404", { output: response(404, record({ code: text })) }),
      transition("t-400", { output: response(400, record({ error: text })) }),
    ]);
    const c = consumer("client", [
      reading("ct-404", { conditions: [statusEq(404)], fields: ["error"] }),
    ]);

    const findings = checkResponseMisread(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain(
      "tells the 404 apart from the 400",
    );
  });

  it("reports the fall-through path against the 2xx body it runs on", () => {
    const p = provider("api", [
      transition("t-201", { output: response(201, record({ name: text })) }),
    ]);
    const c = consumer("client", [
      reading("ct-default", { isDefault: true, fields: ["email"] }),
    ]);

    const findings = checkResponseMisread(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("fall-through path");
    expect(findings[0].description).toContain("the 201 body");
    expect(findings[0].description).toContain(
      "neither does any other response",
    );
  });

  it("does not report a field the consumer's own guards test", () => {
    // dub's refresh-domain: `if (res.error)` against a provider whose only
    // response is a 200 without error. Testing the field is telling the
    // cases apart, so reading it is not a misread on any of the paths.
    const p = provider("api", [
      transition("t-200", { output: response(200, record({ success: text })) }),
    ]);
    const c = consumer("client", [
      reading("ct-default", { isDefault: true, fields: ["error"] }),
      reading("ct-error", {
        conditions: [bodyFieldTruthy("error")],
        fields: ["error"],
      }),
    ]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("keeps the fall-through path off the failure statuses", () => {
    const p = provider("api", [
      transition("t-404", { output: response(404, record({ name: text })) }),
      transition("t-500", { output: response(500, record({ name: text })) }),
    ]);
    const c = consumer("client", [
      reading("ct-default", { isDefault: true, fields: ["missing"] }),
    ]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("lets the fall-through path read a field only a failing body returns", () => {
    const p = provider("api", [
      transition("t-200", { output: response(200, record({ name: text })) }),
      transition("t-404", { output: response(404, record({ error: text })) }),
    ]);
    const c = consumer("client", [
      reading("ct-default", { isDefault: true, fields: ["name", "error"] }),
    ]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("skips a response a body-field guard keeps the branch off", () => {
    // `if (!res.ok && res.error) show(res.message)` never runs on the 404
    // whose body has no error to be truthy, so only the 400 is judged.
    const p = provider("api", [
      transition("t-400", { output: response(400, record({ error: text })) }),
      transition("t-404", { output: response(404, record({ code: text })) }),
    ]);
    const c = consumer("client", [
      reading("ct-failure", {
        conditions: [successFlag(true), bodyFieldTruthy("error")],
        fields: ["message"],
      }),
    ]);

    const findings = checkResponseMisread(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("the 400 body");
  });

  it("claims nothing about a body with spreads or an opaque shape", () => {
    const spreadBody: TypeShape = {
      type: "record",
      properties: { name: text },
      spreads: [{ sourceText: "...rest" }],
    };
    const p = provider("api", [
      transition("t-200", { output: response(200, spreadBody) }),
      transition("t-201", {
        output: response(201, { type: "ref", name: "User" }),
      }),
    ]);
    const c = consumer("client", [
      reading("ct-default", { isDefault: true, fields: ["email"] }),
    ]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("reports a union body only when every variant lacks the field", () => {
    const union = (...variants: TypeShape[]): TypeShape => ({
      type: "union",
      variants,
    });
    const p = provider("api", [
      transition("t-200", {
        output: response(200, union(record({ a: text }), record({ b: text }))),
      }),
    ]);
    const c = consumer("client", [
      reading("ct-200", {
        conditions: [statusEq(200)],
        fields: ["a", "missing"],
      }),
    ]);

    const findings = checkResponseMisread(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain('reads "missing"');
  });

  it("stays quiet when another response with the same status carries the field", () => {
    const p = provider("api", [
      transition("t-200a", { output: response(200, record({ a: text })) }),
      transition("t-200b", {
        output: response(200, record({ a: text, b: text })),
      }),
    ]);
    const c = consumer("client", [
      reading("ct-200", { conditions: [statusEq(200)], fields: ["b"] }),
    ]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("does not read the accessor a client reaches the body through as a body field", () => {
    const p = provider("api", [
      transition("t-200", { output: response(200, record({ name: text })) }),
    ]);
    const c = consumer("client", [
      reading("ct-default", { isDefault: true, fields: ["name", "body"] }),
    ]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("returns nothing when the provider has no readable response bodies", () => {
    const p = provider("api", [
      transition("t-204", { output: response(204, null) }),
      transition("t-opaque", { output: opaqueResponse() }),
    ]);
    const c = consumer("client", [
      reading("ct-default", { isDefault: true, fields: ["name"] }),
    ]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("skips a consumer transition with no body reads", () => {
    const p = provider("api", [
      transition("t-200", { output: response(200, record({ name: text })) }),
    ]);
    const bare = transition("ct-bare", {
      output: { type: "return", value: null },
      isDefault: true,
    });
    const opaqueRead = {
      ...transition("ct-opaque", { output: { type: "return", value: null } }),
      expectedInput: { type: "unknown" } as TypeShape,
    };
    const c = consumer("client", [bare, opaqueRead]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("reads a guard through a destructured, input or dependency reference", () => {
    // `const { error } = await res.json()` and friends spell the same
    // discriminator through other reference forms.
    const destructured: Predicate = {
      type: "truthinessCheck",
      subject: {
        type: "derived",
        from: { type: "dependency", name: "res.json", accessChain: [] },
        derivation: { type: "destructured", field: "error" },
      },
      negated: false,
    };
    const inputRef: Predicate = {
      type: "truthinessCheck",
      subject: { type: "input", path: ["payload", "error"] } as ValueRef,
      negated: false,
    };
    const dependencyRef: Predicate = {
      type: "truthinessCheck",
      subject: {
        type: "dependency",
        name: "res.json",
        accessChain: ["error"],
      } as ValueRef,
      negated: false,
    };
    const p = provider("api", [
      transition("t-200", { output: response(200, record({ success: text })) }),
    ]);
    const c = consumer("client", [
      reading("ct-a", { conditions: [destructured], fields: ["error"] }),
      reading("ct-b", { conditions: [inputRef], fields: ["error"] }),
      reading("ct-c", { conditions: [dependencyRef], fields: ["error"] }),
    ]);

    expect(checkResponseMisread(p, c)).toEqual([]);
  });

  it("keeps a branch off responses that cannot satisfy its equality guard", () => {
    // `if (res.code === "NOT_FOUND") show(res.hint)`: the 200 body has no
    // code to compare, so the branch is not judged against it.
    const codeEq: Predicate = {
      type: "comparison",
      left: {
        type: "derived",
        from: { type: "dependency", name: "fetch", accessChain: [] },
        derivation: { type: "propertyAccess", property: "code" },
      },
      op: "eq",
      right: { type: "literal", value: "NOT_FOUND" },
    };
    const p = provider("api", [
      transition("t-404", {
        output: response(404, record({ code: text })),
      }),
    ]);
    const c = consumer("client", [
      reading("ct-code", {
        conditions: [successFlag(true), codeEq],
        fields: ["hint"],
      }),
    ]);

    const findings = checkResponseMisread(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain('reads "hint"');
    expect(findings[0].description).toContain("the 404 body");
  });
});
