// shape.test.ts: the shape fuzzer's properties.
//
// Same protocol as the handler differential: a sound tier that must
// hold, and one inverted property per documented gap, so a gap can
// neither grow (the sound tier catches spillover) nor quietly close
// (the rediscovery property fails, and whoever closed it promotes the
// dimension value into the sound tier).
//
// Knobs: SUSS_FUZZ_RUNS (default 150), SUSS_FUZZ_SEED.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { nestjsRestFramework } from "@suss/framework-nestjs-rest";
import { reactFramework } from "@suss/framework-react";

import {
  ANNOUNCEMENTS,
  type AnnounceShapeSpec,
  SIMPLEST_ANNOUNCEMENT,
} from "./announceShape.js";
import {
  type ComponentShapeSpec,
  repairComponentShape,
} from "./componentShape.js";
import {
  ANNOUNCEMENT_BUGS,
  COMPONENT_BUGS,
  REACH_BUGS,
  SOUND_REACH_PATHS,
} from "./knownBugs.js";
import { findingSignature, signaturesOf } from "./minimize.js";
import {
  formatShapeFailure,
  runAnnounceShapeDifferential,
  runComponentShapeDifferential,
  runShapeDifferential,
  shapeFailed,
} from "./shapeDifferential.js";
import {
  arbComponentShapeSpec,
  arbShapeSpec,
  BINDING_FORMS,
} from "./shapeGenerators.js";
import {
  type ReachPath,
  type ShapeSpec,
  SIMPLEST_SHAPE,
} from "./shapeProgram.js";
import { ALL_SHAPE_TARGETS } from "./shapeTargets.js";

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const NUM_RUNS = envInt("SUSS_FUZZ_RUNS", 150);
const SEED = envInt("SUSS_FUZZ_SEED", 20260801);

const REACT_PACK = reactFramework();

// ---------------------------------------------------------------------------
// Sound tier
// ---------------------------------------------------------------------------

/**
 * Registration reads the function literal handed to the call, so the
 * shapes it can express are the ones written at the call site. Every
 * other reach path is the documented gap below.
 */
const arbSoundHandlerShape: fc.Arbitrary<ShapeSpec> = arbShapeSpec.map(
  (spec) => ({
    ...spec,
    reach: SIMPLEST_SHAPE.reach,
    form: spec.form === "conciseArrow" ? "conciseArrow" : "blockArrow",
  }),
);

/** The component dimension values extraction handles today. */
const SOUND_COMPONENT_FORMS = new Set([
  "declaration",
  "functionExpression",
  "conciseArrow",
  "blockArrow",
  "asyncDeclaration",
  "overloaded",
  "method",
]);
const SOUND_COMPONENT_BINDINGS = new Set([
  "const",
  "letOnce",
  "letReassigned",
  "var",
  "destructured",
  "withDefault",
]);
const SOUND_COMPONENT_ROUTES = new Set([
  "namedDeclaration",
  "namedBinding",
  "namedAndDefault",
  "aliasedNamed",
]);

const arbSoundComponentShape: fc.Arbitrary<ComponentShapeSpec> =
  arbComponentShapeSpec.filter(
    (spec) =>
      SOUND_COMPONENT_FORMS.has(spec.form) &&
      SOUND_COMPONENT_BINDINGS.has(spec.binding) &&
      SOUND_COMPONENT_ROUTES.has(spec.route),
  );

for (const shapeTarget of ALL_SHAPE_TARGETS) {
  describe(`shape fuzzer, sound tier (${shapeTarget.target.name})`, () => {
    it(
      "however the handler at a registration call is written, the summary says the same thing",
      { timeout: 300_000 },
      async () => {
        await fc.assert(
          fc.asyncProperty(arbSoundHandlerShape, async (spec: ShapeSpec) => {
            const result = await runShapeDifferential(spec, shapeTarget);
            if (shapeFailed(result)) {
              throw new Error(formatShapeFailure(result));
            }
          }),
          { numRuns: NUM_RUNS, seed: SEED },
        );
      },
    );
  });
}

describe("shape fuzzer, sound tier (react)", () => {
  it(
    "however a component is written, bound, and exported, the summary says the same thing",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbSoundComponentShape,
          async (spec: ComponentShapeSpec) => {
            const result = await runComponentShapeDifferential(
              spec,
              REACT_PACK,
            );
            if (shapeFailed(result)) {
              throw new Error(formatShapeFailure(result));
            }
          },
        ),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );

  it(
    "extraction is deterministic, the same shape yields the same summaries",
    { timeout: 60_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arbSoundComponentShape,
          async (spec: ComponentShapeSpec) => {
            const first = await runComponentShapeDifferential(spec, REACT_PACK);
            const second = await runComponentShapeDifferential(
              spec,
              REACT_PACK,
            );
            expect(second.summaries).toEqual(first.summaries);
          },
        ),
        { numRuns: 5, seed: SEED },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Bugs that are in the tree today. Each test below asserts the WRONG
// behaviour, so that fixing the bug breaks the test and whoever fixed
// it promotes the dimension value into the sound tier above.
// ---------------------------------------------------------------------------

const PLAIN_COMPONENT_BODY = {
  props: [],
  guards: [],
  root: { type: "element" as const, tag: "div", children: [] },
};

describe("shape fuzzer, bugs that are still in the tree", () => {
  for (const gap of COMPONENT_BUGS) {
    it(
      `still broken, ${gap.dimension}=${gap.value}: ${gap.wrong}`,
      { timeout: 60_000 },
      async () => {
        const spec = repairComponentShape({
          form: "declaration",
          binding: "const",
          route: "namedBinding",
          body: PLAIN_COMPONENT_BODY,
          [gap.dimension]: gap.value,
        } as ComponentShapeSpec);
        const result = await runComponentShapeDifferential(spec, REACT_PACK);
        // Asserting the broken behaviour on purpose: this test fails
        // the moment the bug is fixed, which is when the dimension
        // value belongs in the sound tier instead.
        expect(
          [...signaturesOf(result)],
          `${gap.wrong}: the fuzzer no longer finds this, so it looks fixed. Move ${gap.dimension}=${gap.value} into the sound tier above and delete this entry.\n${formatShapeFailure(result)}`,
        ).toContain(gap.signature);
      },
    );
  }
});

// ---------------------------------------------------------------------------
// The registration gap, which the reach dimension is entirely inside
// ---------------------------------------------------------------------------

const RESPOND_BODY = {
  guards: [],
  final: {
    type: "respond" as const,
    terminal: { status: 200, key: "ok", value: "yes" },
  },
};

describe("shape fuzzer, sound tier (a handler reached by name)", () => {
  for (const reach of SOUND_REACH_PATHS) {
    it(
      `a handler reached ${reach} summarizes the same way as one written at the call`,
      { timeout: 120_000 },
      async () => {
        const result = await runShapeDifferential(
          { ...SIMPLEST_SHAPE, reach, form: "blockArrow", body: RESPOND_BODY },
          ALL_SHAPE_TARGETS[0],
        );
        if (shapeFailed(result)) {
          throw new Error(formatShapeFailure(result));
        }
      },
    );
  }
});

describe("shape fuzzer, reach paths still in the tree", () => {
  for (const bug of REACH_BUGS) {
    it(
      `still broken, reach=${bug.value}: ${bug.wrong}`,
      { timeout: 120_000 },
      async () => {
        const result = await runShapeDifferential(
          {
            ...SIMPLEST_SHAPE,
            reach: bug.value as ReachPath,
            form: "blockArrow",
            body: RESPOND_BODY,
          },
          ALL_SHAPE_TARGETS[0],
        );
        expect(
          result.findings.map(findingSignature),
          `${bug.wrong}: the fuzzer no longer finds this, so it looks fixed. Move reach=${bug.value} into SOUND_REACH_PATHS and take it out of knownBugs.ts.\n${formatShapeFailure(result)}`,
        ).toContain(bug.signature);
      },
    );
  }
});

describe("shape fuzzer, a response typed by a library type", () => {
  it(
    "a wide type is walked across its whole breadth, into a summary nobody can read",
    { timeout: 120_000 },
    async () => {
      const result = await runShapeDifferential(
        {
          ...SIMPLEST_SHAPE,
          result: "wideNamedType",
          body: {
            guards: [],
            final: {
              type: "respond",
              terminal: { status: 200, key: "ok", value: "yes" },
            },
          },
        },
        ALL_SHAPE_TARGETS[0],
      );
      expect(
        result.findings.map(findingSignature),
        `the type walk may now bound its breadth. If it does, drop this and let the sound tier carry the dimension.\n${formatShapeFailure(result)}`,
      ).toContain("invariant:noRunawaySummary");
    },
  );
});

// ---------------------------------------------------------------------------
// How a boundary announces itself, where a class carries the decorator
// ---------------------------------------------------------------------------

const NEST_PACK = nestjsRestFramework();

describe("shape fuzzer, sound tier (nestjs-rest)", () => {
  for (const method of ["method", "asyncMethod"] as const) {
    it(
      `a controller whose handler is written as ${method === "method" ? "a method" : "an async method"} summarizes the same way`,
      { timeout: 60_000 },
      async () => {
        const result = await runAnnounceShapeDifferential(
          { ...SIMPLEST_ANNOUNCEMENT, method, bodyKey: "ok" },
          NEST_PACK,
        );
        if (shapeFailed(result)) {
          throw new Error(formatShapeFailure(result));
        }
      },
    );
  }

  // Every way of announcing a controller, including the four a project
  // reaches for when it wants its own decorator. Each has to agree with
  // the plainest spelling on the route path as well as on the boundary,
  // since a controller mounted at the root pairs with the wrong thing.
  for (const announcement of ANNOUNCEMENTS) {
    it(
      `a controller announced by ${announcement} summarizes the same way`,
      { timeout: 60_000 },
      async () => {
        const result = await runAnnounceShapeDifferential(
          { ...SIMPLEST_ANNOUNCEMENT, announcement, bodyKey: "ok" },
          NEST_PACK,
        );
        if (shapeFailed(result)) {
          throw new Error(formatShapeFailure(result));
        }
      },
    );
  }
});

describe("shape fuzzer, decorator bugs that are still in the tree", () => {
  for (const bug of ANNOUNCEMENT_BUGS) {
    it(
      `still broken, ${bug.dimension}=${bug.value}: ${bug.wrong}`,
      { timeout: 60_000 },
      async () => {
        const spec: AnnounceShapeSpec = {
          ...SIMPLEST_ANNOUNCEMENT,
          bodyKey: "ok",
          [bug.dimension]: bug.value,
        };
        const result = await runAnnounceShapeDifferential(spec, NEST_PACK);
        // Asserting the broken behaviour on purpose, so that fixing it
        // breaks this test and the value moves into the sound tier.
        expect(
          [...signaturesOf(result)],
          `${bug.wrong}: the fuzzer no longer finds this, so it looks fixed. Move ${bug.dimension}=${bug.value} into the sound tier above and take it out of knownBugs.ts.\n${formatShapeFailure(result)}`,
        ).toContain(bug.signature);
      },
    );
  }
});

// ---------------------------------------------------------------------------
// The generator reaches its own dimensions
// ---------------------------------------------------------------------------

describe("shape fuzzer, the generator covers the space it declares", () => {
  it("every binding form appears in a sample of shapes", () => {
    const sample = fc.sample(arbComponentShapeSpec, {
      numRuns: 200,
      seed: SEED,
    });
    const seen = new Set(sample.map((spec) => spec.binding));
    for (const binding of BINDING_FORMS) {
      expect([...seen]).toContain(binding);
    }
  });
});
