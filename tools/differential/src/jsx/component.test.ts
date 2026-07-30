// component.test.ts — the render-boundary differential properties.
//
// The sound tier (see componentGenerators.ts) must hold: every
// generated construct is one the React pack models. The nested
// null-guard was a gap-tier construct with an inverted rediscovery
// milestone until the CFG path engine closed the nested-guard gap —
// its generator now runs as a regular sound property below.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type ComponentDifferentialResult,
  propsBattery,
  runComponentDifferential,
} from "./componentDifferential.js";
import {
  executeComponent,
  transpileComponentModule,
} from "./componentExecute.js";
import {
  arbComponentProgram,
  arbComponentProgramWithNestedGuard,
} from "./componentGenerators.js";
import { claimAdmits, treeAdmits } from "./componentJudge.js";
import {
  type ComponentProgram,
  renderComponentModule,
} from "./componentProgram.js";

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const NUM_RUNS = envInt("SUSS_FUZZ_RUNS", 60);
const SEED = envInt("SUSS_FUZZ_SEED", 20260730);

const guardedProgram: ComponentProgram = {
  props: ["user", "count"],
  guards: [
    {
      type: "guardNull",
      cond: { type: "truthy", prop: "user", negated: true },
    },
  ],
  root: {
    type: "element",
    tag: "div",
    children: [
      {
        type: "ternary",
        cond: { type: "eq", prop: "count", value: "0", negated: false },
        whenTrue: { type: "element", tag: "em", children: [] },
        whenFalse: {
          type: "element",
          tag: "p",
          children: [{ type: "propText", prop: "count" }],
        },
      },
    ],
  },
};

function formatFailure(result: ComponentDifferentialResult): string {
  return [
    "component differential mismatch",
    "",
    "=== module ===",
    result.moduleSource,
    "=== mismatches ===",
    ...result.mismatches.map(
      (m) =>
        `${m.verdict}: ${m.detail}\n  props: ${JSON.stringify(m.props)}\n  observed: ${JSON.stringify(m.observed)}`,
    ),
    "=== harness failures ===",
    ...result.harnessFailures.map(
      (f) => `${f.message}\n  props: ${JSON.stringify(f.props)}`,
    ),
  ].join("\n");
}

describe("component execution harness", () => {
  const transpiled = transpileComponentModule(
    renderComponentModule(guardedProgram),
  );

  it("returns null when the guard fires", () => {
    const result = executeComponent(transpiled, { user: "", count: "0" });
    expect(result).toEqual({ type: "ok", observed: null });
  });

  it("renders the ternary's branches by props", () => {
    const whenZero = executeComponent(transpiled, { user: "u", count: "0" });
    expect(whenZero.type).toBe("ok");
    if (
      whenZero.type === "ok" &&
      whenZero.observed !== null &&
      whenZero.observed.type === "element"
    ) {
      expect(whenZero.observed.tag).toBe("div");
      expect(whenZero.observed.children[0]).toEqual({
        type: "element",
        tag: "em",
        children: [],
      });
    }

    const otherwise = executeComponent(transpiled, { user: "u", count: "7" });
    if (
      otherwise.type === "ok" &&
      otherwise.observed !== null &&
      otherwise.observed.type === "element"
    ) {
      expect(otherwise.observed.children[0]).toEqual({
        type: "element",
        tag: "p",
        children: [{ type: "text", value: "7" }],
      });
    }
  });
});

describe("render claim admissibility", () => {
  it("a nothing-claim admits only null renders", () => {
    expect(claimAdmits({ type: "nothing" }, null)).toBe("true");
    expect(
      claimAdmits(
        { type: "nothing" },
        { type: "element", tag: "div", children: [] },
      ),
    ).toBe("false");
  });

  it("root tag disagreement is a proven mismatch", () => {
    expect(
      treeAdmits(
        { type: "element", tag: "div", children: [] },
        { type: "element", tag: "span", children: [] },
      ),
    ).toBe("false");
  });

  it("missing certain structure is a proven mismatch", () => {
    expect(
      treeAdmits(
        {
          type: "element",
          tag: "div",
          children: [{ type: "element", tag: "h1", children: [] }],
        },
        { type: "element", tag: "div", children: [] },
      ),
    ).toBe("false");
  });

  it("conditional branches are possible, not certain — and force abstention", () => {
    const claim = {
      type: "element" as const,
      tag: "div",
      children: [
        {
          type: "conditional" as const,
          condition: "show",
          whenTrue: { type: "element" as const, tag: "span", children: [] },
          whenFalse: null,
        },
      ],
    };
    // Present or absent, the branch is admitted — but never confirmed.
    expect(
      treeAdmits(claim, {
        type: "element",
        tag: "div",
        children: [{ type: "element", tag: "span", children: [] }],
      }),
    ).toBe("unknown");
    expect(
      treeAdmits(claim, { type: "element", tag: "div", children: [] }),
    ).toBe("unknown");
    // An element neither certain nor possible is inexplicable → false.
    expect(
      treeAdmits(claim, {
        type: "element",
        tag: "div",
        children: [{ type: "element", tag: "table", children: [] }],
      }),
    ).toBe("false");
  });
});

describe("propsBattery", () => {
  it("pins unobserved props and crosses observed ones", () => {
    const battery = propsBattery(guardedProgram);
    // user: ["", "a"] × count: ["", "a", "0"] → 6 assignments
    expect(battery).toHaveLength(6);
    expect(battery.every((props) => Object.hasOwn(props, "user"))).toBe(true);
  });

  it("is deterministic for a given program", () => {
    expect(propsBattery(guardedProgram)).toEqual(propsBattery(guardedProgram));
  });
});

describe("component differential — sound tier", () => {
  it(
    "extraction over sound JSX constructs never makes a false claim and always covers observed renders",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbComponentProgram,
          async (program: ComponentProgram) => {
            const result = await runComponentDifferential(program);
            if (
              result.mismatches.length > 0 ||
              result.harnessFailures.length > 0
            ) {
              throw new Error(formatFailure(result));
            }
          },
        ),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );

  it(
    "extraction is deterministic — the same component yields the same summary",
    { timeout: 60_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbComponentProgram,
          async (program: ComponentProgram) => {
            const first = await runComponentDifferential(program);
            const second = await runComponentDifferential(program);
            expect(second.summary).toEqual(first.summary);
          },
        ),
        { numRuns: 5, seed: SEED },
      );
    },
  );
});

describe("component differential — promoted constructs stay sound", () => {
  // This was the render-boundary documented-gap rediscovery milestone
  // (an inverted property) before the CFG path engine closed the
  // nested-guard gap. The same generator now runs as a regular sound
  // property, forcing a nested null-guard into every component.
  it(
    "components forced to contain a nested null-guard extract soundly",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbComponentProgramWithNestedGuard,
          async (program: ComponentProgram) => {
            const result = await runComponentDifferential(program);
            if (
              result.mismatches.length > 0 ||
              result.harnessFailures.length > 0
            ) {
              throw new Error(formatFailure(result));
            }
          },
        ),
        { numRuns: 100, seed: SEED },
      );
    },
  );
});
