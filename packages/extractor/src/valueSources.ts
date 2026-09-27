/**
 * Turns the places a value's walk ended into the value references a
 * transition records, the same way for every adapter.
 *
 * The walk itself is in `@suss/resolution`. What an input is depends on
 * the language and the framework, and so does reading a literal or
 * quoting the source, so the adapter says those three things. The order
 * they are tried in, and what a place that is none of them becomes, is
 * decided here.
 */

import type { ValueRef } from "@suss/behavioral-ir";

/** One place a walk ended, as much of it as this needs. */
export interface WalkEnd {
  /** The key of the member the walk ended at. */
  readonly key: string;
  /** The properties read off it on the way to the value, outermost first. */
  readonly path: readonly string[];
  /** A read at a key the source computes on the way, or null for none. */
  readonly computedAt: string | null;
  readonly end: { readonly is: string };
}

/** What only the adapter can say about a place a walk ended. */
export interface SourceSpelling<L extends WalkEnd> {
  /** The input the place is, or null when it is not one. */
  inputOf(leaf: L): ValueRef | null;
  /** The literal the written value at a key is, or undefined for anything else. */
  literalAt(key: string): string | number | boolean | null | undefined;
  /** The source written at a key, or null when the key is not a node. */
  textAt(key: string): string | null;
}

/** How much of the source a stopped walk quotes. */
const QUOTED_LENGTH = 80;

/** Every place a value's walk ended, as distinct value references. */
export function sourceRefsOf<L extends WalkEnd>(
  leaves: readonly L[],
  spelling: SourceSpelling<L>,
): ValueRef[] {
  const refs: ValueRef[] = [];
  const said = new Set<string>();
  for (const leaf of leaves) {
    const ref = refOf(leaf, spelling);
    const spelled = JSON.stringify(ref);
    if (!said.has(spelled)) {
      said.add(spelled);
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * An input, when the adapter says the place is one and no key on the way
 * was computed, since the path would then leave that key out. A literal,
 * when the place is written out and nothing was read off it. Otherwise
 * the walk stopped there, and the reference quotes what it stopped at.
 */
function refOf<L extends WalkEnd>(
  leaf: L,
  spelling: SourceSpelling<L>,
): ValueRef {
  const whole = leaf.computedAt === null;
  const input = whole ? spelling.inputOf(leaf) : null;
  if (input !== null) {
    return input;
  }
  if (whole && leaf.end.is === "written" && leaf.path.length === 0) {
    const literal = spelling.literalAt(leaf.key);
    if (literal !== undefined) {
      return { type: "literal", value: literal };
    }
  }
  const at = leaf.computedAt ?? leaf.key;
  return { type: "unresolved", sourceText: quoted(spelling.textAt(at), at) };
}

/**
 * The source on one line and cut short. A key that is not a node is a
 * name, keyed on its scope and the name after a `#`.
 */
function quoted(text: string | null, key: string): string {
  const written = (text ?? key.slice(key.lastIndexOf("#") + 1))
    .replace(/\s+/g, " ")
    .trim();
  return written.length <= QUOTED_LENGTH
    ? written
    : `${written.slice(0, QUOTED_LENGTH - 3)}...`;
}
