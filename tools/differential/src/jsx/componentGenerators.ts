// componentGenerators.ts: fast-check arbitraries over the component DSL.
//
// One sound tier for now: guards + JSX trees with inline logical /
// ternary conditionals are all constructs the React pack documents as
// modeled (decisions #33: #45). Constructs the pack documents as
// staying opaque (`||` rendering, `.map()`, custom components) are
// deliberately absent: they would only exercise abstention. Gap arms
// get added the way the HTTP side earned them: when a fuzz session
// or a documented deferral produces a reproducible mismatch shape.

import fc from "fast-check";

import type {
  ComponentGuard,
  ComponentProgram,
  JsxElement,
  JsxNode,
  PropCond,
} from "./componentProgram.js";

const PROPS = ["user", "count", "label", "show", "kind"];
const VALUES = ["", "a", "0", "42"];
const TAGS = ["div", "span", "p", "em", "strong", "h1"];
const TEXTS = ["hello", "empty", "badge", "x"];

const arbProp = fc.constantFrom(...PROPS);

const arbLeafCond: fc.Arbitrary<PropCond> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .record({ prop: arbProp, negated: fc.boolean() })
      .map(
        ({ prop, negated }): PropCond => ({ type: "truthy", prop, negated }),
      ),
  },
  {
    weight: 3,
    arbitrary: fc
      .record({
        prop: arbProp,
        value: fc.constantFrom(...VALUES),
        negated: fc.boolean(),
      })
      .map(
        ({ prop, value, negated }): PropCond => ({
          type: "eq",
          prop,
          value,
          negated,
        }),
      ),
  },
);

const arbCond: fc.Arbitrary<PropCond> = fc.oneof(
  { weight: 4, arbitrary: arbLeafCond },
  {
    weight: 1,
    arbitrary: fc
      .record({ left: arbLeafCond, right: arbLeafCond })
      .map(({ left, right }): PropCond => ({ type: "and", left, right })),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ left: arbLeafCond, right: arbLeafCond })
      .map(({ left, right }): PropCond => ({ type: "or", left, right })),
  },
);

const arbLeafElement: fc.Arbitrary<JsxElement> = fc
  .record({
    tag: fc.constantFrom(...TAGS),
    child: fc.oneof(
      fc.constant<JsxNode | null>(null),
      fc
        .constantFrom(...TEXTS)
        .map((value): JsxNode => ({ type: "text", value })),
      arbProp.map((prop): JsxNode => ({ type: "propText", prop })),
    ),
  })
  .map(
    ({ tag, child }): JsxElement => ({
      type: "element",
      tag,
      children: child === null ? [] : [child],
    }),
  );

const arbChildNode: fc.Arbitrary<JsxNode> = fc.oneof(
  { weight: 3, arbitrary: arbLeafElement },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom(...TEXTS)
      .map((value): JsxNode => ({ type: "text", value })),
  },
  {
    weight: 2,
    arbitrary: arbProp.map((prop): JsxNode => ({ type: "propText", prop })),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ cond: arbCond, child: arbLeafElement })
      .map(({ cond, child }): JsxNode => ({ type: "logical", cond, child })),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({
        cond: arbCond,
        whenTrue: arbLeafElement,
        whenFalse: fc.oneof(
          fc.constant<JsxElement | null>(null),
          arbLeafElement,
        ),
      })
      .map(
        ({ cond, whenTrue, whenFalse }): JsxNode => ({
          type: "ternary",
          cond,
          whenTrue,
          whenFalse,
        }),
      ),
  },
);

const arbRoot: fc.Arbitrary<JsxElement> = fc
  .record({
    tag: fc.constantFrom(...TAGS),
    children: fc.array(arbChildNode, { minLength: 0, maxLength: 3 }),
  })
  .map(({ tag, children }): JsxElement => ({ type: "element", tag, children }));

const arbGuard: fc.Arbitrary<ComponentGuard> = fc.oneof(
  {
    weight: 2,
    arbitrary: arbCond.map(
      (cond): ComponentGuard => ({ type: "guardNull", cond }),
    ),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ cond: arbCond, node: arbLeafElement })
      .map(
        ({ cond, node }): ComponentGuard => ({ type: "guardJsx", cond, node }),
      ),
  },
);

export const arbComponentProgram: fc.Arbitrary<ComponentProgram> = fc
  .record({
    guards: fc.array(arbGuard, { maxLength: 2 }),
    root: arbRoot,
  })
  .map(({ guards, root }) => ({
    // Declare the full prop pool: unobserved props exercise the input
    // mapping without expanding the battery (they're pinned to one value).
    props: PROPS,
    guards,
    root,
  }));

/**
 * At least one nested null-guard in every component. This was the
 * render-boundary gap tier until the CFG path engine closed the
 * nested-guard gap; it now runs as a regular sound property so the
 * promoted construct stays sound.
 */
export const arbComponentProgramWithNestedGuard: fc.Arbitrary<ComponentProgram> =
  fc
    .record({
      before: fc.array(arbGuard, { maxLength: 1 }),
      outer: arbCond,
      inner: arbCond,
      root: arbRoot,
    })
    .map(({ before, outer, inner, root }) => ({
      props: PROPS,
      guards: [...before, { type: "nestedGuardNull" as const, outer, inner }],
      root,
    }));
