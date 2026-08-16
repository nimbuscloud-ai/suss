import { describe, expect, it } from "vitest";

import {
  type BehavioralSummary,
  type BoundaryBinding,
  functionCallBinding,
  type Output,
  restBinding,
  type TypeShape,
} from "@suss/behavioral-ir";

import { applyIntentSuppressions, checkIntentAgreement } from "./index.js";

import type {
  IntentOutcome,
  IntentSource,
  IntentSummary,
  PrdScenarioSummary,
} from "@suss/intent-ir";

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
  kind: BehavioralSummary["kind"] = "handler",
): BehavioralSummary {
  return {
    kind,
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
        kind: "boundary",
        intent: "users-lookup",
        boundary: "GET /users/{id}",
        implementations: ["src/handler.ts::getUser"],
      },
    ]);
    expect(result.unchecked).toHaveLength(0);
  });

  it("lets a wildcard-method route satisfy a method-named intent, as pairing would", () => {
    const wildcardBinding = restBinding({
      transport: "http",
      method: "*",
      path: "/users/:id",
      recognition: "express",
    });
    const result = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [codeSummary(wildcardBinding, [restResponse(200, userShape)])],
    );
    expect(
      result.findings.filter((f) => f.kind === "unimplementedBoundary"),
    ).toHaveLength(0);
    expect(result.checked[0]?.kind).toBe("boundary");
    if (result.checked[0]?.kind === "boundary") {
      expect(result.checked[0].implementations).toEqual([
        "src/handler.ts::getUser",
      ]);
    }
  });

  it("does not match a route on the same path with a different method", () => {
    const postBinding = restBinding({
      transport: "http",
      method: "POST",
      path: "/users/:id",
      recognition: "express",
    });
    const result = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [codeSummary(postBinding, [restResponse(200, userShape)])],
    );
    expect(result.findings.map((f) => f.kind)).toContain(
      "unimplementedBoundary",
    );
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
    // Two 200 branches: one drifted, one conforming. Outcome↔transition
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
    // The comparison ran: the intent is checked, with no implementations.
    expect(result.checked).toEqual([
      {
        kind: "boundary",
        intent: "users-lookup",
        boundary: "GET /users/{id}",
        implementations: [],
      },
    ]);
  });

  it("does not treat a consumer at the boundary key as an implementation", () => {
    // A client calling the boundary shares its key but provides
    // nothing; with only a consumer present the boundary is
    // unimplemented, not uncovered.
    const consumer = codeSummary(
      restCodeBinding,
      [{ type: "return", value: userShape }],
      "UserCard",
      "client",
    );
    const result = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [consumer],
    );
    expect(result.findings.map((f) => f.kind)).toEqual([
      "unimplementedBoundary",
    ]);
    expect(result.checked).toEqual([
      {
        kind: "boundary",
        intent: "users-lookup",
        boundary: "GET /users/{id}",
        implementations: [],
      },
    ]);
  });

  it("compares only provider-role summaries when a consumer shares the key", () => {
    const provider = codeSummary(restCodeBinding, [
      restResponse(200, userShape),
    ]);
    const consumer = codeSummary(
      restCodeBinding,
      [{ type: "return", value: userShape }],
      "UserCard",
      "client",
    );
    const result = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [consumer, provider],
    );
    expect(result.findings).toHaveLength(0);
    expect(result.checked[0]).toMatchObject({
      kind: "boundary",
      implementations: ["src/handler.ts::getUser"],
    });
  });

  it("emits one undeclaredOutcome per status, not per transition", () => {
    const result = checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(200, userShape)])],
      [
        codeSummary(restCodeBinding, [
          restResponse(200, userShape),
          restResponse(500, null),
          restResponse(500, errorShape),
        ]),
      ],
    );
    expect(result.findings.map((f) => f.kind)).toEqual(["undeclaredOutcome"]);
    expect(result.findings[0].message).toContain("status 500");
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

function outcomeById(id: string, status = 200): IntentOutcome {
  return {
    id,
    when: "",
    kind: "response",
    status,
    body: null,
    errorType: null,
  };
}

function scenario(
  link: string[],
  title: string | null = null,
): PrdScenarioSummary {
  return { title, when: "condition", expect: "outcome", link };
}

function prdDoc(
  scenarios: PrdScenarioSummary[],
  opts: { title?: string; source?: IntentSource } = {},
): IntentSummary {
  return {
    kind: "prd",
    title: opts.title ?? "profile-prd",
    purpose: "Fetch a profile.",
    audience: "web-client",
    source: opts.source ?? "author",
    scenarios,
  };
}

// A boundary intent + code that fully implements it, so the boundary pass
// contributes no findings and result.findings is exactly the PRD coverage.
const usersLookup = boundaryIntent(
  restIntentBinding,
  [outcomeById("found"), outcomeById("found-admin")],
  "users-lookup",
);
const implementedCode = [
  codeSummary(restCodeBinding, [restResponse(200, null)]),
];

describe("checkIntentAgreement — PRD scenario coverage", () => {
  it("emits nothing and accounts a PRD whose links all resolve", () => {
    const result = checkIntentAgreement(
      [
        usersLookup,
        prdDoc([scenario(["users-lookup.found"], "Successful lookup")]),
      ],
      implementedCode,
    );
    expect(result.findings).toHaveLength(0);
    expect(result.unchecked).toHaveLength(0);
    expect(result.checked).toContainEqual({
      kind: "prd",
      intent: "profile-prd",
      scenarios: 1,
      resolved: 1,
      unlinked: 0,
    });
  });

  it("flags an unlinked scenario as info and counts it, never dropping it", () => {
    const result = checkIntentAgreement(
      [prdDoc([scenario([], "Missing id")])],
      [],
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: "unlinkedScenario",
      severity: "info",
      boundary: "prd:profile-prd",
      intent: { name: "profile-prd" },
      scenario: { title: "Missing id" },
    });
    expect(result.checked).toContainEqual({
      kind: "prd",
      intent: "profile-prd",
      scenarios: 1,
      resolved: 0,
      unlinked: 1,
    });
  });

  it("flags a link to an intent name that isn't loaded (dangling)", () => {
    const result = checkIntentAgreement(
      [usersLookup, prdDoc([scenario(["orders-intake.acknowledged"])])],
      implementedCode,
    );
    expect(result.findings.map((f) => f.kind)).toEqual([
      "danglingScenarioLink",
    ]);
    expect(result.findings[0]).toMatchObject({
      severity: "warning",
      boundary: "prd:profile-prd",
      scenario: { link: "orders-intake.acknowledged" },
    });
    expect(result.findings[0].message).toContain(
      'no boundary intent named "orders-intake"',
    );
  });

  it("flags a link to an unknown outcome and keys it on the intent's boundary", () => {
    const result = checkIntentAgreement(
      [usersLookup, prdDoc([scenario(["users-lookup.ghost"])])],
      implementedCode,
    );
    expect(result.findings.map((f) => f.kind)).toEqual([
      "danglingScenarioLink",
    ]);
    // Resolved the intent but not the outcome, keyed on the real boundary
    // so a narrow .sussignore rule can target it.
    expect(result.findings[0].boundary).toBe("GET /users/{id}");
    expect(result.findings[0].message).toContain(
      "known outcomes: found, found-admin",
    );
  });

  it("flags a link that resolves to two intents sharing a name (ambiguous)", () => {
    const dupA = boundaryIntent(restIntentBinding, [outcomeById("x")], "dup");
    const dupB = boundaryIntent(restCodeBinding, [outcomeById("x")], "dup");
    const result = checkIntentAgreement(
      [dupA, dupB, prdDoc([scenario(["dup.x"])])],
      implementedCode,
    );
    const scenarioFindings = result.findings.filter(
      (f) => f.kind === "ambiguousScenarioLink",
    );
    expect(scenarioFindings).toHaveLength(1);
    expect(scenarioFindings[0]).toMatchObject({
      severity: "warning",
      boundary: "prd:profile-prd",
    });
    expect(scenarioFindings[0].message).toContain("2 boundary intents");
  });

  it("reports one finding per unresolved link and doesn't count the scenario resolved", () => {
    const result = checkIntentAgreement(
      [
        usersLookup,
        prdDoc([scenario(["users-lookup.found", "users-lookup.ghost"])]),
      ],
      implementedCode,
    );
    expect(result.findings.map((f) => f.kind)).toEqual([
      "danglingScenarioLink",
    ]);
    expect(result.checked).toContainEqual({
      kind: "prd",
      intent: "profile-prd",
      scenarios: 1,
      resolved: 0,
      unlinked: 0,
    });
  });

  it("downgrades PRD coverage findings from inferred, not-yet-curated intent", () => {
    const inferred = checkIntentAgreement(
      [
        usersLookup,
        prdDoc([scenario(["users-lookup.ghost"])], { source: "inferred" }),
      ],
      implementedCode,
    );
    expect(inferred.findings[0]).toMatchObject({
      kind: "danglingScenarioLink",
      severity: "info", // warning downgraded one level
    });
    const curated = checkIntentAgreement(
      [
        usersLookup,
        prdDoc([scenario(["users-lookup.ghost"])], {
          source: "inferred, curated",
        }),
      ],
      implementedCode,
    );
    expect(curated.findings[0].severity).toBe("warning");
  });
});

describe("applyIntentSuppressions", () => {
  const uncovered = () =>
    checkIntentAgreement(
      [boundaryIntent(restIntentBinding, [response(404, null)])],
      [codeSummary(restCodeBinding, [restResponse(200, null)])],
    ).findings;

  it("marks a finding matched by kind + boundary (either param syntax)", () => {
    // The fixture yields uncoveredOutcome (404 missing) plus an
    // undeclaredOutcome info (200 not declared); the rule targets only
    // the former.
    const out = applyIntentSuppressions(uncovered(), [
      {
        kind: "uncoveredOutcome",
        boundary: "GET /users/:id",
        scope: "narrow",
        reason: "known gap",
        effect: "mark",
      },
    ]);
    expect(out).toHaveLength(2);
    const marked = out.find((f) => f.kind === "uncoveredOutcome");
    const untouched = out.find((f) => f.kind === "undeclaredOutcome");
    expect(marked?.suppressed).toEqual({ reason: "known gap", effect: "mark" });
    expect(untouched?.suppressed).toBeUndefined();
  });

  it("hides a matched finding and matches fn: boundaries verbatim", () => {
    const fnFindings = checkIntentAgreement(
      [
        boundaryIntent(
          fnIntentBinding,
          [
            {
              id: "boom",
              when: "",
              kind: "throw",
              status: null,
              body: null,
              errorType: "Boom",
            },
          ],
          "fn-intent",
        ),
      ],
      [codeSummary(fnCodeBinding, [{ type: "return", value: null }])],
    ).findings;
    const out = applyIntentSuppressions(fnFindings, [
      {
        kind: "uncoveredOutcome",
        boundary: "fn:@acme/api::getUser",
        scope: "narrow",
        reason: "throw path lands with retries",
        effect: "hide",
      },
    ]);
    expect(out).toHaveLength(0);
  });

  it("never matches rules that specify a consumer side", () => {
    const out = applyIntentSuppressions(uncovered(), [
      {
        kind: "uncoveredOutcome",
        boundary: "GET /users/{id}",
        consumer: { transitionId: "t1" },
        scope: "narrow",
        reason: "behavioural-only rule",
        effect: "hide",
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.suppressed === undefined)).toBe(true);
  });

  it("downgrades severity and preserves the original", () => {
    const out = applyIntentSuppressions(uncovered(), [
      {
        kind: "uncoveredOutcome",
        boundary: "GET /users/{id}",
        scope: "narrow",
        reason: "migration window",
        effect: "downgrade",
      },
    ]);
    const downgraded = out.find((f) => f.kind === "uncoveredOutcome");
    expect(downgraded?.severity).toBe("warning");
    expect(downgraded?.suppressed?.originalSeverity).toBe("error");
  });

  it("suppresses a PRD coverage finding on its prd: key", () => {
    const findings = checkIntentAgreement(
      [usersLookup, prdDoc([scenario(["orders-intake.acknowledged"])])],
      implementedCode,
    ).findings;
    const out = applyIntentSuppressions(findings, [
      {
        kind: "danglingScenarioLink",
        boundary: "prd:profile-prd",
        scope: "narrow",
        reason: "downstream service ships next sprint",
        effect: "hide",
      },
    ]);
    expect(out).toHaveLength(0);
  });

  it("suppresses a dangling-outcome finding on the resolved boundary key", () => {
    const findings = checkIntentAgreement(
      [usersLookup, prdDoc([scenario(["users-lookup.ghost"])])],
      implementedCode,
    ).findings;
    const out = applyIntentSuppressions(findings, [
      {
        kind: "danglingScenarioLink",
        boundary: "GET /users/:id",
        scope: "narrow",
        reason: "outcome id pending rename",
        effect: "mark",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].suppressed?.effect).toBe("mark");
  });
});
