import { describe, expect, it } from "vitest";

import {
  type BehavioralSummary,
  type BoundaryBinding,
  functionCallBinding,
  type Output,
  restBinding,
  type TypeShape,
} from "@suss/behavioral-ir";

import { checkIntentAgreement } from "./index.js";

import type { IntentOutcome, IntentSummary } from "@suss/intent-ir";

const userShape: TypeShape = {
  type: "record",
  properties: { id: { type: "text" }, fullName: { type: "text" } },
};
const driftedShape: TypeShape = {
  type: "record",
  properties: { id: { type: "text" }, name: { type: "text" } },
};
const errorShape: TypeShape = {
  type: "record",
  properties: { error: { type: "text" } },
};

function boundaryIntent(
  boundary: BoundaryBinding,
  outcomes: IntentOutcome[],
  name = "users-lookup",
): IntentSummary {
  return {
    kind: "boundary",
    name,
    purpose: "Look up a user by id.",
    audience: "web-client",
    source: "author",
    boundary,
    outcomes,
  };
}

function response(status: number, body: TypeShape | null): IntentOutcome {
  return {
    id: `s${status}`,
    when: "",
    kind: "response",
    status,
    body,
    errorType: null,
  };
}

function codeSummary(
  boundary: BoundaryBinding,
  outputs: Output[],
  name = "getUser",
): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "src/handler.ts",
      range: { start: 1, end: 20 },
      exportName: name,
    },
    identity: { name, exportPath: null, boundaryBinding: boundary },
    inputs: [],
    transitions: outputs.map((output, i) => ({
      id: `t${i}`,
      conditions: [],
      output,
      effects: [],
      location: { start: 1, end: 5 },
      isDefault: i === outputs.length - 1,
    })),
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function restResponse(status: number, body: TypeShape | null): Output {
  return {
    type: "response",
    statusCode: { type: "literal", value: status },
    body,
    headers: {},
  };
}

const restIntentBinding = restBinding({
  transport: "http",
  method: "GET",
  path: "/users/:id",
  recognition: "intent",
});
const restCodeBinding = restBinding({
  transport: "http",
  method: "GET",
  path: "/users/:id",
  recognition: "express",
});

describe("checkIntentAgreement — REST", () => {
  it("emits nothing when code produces every declared outcome with matching bodies", () => {
    const result = checkIntentAgreement(
      [
        boundaryIntent(restIntentBinding, [
          response(200, userShape),
          response(404, errorShape),
        ]),
      ],
      [
        codeSummary(restCodeBinding, [
          restResponse(404, errorShape),
          restResponse(200, userShape),
        ]),
      ],
    );
    expect(result.findings).toHaveLength(0);
    expect(result.checked).toEqual([
      {
        intent: "users-lookup",
        boundary: "GET /users/{id}",
        implementations: ["src/handler.ts::getUser"],
      },
    ]);
    expect(result.unchecked).toHaveLength(0);
  });

  it("flags a declared status the code never produces", () => {
    const result = checkIntentAgreement(
      [
        boundaryIntent(restIntentBinding, [
          response(200, userShape),
          response(404, errorShape),
        ]),
      ],
      [codeSummary(restCodeBinding, [restResponse(200, userShape)])],
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: "uncoveredOutcome",
      severity: "error",
      boundary: "GET /users/{id}",
      intent: { name: "users-lookup", outcomeId: "s404" },
      code: "src/handler.ts::getUser",
    });
  });

  it("flags a body shape that disagrees with intent", () => {
    const result = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [codeSummary(restCodeBinding, [restResponse(200, driftedShape)])],
    );
    expect(result.findings.map((f) => f.kind)).toEqual([
      "outcomeShapeMismatch",
    ]);
    expect(result.findings[0].severity).toBe("error");
  });

  it("accepts a declared body when any same-status transition conforms", () => {
    // Two 200 branches — one drifted, one conforming. Outcome↔transition
    // pairing is many-to-many: the declared body is satisfied by the
    // conforming branch regardless of transition order.
    const result = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [
        codeSummary(restCodeBinding, [
          restResponse(200, driftedShape),
          restResponse(200, userShape),
        ]),
      ],
    );
    expect(result.findings).toHaveLength(0);
  });

  it("flags a declared body when every same-status transition disagrees", () => {
    const result = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [
        codeSummary(restCodeBinding, [
          restResponse(200, driftedShape),
          restResponse(200, errorShape),
        ]),
      ],
    );
    expect(result.findings.map((f) => f.kind)).toEqual([
      "outcomeShapeMismatch",
    ]);
  });

  it("flags a code status the intent never declares as info", () => {
    const result = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [
        codeSummary(restCodeBinding, [
          restResponse(200, userShape),
          restResponse(500, null),
        ]),
      ],
    );
    expect(result.findings.map((f) => f.kind)).toEqual(["undeclaredOutcome"]);
    expect(result.findings[0].severity).toBe("info");
  });

  it("flags an intent boundary with no implementing code", () => {
    const result = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [],
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("unimplementedBoundary");
    expect(result.findings[0].code).toBeUndefined();
    // The comparison ran — the intent is checked, with no implementations.
    expect(result.checked).toEqual([
      {
        intent: "users-lookup",
        boundary: "GET /users/{id}",
        implementations: [],
      },
    ]);
  });

  it("reports PRD docs as unchecked, never silently dropped", () => {
    const prd: IntentSummary = {
      kind: "prd",
      title: "orders",
      purpose: "p",
      audience: "a",
      source: "author",
      scenarios: [],
    };
    const result = checkIntentAgreement([prd], []);
    expect(result.findings).toHaveLength(0);
    expect(result.unchecked).toEqual([
      {
        intent: "orders",
        reason: "prd",
        detail: "PRD scenario coverage is not checked yet",
      },
    ]);
  });

  it("reports an unkeyable boundary as a warning finding plus unchecked", () => {
    const unkeyable = boundaryIntent(
      functionCallBinding({
        transport: "in-process",
        recognition: "intent",
        module: "src/lookup.ts",
        exportName: "getUser",
      }),
      [response(200, null)],
      "no-key",
    );
    const result = checkIntentAgreement([unkeyable], []);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: "unkeyableBoundary",
      severity: "warning",
      boundary: "fn:src/lookup.ts::getUser",
      intent: { name: "no-key" },
    });
    expect(result.unchecked).toEqual([
      {
        intent: "no-key",
        reason: "unkeyable",
        detail: "boundary can't be keyed for pairing against code",
      },
    ]);
  });
});

const fnIntentBinding = functionCallBinding({
  transport: "in-process",
  recognition: "intent",
  package: "@acme/api",
  exportPath: ["getUser"],
});
const fnCodeBinding = functionCallBinding({
  transport: "in-process",
  recognition: "ts",
  package: "@acme/api",
  exportPath: ["getUser"],
});

describe("checkIntentAgreement — function-call", () => {
  it("matches return and throw outcomes by kind", () => {
    const intent = boundaryIntent(fnIntentBinding, [
      {
        id: "ok",
        when: "",
        kind: "return",
        status: null,
        body: userShape,
        errorType: null,
      },
      {
        id: "missing",
        when: "",
        kind: "throw",
        status: null,
        body: null,
        errorType: "NotFoundError",
      },
    ]);
    const code = codeSummary(fnCodeBinding, [
      { type: "throw", exceptionType: "NotFoundError", message: null },
      { type: "return", value: userShape },
    ]);
    expect(checkIntentAgreement([intent], [code]).findings).toHaveLength(0);
  });

  it("flags a declared throw the code never produces", () => {
    const intent = boundaryIntent(fnIntentBinding, [
      {
        id: "missing",
        when: "",
        kind: "throw",
        status: null,
        body: null,
        errorType: "NotFoundError",
      },
    ]);
    const code = codeSummary(fnCodeBinding, [
      { type: "return", value: userShape },
    ]);
    const result = checkIntentAgreement([intent], [code]);
    expect(result.findings.map((f) => f.kind)).toEqual(["uncoveredOutcome"]);
    expect(result.findings[0].intent.outcomeId).toBe("missing");
  });

  it("does not treat undeclared returns as exceeded (only REST statuses)", () => {
    const intent = boundaryIntent(fnIntentBinding, [
      {
        id: "ok",
        when: "",
        kind: "return",
        status: null,
        body: null,
        errorType: null,
      },
    ]);
    const code = codeSummary(fnCodeBinding, [
      { type: "return", value: userShape },
    ]);
    expect(checkIntentAgreement([intent], [code]).findings).toHaveLength(0);
  });
});
