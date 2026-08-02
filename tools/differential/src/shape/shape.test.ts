// shape.test.ts — the shape fuzzer's properties.
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

import { reactFramework } from "@suss/framework-react";

import {
  type ComponentShapeSpec,
  repairComponentShape,
} from "./componentShape.js";
import { findingSignature, signaturesOf } from "./minimize.js";
import {
  formatShapeFailure,
  runComponentShapeDifferential,
  runShapeDifferential,
  shapeFailed,
} from "./shapeDifferential.js";
import {
  arbComponentShapeSpec,
  arbShapeSpec,
  BINDING_FORMS,
} from "./shapeGenerators.js";
import { type ShapeSpec, SIMPLEST_SHAPE } from "./shapeProgram.js";
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
  "method",
]);
const SOUND_COMPONENT_BINDINGS = new Set(["const", "letOnce", "var"]);
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
  describe(`shape fuzzer — sound tier (${shapeTarget.target.name})`, () => {
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

describe("shape fuzzer — sound tier (react)", () => {
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
    "extraction is deterministic — the same shape yields the same summaries",
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
// Gap tier — each of these must keep reproducing until it is fixed
// ---------------------------------------------------------------------------

/**
 * A documented gap: one dimension value, the finding it produces today,
 * and a sentence a reader can act on. When the fix lands, the property
 * below fails and says to move the value into the sound tier.
 */
interface DocumentedGap {
  dimension: "form" | "binding" | "route";
  value: string;
  signature: string;
  says: string;
}

const COMPONENT_GAPS: DocumentedGap[] = [
  {
    dimension: "form",
    value: "overloaded",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    says: "a component with overload signatures is not discovered at all",
  },
  {
    dimension: "binding",
    value: "letReassigned",
    signature: "equivalence:summaries[0].transitions",
    says: "a reassigned binding is summarized from its first assignment",
  },
  {
    dimension: "binding",
    value: "destructured",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    says: "a component bound by destructuring is not discovered",
  },
  {
    dimension: "binding",
    value: "withDefault",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    says: "a component bound with a default is not discovered",
  },
  {
    dimension: "route",
    value: "defaultOfName",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    says: "`export default Panel`, where Panel is a binding, is not discovered",
  },
  {
    dimension: "route",
    value: "defaultDeclaration",
    signature: "invariant:aNamedUnitKeepsItsName",
    says: "a named function exported as the default is reported as `default`",
  },
  {
    dimension: "route",
    value: "throughProperty",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    says: "`export default views.Panel` is not discovered",
  },
  {
    dimension: "route",
    value: "throughFactoryArg",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    says: "a component handed to a factory in an object argument is not discovered",
  },
  {
    dimension: "route",
    value: "barrel",
    signature: "invariant:noTwoSummariesShareAnIdentity",
    says: "a barrel re-export produces a second summary on the same identity",
  },
];

const PLAIN_COMPONENT_BODY = {
  props: [],
  guards: [],
  root: { type: "element" as const, tag: "div", children: [] },
};

describe("shape fuzzer — documented gaps still reproduce", () => {
  for (const gap of COMPONENT_GAPS) {
    it(
      `${gap.dimension}=${gap.value}: ${gap.says}`,
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
        expect(
          [...signaturesOf(result)],
          `the gap may have been fixed. If it was, move ${gap.dimension}=${gap.value} into the sound tier and delete this entry.\n${formatShapeFailure(result)}`,
        ).toContain(gap.signature);
      },
    );
  }
});

// ---------------------------------------------------------------------------
// The registration gap, which the reach dimension is entirely inside
// ---------------------------------------------------------------------------

describe("shape fuzzer — a registered handler reached by name", () => {
  it(
    "a handler that is not written at the registration call loses its boundary",
    { timeout: 120_000 },
    async () => {
      const body = {
        guards: [],
        final: {
          type: "respond" as const,
          terminal: { status: 200, key: "ok", value: "yes" },
        },
      };
      for (const reach of [
        "throughName",
        "throughProperty",
        "throughImport",
      ] as const) {
        const result = await runShapeDifferential(
          { ...SIMPLEST_SHAPE, reach, form: "blockArrow", body },
          ALL_SHAPE_TARGETS[0],
        );
        expect(
          result.findings.map(findingSignature),
          `reach=${reach} may have been fixed. If it was, fold the reach dimension into the sound tier.\n${formatShapeFailure(result)}`,
        ).toContain("invariant:everyAnnouncedBoundaryIsSummarized");
      }
    },
  );
});

describe("shape fuzzer — a response typed by a library type", () => {
  it(
    "a wide type is walked across its whole breadth, into a summary nobody can read",
    { timeout: 120_000 },
    async () => {
      const result = await runShapeDifferential(
        {
          ...SIMPLEST_SHAPE,
          result: "wideLibraryType",
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
// The generator reaches its own dimensions
// ---------------------------------------------------------------------------

describe("shape fuzzer — the generator covers the space it declares", () => {
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
