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
    const findings = checkIntentAgreement(
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
    expect(findings).toHaveLength(0);
  });

  it("flags a declared status the code never produces", () => {
    const findings = checkIntentAgreement(
      [
        boundaryIntent(restIntentBinding, [
          response(200, userShape),
          response(404, errorShape),
        ]),
      ],
      [codeSummary(restCodeBinding, [restResponse(200, userShape)])],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "uncoveredOutcome",
      severity: "error",
      boundary: "GET /users/{id}",
      intent: { name: "users-lookup", outcomeId: "s404" },
      code: "src/handler.ts::getUser",
    });
  });

  it("flags a body shape that disagrees with intent", () => {
    const findings = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [codeSummary(restCodeBinding, [restResponse(200, driftedShape)])],
    );
    expect(findings.map((f) => f.kind)).toEqual(["outcomeShapeMismatch"]);
    expect(findings[0].severity).toBe("error");
  });

  it("flags a code status the intent never declares as info", () => {
    const findings = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [
        codeSummary(restCodeBinding, [
          restResponse(200, userShape),
          restResponse(500, null),
        ]),
      ],
    );
    expect(findings.map((f) => f.kind)).toEqual(["undeclaredOutcome"]);
    expect(findings[0].severity).toBe("info");
  });

  it("flags an intent boundary with no implementing code", () => {
    const findings = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("unimplementedBoundary");
    expect(findings[0].code).toBeUndefined();
  });

  it("skips PRD docs and unkeyable boundaries", () => {
    const prd: IntentSummary = {
      kind: "prd",
      title: "t",
      purpose: "p",
      audience: "a",
      source: "author",
      scenarios: [],
    };
    const unkeyable = boundaryIntent(
      functionCallBinding({ transport: "in-process", recognition: "intent" }),
      [response(200, null)],
      "no-key",
    );
    expect(checkIntentAgreement([prd, unkeyable], [])).toHaveLength(0);
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
    expect(checkIntentAgreement([intent], [code])).toHaveLength(0);
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
    const findings = checkIntentAgreement([intent], [code]);
    expect(findings.map((f) => f.kind)).toEqual(["uncoveredOutcome"]);
    expect(findings[0].intent.outcomeId).toBe("missing");
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
    expect(checkIntentAgreement([intent], [code])).toHaveLength(0);
  });
});
