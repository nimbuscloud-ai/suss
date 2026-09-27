import { describe, expect, it } from "vitest";

import { functionCallBinding } from "@suss/behavioral-ir";
import { functionOf, readCallFacts } from "@suss/checker";
import { toCoveringTest } from "@suss/intent-ir";

import { applyIntentSuppressions, checkIntentAgreement } from "./index.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type {
  IntentSource,
  IntentSummary,
  PrdScenarioSummary,
} from "@suss/intent-ir";
import type { CoveringTestLookup } from "./index.js";

const ORDERS_FILE = "src/orders.ts";
const CANCEL_KEY = "fn:@acme/orders::cancelOrder";

function fn(
  name: string,
  file: string,
  line: number,
  effects: Effect[] = [],
): BehavioralSummary {
  return {
    kind: "library",
    location: { file, range: { start: line, end: line + 5 }, exportName: name },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: null,
      id: `@acme/orders::${file}::${name}`,
    },
    inputs: [],
    transitions: [
      {
        id: `${name}:1`,
        conditions: [],
        output: { type: "return", value: null },
        effects,
        location: { start: line, end: line + 5 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function calls(callee: string, target?: BehavioralSummary): Effect {
  return {
    type: "invocation",
    callee,
    args: [],
    async: false,
    ...(target === undefined ? {} : { summary: target.identity.id }),
  };
}

const cancelOrder: BehavioralSummary = {
  ...fn("cancelOrder", ORDERS_FILE, 1),
  identity: {
    ...fn("cancelOrder", ORDERS_FILE, 1).identity,
    boundaryBinding: functionCallBinding({
      transport: "in-process",
      recognition: "package-exports",
      package: "@acme/orders",
      exportPath: ["cancelOrder"],
    }),
  },
};
const refund = fn("refundOrder", "src/refunds.ts", 1);

function testUnit(
  name: string,
  effects: Effect[],
  test: Record<string, unknown> = {},
  line = 10,
): BehavioralSummary {
  return {
    ...fn(name, "src/orders.test.ts", line, effects),
    kind: "test",
    metadata: { test },
  };
}

/** Finds a test by its title path, and a subject by its boundary key or function name. */
function lookupOver(code: BehavioralSummary[]): CoveringTestLookup {
  const facts = readCallFacts(code);
  return {
    facts,
    test: (spelled) => {
      const found = code.find(
        (one) =>
          one.kind === "test" &&
          one.identity.name === spelled.titles.join(" > "),
      );
      return found === undefined
        ? { found: false, message: "and no test here has that title" }
        : { found: true, unit: found };
    },
    subject: (spelledAs) => {
      const units = code.filter(
        (one) =>
          one.identity.name === spelledAs ||
          (spelledAs === CANCEL_KEY && one === cancelOrder),
      );
      return units.length === 0
        ? { found: false, message: `nothing here is ${spelledAs}` }
        : {
            found: true,
            target: {
              functions: units.map((one) => functionOf(one)),
              keys: spelledAs === CANCEL_KEY ? [CANCEL_KEY] : [],
            },
            label: spelledAs,
          };
    },
  };
}

function covered(
  title: string,
  test: string,
  about: string[] = ["cancelOrder"],
): PrdScenarioSummary {
  return {
    title,
    when: "an order is cancelled",
    expect: "it is cancelled once",
    link: [],
    coveredBy: [toCoveringTest(`src/orders.test.ts > ${test}`)],
    about,
  };
}

function prd(
  scenarios: PrdScenarioSummary[],
  source: IntentSource = "author",
): IntentSummary {
  return {
    kind: "prd",
    title: "Cancel an order",
    purpose: "A customer cancels an order.",
    audience: "customers",
    source,
    scenarios,
  };
}

function check(
  scenarios: PrdScenarioSummary[],
  code: BehavioralSummary[],
  source: IntentSource = "author",
) {
  return checkIntentAgreement([prd(scenarios, source)], code, lookupOver(code));
}

describe("a scenario covered by a test", () => {
  it("counts the scenario covered when the test reaches its subject", () => {
    const code = [
      cancelOrder,
      testUnit("cancels", [calls("cancelOrder", cancelOrder)]),
    ];
    const result = check([covered("cancel", "cancels")], code);

    expect(result.findings).toEqual([]);
    expect(result.checked).toContainEqual(
      expect.objectContaining({ covered: 1, unlinked: 0 }),
    );
  });

  it("reports a test no summary here is, with what the lookup said", () => {
    const result = check([covered("cancel", "cancels twice")], [cancelOrder]);

    expect(result.findings).toEqual([
      {
        kind: "missingCoveringTest",
        severity: "warning",
        boundary: "prd:Cancel an order",
        intent: { name: "Cancel an order" },
        scenario: {
          title: "cancel",
          coveredBy: "src/orders.test.ts > cancels twice",
        },
        message:
          'Scenario "cancel" in PRD "Cancel an order" lists the test "src/orders.test.ts > cancels twice", and no test here has that title.',
      },
    ]);
    expect(result.checked).toContainEqual(
      expect.objectContaining({ covered: 0 }),
    );
  });

  it("reports a test that never reaches its subject", () => {
    const code = [
      cancelOrder,
      refund,
      testUnit("cancels", [calls("refundOrder", refund)]),
    ];
    const [finding] = check([covered("cancel", "cancels")], code).findings;

    expect(finding.kind).toBe("testMissesSubject");
    expect(finding.message).toContain("which never reaches cancelOrder");
  });

  it("says which call it could not follow when the test calls something with the subject's name", () => {
    const code = [cancelOrder, testUnit("cancels", [calls("cancelOrder")])];
    const [finding] = check([covered("cancel", "cancels")], code).findings;

    expect(finding.kind).toBe("testMissesSubject");
    expect(finding.message).toContain(
      "which calls cancelOrder, and suss could not follow that call to cancelOrder",
    );
  });

  it("reports a test that reaches its subject only through a module it mocks, and names the mock", () => {
    const service = fn("orderService", "src/service.ts", 1, [
      calls("cancelOrder", cancelOrder),
    ]);
    const code = [
      cancelOrder,
      service,
      testUnit("cancels", [calls("orderService", service)], {
        mocks: [{ module: ORDERS_FILE, written: 'vi.mock("./orders.js")' }],
      }),
    ];
    const [finding] = check([covered("cancel", "cancels")], code).findings;

    expect(finding.kind).toBe("testMissesSubject");
    expect(finding.message).toContain(
      'which reaches cancelOrder only through a call its mocks replace (vi.mock("./orders.js")), by orderService -> cancelOrder',
    );
  });

  it("reports a skipped test without asking what it reaches", () => {
    const code = [
      cancelOrder,
      testUnit("cancels", [calls("cancelOrder", cancelOrder)], {
        skipped: true,
      }),
    ];
    const [finding] = check([covered("cancel", "cancels")], code).findings;

    expect(finding.kind).toBe("coveringTestSkipped");
    expect(finding.message).toContain("marked skip or todo");
  });

  it("falls back on the boundaries the PRD links to when about is empty", () => {
    const linked: IntentSummary = {
      kind: "boundary",
      name: "orders-cancel",
      purpose: "Cancel an order.",
      audience: "customers",
      source: "author",
      boundary: functionCallBinding({
        transport: "in-process",
        recognition: "intent",
        package: "@acme/orders",
        exportPath: ["cancelOrder"],
      }),
      receives: [],
      outcomes: [
        {
          id: "cancelled",
          when: "",
          conditions: [],
          kind: "return",
          status: null,
          body: null,
          errorType: null,
          effects: [],
        },
      ],
      always: [],
    };
    const code = [
      cancelOrder,
      testUnit("cancels", [calls("cancelOrder", cancelOrder)]),
    ];
    const scenarios = [
      { ...covered("linked", "cancels"), link: ["orders-cancel.cancelled"] },
      covered("by test", "cancels", []),
    ];
    const result = checkIntentAgreement(
      [linked, prd(scenarios)],
      code,
      lookupOver(code),
    );

    expect(
      result.findings.filter((one) => one.kind !== "undescribedOutcome"),
    ).toEqual([]);
    expect(result.checked).toContainEqual(
      expect.objectContaining({ kind: "prd", resolved: 1, covered: 2 }),
    );
  });

  it("drops a finding against inferred intent one level", () => {
    const [finding] = check(
      [covered("cancel", "cancels twice")],
      [cancelOrder],
      "inferred",
    ).findings;

    expect(finding).toMatchObject({
      kind: "missingCoveringTest",
      severity: "info",
    });
  });

  it("counts a scenario with a covering test as backed when nothing can look tests up", () => {
    const result = checkIntentAgreement(
      [prd([covered("cancel", "cancels")])],
      [],
    );

    expect(result.findings).toEqual([]);
    expect(result.checked).toContainEqual(
      expect.objectContaining({ covered: 0, unlinked: 0 }),
    );
  });
});

describe("a rule for one scenario", () => {
  it("accepts the scenario it gives, and leaves another in the same PRD reported", () => {
    const findings = checkIntentAgreement(
      [
        prd([
          { ...covered("first", "x"), coveredBy: [], about: [] },
          { ...covered("second", "x"), coveredBy: [], about: [] },
        ]),
      ],
      [],
    ).findings;

    const out = applyIntentSuppressions(findings, [
      {
        kind: "unlinkedScenario",
        boundary: "prd:Cancel an order",
        scenario: "first",
        scope: "narrow",
        reason: "no test yet",
        effect: "mark",
      },
    ]);

    expect(
      out.map((one) => [one.scenario?.title, one.suppressed?.reason]),
    ).toEqual([
      ["first", "no test yet"],
      ["second", undefined],
    ]);
  });
});
