/**
 * What a client's request takes from the unit's own parameters, put
 * together the same way for every adapter.
 *
 * The request hook says which values the call states its method and host
 * as, and the adapter says where each value came from, through its own
 * source walk, and which conditions gate the request. This keeps a list
 * only when it reaches one of the unit's inputs, so a request whose
 * method is written out, which is nearly every request, records nothing.
 * A host read out of a URL is the `host` of that URL, which the
 * reference says with a derivation.
 */

import { inputReadsOf } from "./inputReads.js";
import { comesFromInput } from "./valueSources.js";

import type { ValueRef } from "@suss/behavioral-ir";
import type { StatedRequest } from "./framework.js";
import type { RawBindingFrom, RawCondition } from "./index.js";
import type { ValueOps } from "./ops.js";

/** Where each value came from, asked of the adapter's source walk at once. */
export type SourcesOfValues = (
  values: readonly ValueOps[],
) => ReadonlyMap<ValueOps, readonly ValueRef[]>;

/**
 * The `bindingFrom` for a request, or undefined when it takes nothing
 * from the unit's inputs. `when` is the conditions every path to the
 * request's call passes.
 */
export function requestBindingFrom(
  stated: StatedRequest | undefined,
  when: readonly RawCondition[],
  sourcesOf: SourcesOfValues,
): RawBindingFrom | undefined {
  const asked = [stated?.method, stated?.host?.value].filter(
    (value): value is ValueOps => value !== undefined,
  );
  const found = asked.length === 0 ? new Map() : sourcesOf(asked);
  const refsOf = (value: ValueOps | undefined): readonly ValueRef[] =>
    value === undefined ? [] : (found.get(value) ?? []);
  const method = refsOf(stated?.method);
  const host =
    stated?.host === undefined
      ? []
      : hostRefs(refsOf(stated.host.value), stated.host.within);
  const bindingFrom: RawBindingFrom = {
    ...(comesFromInput(method) ? { method: [...method] } : {}),
    ...(comesFromInput(host) ? { host } : {}),
    ...(readsAnInput(when) ? { when: [...when] } : {}),
  };
  return Object.keys(bindingFrom).length === 0 ? undefined : bindingFrom;
}

function hostRefs(
  refs: readonly ValueRef[],
  within: "url" | "host",
): ValueRef[] {
  if (within === "host") {
    return [...refs];
  }
  return refs.map((from) => ({
    type: "derived",
    from,
    derivation: { type: "propertyAccess", property: "host" },
  }));
}

function readsAnInput(conditions: readonly RawCondition[]): boolean {
  const predicates = conditions.flatMap((one) => one.structured ?? []);
  return inputReadsOf({ conditions: [predicates], values: [] }).length > 0;
}
