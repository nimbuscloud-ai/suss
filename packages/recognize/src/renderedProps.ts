/**
 * A pack that claims the functions a component hands its elements under
 * certain props, such as React's event handlers:
 *
 *   <button onClick={() => save(order)}>Save</button>
 *
 * React calls the function when the event fires, not while the component
 * renders, so the function becomes a unit of its own. The chain lists
 * the elements the parent renders, keeps the attributes whose name the
 * pattern matches, and claims a function written in place there, or a
 * function handed over by name that the parent's own body writes.
 */

import type { CodeUnitKind } from "@suss/behavioral-ir";
import type {
  Chain,
  ClaimInputs,
  ClaimMetadata,
  Link,
  MethodMeaning,
  SubUnitNamePart,
} from "./chain.js";

/** A chain over the attributes of the elements a parent renders, and the links that can still be added. */
export interface RenderedProps {
  /** What a function written in place under a matching attribute becomes. */
  unitWhenInPlace(spec: ClaimSpec): RenderedProps;
  /** What a function handed over by name under a matching attribute becomes, when the parent writes it. */
  unitWhenNamedInParent(spec: ClaimSpec): RenderedProps;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): RenderedProps;
  /** The links and the ending, as data. */
  readonly declared: Chain<MethodMeaning>;
}

/** What a claim becomes: its kind, the parts of its name, its inputs and its metadata. */
export interface ClaimSpec {
  readonly kind: CodeUnitKind;
  readonly name: readonly SubUnitNamePart[];
  readonly inputs?: ClaimInputs;
  readonly metadata?: ClaimMetadata;
}

/** A chain over every element a parent renders, keeping the attributes whose name `matching` matches. */
export function renderedProps(spec: { matching: string }): RenderedProps {
  return chainFrom({
    links: [{ asks: "renderedProps", matching: spec.matching }],
    ending: { yields: "claims" },
    example: null,
  });
}

/** The same chain with one more link, or with its example set. */
function chainFrom(declared: Chain<MethodMeaning>): RenderedProps {
  const adding = (link: Link<MethodMeaning>): RenderedProps =>
    chainFrom({ ...declared, links: [...declared.links, link] });
  return {
    declared,
    unitWhenInPlace: (spec) => adding({ asks: "unitWhenInPlace", ...spec }),
    unitWhenNamedInParent: (spec) =>
      adding({ asks: "unitWhenNamedInParent", ...spec }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
