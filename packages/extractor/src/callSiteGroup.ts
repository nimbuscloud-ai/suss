/**
 * The `groupId` an effect has, which says which call site in its unit
 * produced it.
 *
 * The id says what the effect is and never where its call is written:
 * the callee, then a hash of everything else the effect records, such as
 * its class and the shape of what the call passed. Code that moves or is
 * reformatted keeps its ids, so `inspect --diff` and `check --base` do
 * not report it as changed. Two call sites in one unit with the same
 * effect get the same key, so the ones after the first, in source order,
 * take `#2`, `#3` and so on. The lines stay in the effect's `location`,
 * which the key leaves out.
 */

import { createHash } from "node:crypto";

import { effectKey, normalizeCalleeText } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";

/** The key for an effect, which has no `groupId` yet. */
export function callSiteKey(effect: Effect): string {
  const callee = calleeOf(effect);
  // A chain broken across lines is the same call as one written on one line.
  const written =
    callee === undefined
      ? effect
      : { ...effect, callee: normalizeCalleeText(callee) };
  const hash = createHash("sha1")
    .update(effectKey(written as Effect))
    .digest("hex")
    .slice(0, 7);
  return callee === undefined ? hash : `${normalizeCalleeText(callee)}:${hash}`;
}

function calleeOf(effect: Effect): string | undefined {
  return effect.type === "interaction" || effect.type === "invocation"
    ? effect.callee
    : undefined;
}

/**
 * The effects of one unit's call sites, given in source order with one
 * list per site, with each `groupId` a later site repeats numbered. An
 * entry keeps whatever else an adapter records beside its effect.
 */
export function numberRepeatedCallSites<T extends { effect: Effect }>(
  sites: readonly (readonly T[])[],
): T[][] {
  const taken = new Map<string, number>();
  return sites.map((entries) => {
    const ids = new Map<string, string>();
    for (const key of new Set(
      entries.flatMap((entry) => groupIdOf(entry.effect)),
    )) {
      const count = (taken.get(key) ?? 0) + 1;
      taken.set(key, count);
      ids.set(key, count === 1 ? key : `${key}#${count}`);
    }
    return entries.map((entry) => ({
      ...entry,
      effect: withGroupId(entry.effect, ids),
    }));
  });
}

function groupIdOf(effect: Effect): string[] {
  return effect.type === "interaction" && effect.groupId !== undefined
    ? [effect.groupId]
    : [];
}

function withGroupId(effect: Effect, ids: ReadonlyMap<string, string>): Effect {
  if (effect.type !== "interaction" || effect.groupId === undefined) {
    return effect;
  }
  return { ...effect, groupId: ids.get(effect.groupId) ?? effect.groupId };
}
