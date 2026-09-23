/**
 * When two effects are the same effect, and how repeats are folded.
 *
 * A transition lists each effect once, so a schema validator called
 * thirteen times on one path is one effect with `count: 13`. The count
 * is the only place that multiplicity is kept, and a reader that needs
 * it reads the field rather than counting entries.
 *
 * Two fields stay out of the key. `groupId` says which call site produced
 * an effect rather than what the effect is, and `count` is the result of
 * the fold. Only the top level is filtered, because an argument object is
 * free to have a field of its own called `count`.
 */

import type { Effect } from "./index.js";

const NOT_IN_KEY: ReadonlySet<string> = new Set(["groupId", "count"]);

/**
 * A callee's text with its whitespace normalized. A callee is the call
 * expression as it was written, so a chain broken across lines keeps
 * its newlines and indentation, and the same call written on one line
 * elsewhere is a different string. Code that matches an effect by its
 * callee text should normalize it here first.
 */
export function normalizeCalleeText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/ ?(\??\.) ?/g, "$1")
    .trim();
}

/** JSON with object keys in a fixed order, so two equal values agree. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
    .join(",")}}`;
}

/** Two effects with the same key are the same effect. */
export function effectKey(effect: Effect): string {
  const identifying = Object.fromEntries(
    Object.entries(effect).filter(([field]) => !NOT_IN_KEY.has(field)),
  );
  return stableJson(identifying);
}

/**
 * One entry per effect, in the order they first appeared, with `count`
 * set on any that turned up more than once.
 */
export function foldRepeatedEffects(effects: readonly Effect[]): Effect[] {
  const kept: Effect[] = [];
  const firstAt = new Map<string, number>();

  for (const effect of effects) {
    const key = effectKey(effect);
    const at = firstAt.get(key);
    if (at === undefined) {
      firstAt.set(key, kept.length);
      kept.push(effect);
      continue;
    }

    const first = kept[at] as Effect;
    kept[at] = { ...first, count: (first.count ?? 1) + 1 };
  }

  return kept;
}
