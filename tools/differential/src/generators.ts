// generators.ts — fast-check arbitraries over the handler-program DSL.
//
// Tiers mirror the extraction algorithm's soundness boundary. The
// sound tier's differential property must hold. Nested guards and
// loop guards were gap-tier constructs (documented soundness gaps,
// rediscovered mechanically by inverted milestone properties) until
// the CFG path engine closed both — they are now part of the sound
// tier, and the former milestones assert the constructs stay sound.

import fc from "fast-check";

import type {
  Cond,
  FieldSource,
  FinalStmt,
  GuardStmt,
  HandlerProgram,
  ReqField,
  SwitchClause,
  SwitchDefaultClause,
  Terminal,
} from "./program.js";

export interface FuzzTier {
  /** Allow guards nested one block deep (sound since the CFG path engine). */
  nested: boolean;
  /** Allow guards inside for-of loops (sound since the CFG path engine). */
  loops: boolean;
  /** Allow switch guards, including the block-wrapped clause shape lowering unwraps (sound since that unwrap landed). */
  switches: boolean;
}

export const SOUND_TIER: FuzzTier = {
  nested: true,
  loops: true,
  switches: true,
};

const KEYS_BY_SOURCE: Record<FieldSource, string[]> = {
  params: ["id", "slug"],
  query: ["q", "page", "filter"],
  headers: ["authorization", "accept"],
  body: ["name", "role", "count"],
};

const VALUES = ["", "a", "admin", "42"];
const STATUSES = [201, 400, 401, 403, 404, 409, 500];
const BODY_KEYS = ["ok", "error", "data"];
const BODY_VALUES = ["yes", "no", "x"];

function arbFieldFrom(source: FieldSource): fc.Arbitrary<ReqField> {
  return fc
    .constantFrom(...KEYS_BY_SOURCE[source])
    .map((key) => ({ source, key }));
}

const arbField: fc.Arbitrary<ReqField> = fc
  .constantFrom<FieldSource>("params", "query", "headers", "body")
  .chain(arbFieldFrom);

const arbLeafCond: fc.Arbitrary<Cond> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .record({ field: arbField, negated: fc.boolean() })
      .map(({ field, negated }): Cond => ({ type: "truthy", field, negated })),
  },
  {
    weight: 3,
    arbitrary: fc
      .record({
        field: arbField,
        value: fc.constantFrom(...VALUES),
        negated: fc.boolean(),
      })
      .map(
        ({ field, value, negated }): Cond => ({
          type: "eq",
          field,
          value,
          negated,
        }),
      ),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ field: arbField, negated: fc.boolean() })
      .map(({ field, negated }): Cond => ({ type: "has", field, negated })),
  },
);

/** Leaf conditions plus one level of && / || composition. */
const arbCond: fc.Arbitrary<Cond> = fc.oneof(
  { weight: 4, arbitrary: arbLeafCond },
  {
    weight: 1,
    arbitrary: fc
      .record({ left: arbLeafCond, right: arbLeafCond })
      .map(({ left, right }): Cond => ({ type: "and", left, right })),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ left: arbLeafCond, right: arbLeafCond })
      .map(({ left, right }): Cond => ({ type: "or", left, right })),
  },
);

const arbTerminal: fc.Arbitrary<Terminal> = fc.record({
  status: fc.oneof(
    { weight: 1, arbitrary: fc.constant<number | null>(null) },
    { weight: 3, arbitrary: fc.constantFrom<number | null>(...STATUSES) },
  ),
  key: fc.constantFrom(...BODY_KEYS),
  value: fc.constantFrom(...BODY_VALUES),
});

const arbGuard: fc.Arbitrary<GuardStmt> = fc
  .record({ cond: arbCond, terminal: arbTerminal })
  .map(({ cond, terminal }): GuardStmt => ({ type: "guard", cond, terminal }));

export const arbNestedGuard: fc.Arbitrary<GuardStmt> = fc.oneof(
  fc.record({ outer: arbCond, inner: arbCond, terminal: arbTerminal }).map(
    ({ outer, inner, terminal }): GuardStmt => ({
      type: "nestedGuard",
      outer,
      inner,
      terminal,
    }),
  ),
  fc
    .record({
      outer: arbCond,
      inner: arbCond,
      whenInner: arbTerminal,
      tail: arbTerminal,
    })
    .map(
      ({ outer, inner, whenInner, tail }): GuardStmt => ({
        type: "blockGuard",
        outer,
        inner,
        whenInner,
        tail,
      }),
    ),
);

export const arbLoopGuard: fc.Arbitrary<GuardStmt> = fc
  .record({
    source: fc.constantFrom<FieldSource>("query", "headers"),
    terminal: arbTerminal,
  })
  .chain(({ source, terminal }) =>
    fc
      .uniqueArray(fc.constantFrom(...KEYS_BY_SOURCE[source]), {
        minLength: 1,
        maxLength: 2,
      })
      .map(
        (keys): GuardStmt => ({ type: "loopGuard", source, keys, terminal }),
      ),
  );

/** Distinct case-label literals, positionally assigned to a program's clauses. */
const SWITCH_CASE_VALUES = ["alpha", "beta", "gamma", "delta"];

interface SwitchClauseSpec {
  type: "break" | "blockBreak" | "return" | "fallthrough";
  terminal: Terminal;
}

const arbSwitchClauseSpec: fc.Arbitrary<SwitchClauseSpec> = fc.record({
  type: fc.constantFrom<SwitchClauseSpec["type"]>(
    "break",
    "blockBreak",
    "return",
    "fallthrough",
  ),
  terminal: arbTerminal,
});

const toSwitchClause = (spec: SwitchClauseSpec, value: string): SwitchClause =>
  spec.type === "fallthrough"
    ? { value, type: "fallthrough" }
    : { value, type: spec.type, terminal: spec.terminal };

/** The default clause never falls through. A switch with no default would leave an unmatched value with no response at all. */
const arbSwitchDefaultSpec: fc.Arbitrary<SwitchDefaultClause> = fc.record({
  type: fc.constantFrom<SwitchDefaultClause["type"]>(
    "break",
    "blockBreak",
    "return",
  ),
  terminal: arbTerminal,
});

export const arbSwitchGuard: fc.Arbitrary<GuardStmt> = fc
  .record({
    field: arbField,
    specs: fc.array(arbSwitchClauseSpec, { minLength: 2, maxLength: 4 }),
    defaultClause: arbSwitchDefaultSpec,
  })
  .map(({ field, specs, defaultClause }): GuardStmt => {
    // A trailing fallthrough clause has nothing to stack into, so give
    // the last clause a body instead. Every generated fallthrough
    // clause then always stacks into a non-empty one, and is worth having.
    const lastIndex = specs.length - 1;
    const fixed = specs.map((spec, i) =>
      i === lastIndex && spec.type === "fallthrough"
        ? ({ type: "break", terminal: spec.terminal } as SwitchClauseSpec)
        : spec,
    );
    const clauses = fixed.map((spec, i) =>
      toSwitchClause(spec, SWITCH_CASE_VALUES[i % SWITCH_CASE_VALUES.length]),
    );
    return { type: "switchGuard", field, clauses, defaultClause };
  });

function arbGuardStmt(tier: FuzzTier): fc.Arbitrary<GuardStmt> {
  const arms: fc.WeightedArbitrary<GuardStmt>[] = [
    { weight: 4, arbitrary: arbGuard },
  ];
  if (tier.nested) {
    arms.push({ weight: 3, arbitrary: arbNestedGuard });
  }
  if (tier.loops) {
    arms.push({ weight: 3, arbitrary: arbLoopGuard });
  }
  if (tier.switches) {
    arms.push({ weight: 3, arbitrary: arbSwitchGuard });
  }
  return fc.oneof(...arms);
}

const arbFinal: fc.Arbitrary<FinalStmt> = fc.oneof(
  {
    weight: 2,
    arbitrary: arbTerminal.map(
      (terminal): FinalStmt => ({ type: "respond", terminal }),
    ),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ cond: arbCond, whenTrue: arbTerminal, whenFalse: arbTerminal })
      .map(
        ({ cond, whenTrue, whenFalse }): FinalStmt => ({
          type: "ifElse",
          cond,
          whenTrue,
          whenFalse,
        }),
      ),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ cond: arbCond, whenTrue: arbTerminal, whenFalse: arbTerminal })
      .map(
        ({ cond, whenTrue, whenFalse }): FinalStmt => ({
          type: "ternary",
          cond,
          whenTrue,
          whenFalse,
        }),
      ),
  },
);

/** A full handler program in the given tier. */
export function arbHandlerProgram(
  tier: FuzzTier,
): fc.Arbitrary<HandlerProgram> {
  return fc.record({
    guards: fc.array(arbGuardStmt(tier), { maxLength: 3 }),
    final: arbFinal,
  });
}

/**
 * A program guaranteed to contain at least one gap-tier construct —
 * used by the rediscovery milestones so they don't depend on oneof
 * probabilities to hit the interesting arm.
 */
export function arbProgramWithGapConstruct(
  gapArm: fc.Arbitrary<GuardStmt>,
): fc.Arbitrary<HandlerProgram> {
  return fc
    .record({
      before: fc.array(arbGuard, { maxLength: 1 }),
      gap: gapArm,
      after: fc.array(arbGuard, { maxLength: 1 }),
      final: arbFinal,
    })
    .map(({ before, gap, after, final }) => ({
      guards: [...before, gap, ...after],
      final,
    }));
}
