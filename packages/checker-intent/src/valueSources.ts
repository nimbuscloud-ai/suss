/**
 * Compares the `from` of a `results` line with where the code says each
 * column's value came from.
 *
 * A path off the unit's input is spelled the way `from` spells a source,
 * so the two compare as paths, and one matched effect that takes the
 * column from the given source satisfies the line. Otherwise a source
 * the checker can spell, an input path or a literal, is a
 * `valueFromElsewhere` finding. A walk that stopped at something it
 * could not follow proves nothing either way, so the claim goes under
 * `unchecked` as `unreadValue`, with where the walk stopped.
 */

import { boundarySourcePathOf, formatPath } from "@suss/behavioral-ir";

import { comparable } from "./receivedInput.js";

import type {
  BehavioralSummary,
  ProvenanceEntry,
  ValueRef,
} from "@suss/behavioral-ir";
import type {
  BoundaryIntentSummary,
  IntentEffect,
  IntentFinding,
  IntentOutcome,
  IntentValueSource,
} from "@suss/intent-ir";
import type { CodeEffect, UncheckedIntent } from "./index.js";

/** Which intent line, against which unit. */
export interface SourceClaim {
  intent: BoundaryIntentSummary;
  outcome: IntentOutcome;
  effect: IntentEffect;
  impl: BehavioralSummary;
  boundary: string;
  code: string;
}

export interface SourcesChecked {
  findings: IntentFinding[];
  unchecked: UncheckedIntent[];
}

/** One place the code says a value came from, and how `from` would spell it. */
interface CodeSource {
  ref: ValueRef;
  path: string[] | null;
  line: number | undefined;
}

/** Every column the line gives a source for, against the effects it matched. */
export function checkValueSources(
  claim: SourceClaim,
  matched: readonly CodeEffect[],
): SourcesChecked {
  const checked: SourcesChecked = { findings: [], unchecked: [] };
  for (const source of claim.effect.from ?? []) {
    const found: CodeSource[] = matched.flatMap((made) =>
      slotsFor(claim.effect, source.column, made).flatMap((slot) =>
        slot.from.map((ref) => ({
          ref,
          path: pathOf(claim, ref),
          line: made.line,
        })),
      ),
    );
    if (found.some((one) => samePath(one.path, source.path))) {
      continue;
    }
    const known = found.filter(
      (one) => one.path !== null || one.ref.type === "literal",
    );
    if (known.length > 0) {
      checked.findings.push(elsewhere(claim, source, known));
      continue;
    }
    checked.unchecked.push(unread(claim, source, found));
  }
  return checked;
}

/**
 * The slots of one effect that are that column. A column the line lists
 * under `by` is a selector, one under `fields` a written field, and a
 * column listed under both could be either.
 */
function slotsFor(
  effect: IntentEffect,
  column: string,
  made: CodeEffect,
): ProvenanceEntry[] {
  const kinds = new Set<ProvenanceEntry["at"]["slot"]>([
    ...(effect.by.includes(column) ? (["selector"] as const) : []),
    ...(effect.fields.includes(column) ? (["field"] as const) : []),
  ]);
  return (made.slots ?? []).filter(
    (slot) => slot.at.name === column && kinds.has(slot.at.slot),
  );
}

function pathOf(claim: SourceClaim, ref: ValueRef): string[] | null {
  const binding = claim.intent.boundary;
  return ref.type === "input"
    ? boundarySourcePathOf(claim.impl, binding, ref)
    : null;
}

function samePath(code: string[] | null, declared: readonly string[]): boolean {
  if (code === null || code.length !== declared.length) {
    return false;
  }
  const left = comparable(code);
  const right = comparable(declared);
  return left.every((segment, at) => segment === right[at]);
}

/** A source the code states, as the finding writes it. */
function spell(one: CodeSource): string {
  if (one.path !== null) {
    return `input.${formatPath(one.path)}`;
  }
  return one.ref.type === "literal"
    ? `the literal ${JSON.stringify(one.ref.value)}`
    : "somewhere it could not follow";
}

/** What the line says the outcome does, as a clause. */
function doing(claim: SourceClaim): string {
  const { effect, outcome } = claim;
  return `${outcome.id} ${effect.does} ${effect.names}`;
}

function elsewhere(
  claim: SourceClaim,
  source: IntentValueSource,
  known: readonly CodeSource[],
): IntentFinding {
  const said = [
    ...new Set(
      known.map((one) =>
        one.line === undefined
          ? spell(one)
          : `${spell(one)} (in the transition at line ${one.line})`,
      ),
    ),
  ];
  return {
    kind: "valueFromElsewhere",
    severity: "error",
    boundary: claim.boundary,
    intent: { name: claim.intent.name, outcomeId: claim.outcome.id },
    code: claim.code,
    message: `Intent "${claim.intent.name}" says ${doing(claim)} with ${source.column} taken from input.${formatPath(source.path)}; ${claim.impl.identity.name} takes it from ${said.join(" and ")}. Take the value from the source the intent gives, or correct the document.`,
  };
}

function unread(
  claim: SourceClaim,
  source: IntentValueSource,
  found: readonly CodeSource[],
): UncheckedIntent {
  const stopped = [
    ...new Set(
      found.flatMap((one) =>
        one.ref.type === "unresolved" ? [one.ref.sourceText] : [],
      ),
    ),
  ];
  const why =
    stopped.length === 0
      ? `nothing in the summary says where ${source.column} comes from`
      : `the walk from ${source.column} stopped at ${stopped.map((text) => `\`${text}\``).join(" and ")}, which it cannot follow`;
  return {
    intent: claim.intent.name,
    reason: "unreadValue",
    outcomeId: claim.outcome.id,
    detail: `${doing(claim)} with ${source.column} taken from input.${formatPath(source.path)}: ${why}.`,
  };
}
