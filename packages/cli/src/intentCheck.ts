/**
 * `suss intent check` compares a change list with two readings of the
 * code. It says whether each entry is done, not done, or something suss
 * cannot check, and lists each change no entry asked for.
 *
 * The changes come from `behaviorDiff`, the comparison `inspect --diff`
 * prints, so a change reported as not asked is a line the developer
 * also sees in that diff. A boundary resolves the way `suss ask`
 * resolves one, so `Listing.title` means `gql:Listing.title` when no
 * other boundary matches it. An effect resolves through `effectMatches`,
 * which `check --intent` goes through too. The CLI reference for
 * `suss intent` states the rule for each kind of entry.
 */

import { BOUNDARY_ROLE, diffSummaries } from "@suss/behavioral-ir";
import { effectMatches, endingOf, outcomeMatches } from "@suss/checker-intent";
import { displayLabel, namesBoundaryExactly } from "@suss/ir-core";

import { boundaryReach } from "./diffReach.js";
import {
  behaviorDiff,
  CHAIN_HOPS,
  effectText,
  outcomeTexts,
} from "./inspect.js";
import { wholeReadings } from "./readingPairs.js";
import { boundaryLabelsFor, couldMean } from "./target.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Transition,
  WrapperReference,
} from "@suss/behavioral-ir";
import type { CodeEffect, CodeEnding } from "@suss/checker-intent";
import type {
  ChangeListSummary,
  ChangeOutcome,
  ChangeVerb,
  IntentChange,
  IntentEffect,
} from "@suss/intent-ir";
import type { ReachedEffect, ServedBoundaryReach } from "./diffReach.js";
import type { BoundaryBlock, EffectLine, OutcomeLine } from "./inspect.js";
import type { ReadingPair } from "./readingPairs.js";

export type { ReadingPair } from "./readingPairs.js";

export type ChangeVerdict = "done" | "notDone" | "unchecked";

export interface CheckedChange {
  /** The entry on one line, the way the report prints it. */
  said: string;
  verdict: ChangeVerdict;
  /** Why the entry is not done, or why suss cannot check it. */
  reason: string | null;
  /** The units that made the change, as `file::name`. */
  units: string[];
  /** The developer's words the entry quotes. */
  asked: string | null;
  /** Whether a message the developer sent contains that quote. Null when no messages were given. */
  requested: boolean | null;
}

/** One line of the diff at one boundary. */
export interface ChangedLine {
  does: "serves" | "calls";
  boundary: string;
  unit: string;
  file: string;
  change: "added" | "removed" | "changed";
  /** The line as `inspect --diff` prints it. A changed outcome takes two. */
  text: string[];
  /** The outcome was there before and after, and only its condition moved. */
  conditionMoved: boolean;
}

/** What changed at one boundary that no entry asked for. */
export interface UnaskedChange {
  /** Stays the same across runs while the lines do, so a caller can act on it once. */
  identity: string;
  boundary: string;
  lines: ChangedLine[];
}

export interface ExplainedLines {
  said: string;
  why: string;
  lines: ChangedLine[];
}

/** An outcome a wrapper brought, which the report lists apart and never counts against the list. */
export interface WrapperLine {
  from: WrapperReference;
  change: "added" | "removed";
  outcome: string;
  at: string[];
}

export interface IntentCheckResult {
  entries: CheckedChange[];
  /** Changes no entry asked for and no `explained` line keeps, one per boundary. */
  notAsked: UnaskedChange[];
  explained: ExplainedLines[];
  fromWrappers: WrapperLine[];
}

/** Both readings, and the diff between them, across every summaries file. */
interface Readings {
  blocks: readonly BoundaryBlock[];
  wrapperLines: WrapperLine[];
  before: Side;
  after: Side;
}

interface Side {
  units: BehavioralSummary[];
  reach: ServedBoundaryReach[];
}

/** The verdict on one entry, why, and which units made the change. */
type Judgement = Pick<CheckedChange, "verdict" | "reason" | "units">;

/** An entry of either list: a change asked for, or one kept with a reason. */
type Entry = Pick<IntentChange, "verb" | "subject" | "outcomes" | "at">;

export function checkIntent(
  list: ChangeListSummary,
  pairs: readonly ReadingPair[],
  prompts: readonly string[] | null,
): IntentCheckResult {
  const readings = readingsOf(pairs);
  const spell = spellerFor(readings);
  const changes = list.changes.map((change) => respelled(change, spell));
  const kept = list.explained.map((entry) => respelled(entry, spell).entry);
  const entries = changes.map(({ entry, unresolved }) => ({
    said: saidOf(entry, readings),
    ...judged(entry, unresolved, readings),
    asked: entry.asked,
    requested: prompts === null ? null : quotedIn(entry.asked, prompts),
  }));

  const explained: ExplainedLines[] = kept.map((entry) => ({
    said: saidOf(entry, readings),
    why: entry.why,
    lines: [],
  }));
  const unasked: ChangedLine[] = [];
  for (const diffLine of diffLines(readings)) {
    if (changes.some(({ entry }) => asksFor(entry, diffLine))) {
      continue;
    }
    const keeping = kept.findIndex((entry) => asksFor(entry, diffLine));
    if (keeping === -1) {
      unasked.push(diffLine.line);
      continue;
    }
    explained[keeping]?.lines.push(diffLine.line);
  }

  return {
    entries,
    notAsked: byBoundaryLabel(unasked),
    explained,
    fromWrappers: readings.wrapperLines,
  };
}

/**
 * One change per boundary, with every line under it. A new status at a
 * route and the client branch that handles it are one change to ask
 * about, not two.
 */
function byBoundaryLabel(lines: ChangedLine[]): UnaskedChange[] {
  const groups = new Map<string, ChangedLine[]>();
  for (const line of lines) {
    groups.set(line.boundary, [...(groups.get(line.boundary) ?? []), line]);
  }
  return [...groups.entries()].map(([boundary, under]) => ({
    identity: [boundary, ...under.map(lineIdentity).sort()].join("\n"),
    boundary,
    lines: under,
  }));
}

function lineIdentity(line: ChangedLine): string {
  return `${line.does} ${line.file}::${line.unit} ${line.text.join(" ")}`;
}

/**
 * Every file on each side is diffed as one reading, because a
 * deployable's environment is declared in the template's file and read
 * in the code's, and only the two together say what it gained.
 */
function readingsOf(pairs: readonly ReadingPair[]): Readings {
  const { before, after } = wholeReadings(pairs);
  const diff = behaviorDiff(before, after);
  return {
    blocks: diff.blocks,
    wrapperLines: [
      ...diff.causes.map((cause) => ({
        from: cause.wrapper,
        change: cause.change,
        outcome: cause.outcome,
        at: [...cause.boundaries],
      })),
      ...diff.blocks.flatMap(wrapperLinesOf),
    ],
    before: { units: [...before], reach: boundaryReach(before) },
    after: { units: [...after], reach: boundaryReach(after) },
  };
}

// ---------------------------------------------------------------------------
// Which boundary an entry is about
// ---------------------------------------------------------------------------

/** A spelling on the list that picks out no boundary, or more than one. */
interface Unresolved {
  spelled: string;
  /** The boundaries it could mean, empty when it matches none. */
  candidates: string[];
}

/** The spelling to check an entry against, or why there is none. */
type Spelling = { names: string } | Unresolved;

function isResolved(spelling: Spelling): spelling is { names: string } {
  return "names" in spelling;
}

/**
 * How suss reads a spelling on the list. A boundary on either side
 * spelled exactly stays as written, and so does a route or a
 * `system:name` spelling that nothing serves yet, since an entry may add
 * it. Any other spelling resolves the way `suss ask` resolves one, so
 * `Listing.title` means `gql:Listing.title` when that is the only
 * boundary it picks out. A member of a type picks out none.
 */
function spellerFor(readings: Readings): (names: string) => Spelling {
  const units = [...readings.before.units, ...readings.after.units];
  const bindings = units
    .map((unit) => unit.identity.boundaryBinding)
    .filter((binding): binding is BoundaryBinding => binding !== null);
  return (names) => {
    const trimmed = names.trim();
    if (
      bindings.some((binding) => namesBoundaryExactly(names, binding)) ||
      ROUTE_SPELLING.test(trimmed) ||
      SYSTEM_SPELLING.test(trimmed)
    ) {
      return { names };
    }
    const candidates = boundaryLabelsFor(names, units);
    const [only] = candidates;
    return candidates.length === 1 && only !== undefined
      ? { names: only }
      : { spelled: names, candidates };
  };
}

/** `POST /orders`: a method, a space, then a path. */
const ROUTE_SPELLING = /^\S+ +\//;

/** `postgresql:orders`, `unit:lambda Worker`: every other label suss prints. */
const SYSTEM_SPELLING = /^[^\s:]+:\S/;

/** The boundary an entry is about: its subject, or where its effect happens. */
function placeOf(entry: Entry): string | null {
  return entry.subject.kind === "boundary" ? entry.subject.names : entry.at;
}

/**
 * The entry with its boundary spelled the way suss prints it, and the
 * spelling that would not resolve, when it did not.
 */
function respelled<T extends Entry>(
  entry: T,
  spell: (names: string) => Spelling,
): { entry: T; unresolved: Unresolved | null } {
  const place = placeOf(entry);
  if (place === null) {
    return { entry, unresolved: null };
  }
  const spelling = spell(place);
  if (!isResolved(spelling)) {
    return { entry, unresolved: spelling };
  }
  const names = spelling.names;
  return {
    entry:
      entry.subject.kind === "boundary"
        ? { ...entry, subject: { kind: "boundary", names } }
        : { ...entry, at: names },
    unresolved: null,
  };
}

// ---------------------------------------------------------------------------
// Done, not done, or unchecked
// ---------------------------------------------------------------------------

function judged(
  change: IntentChange,
  unresolved: Unresolved | null,
  readings: Readings,
): Judgement {
  if (unresolved !== null) {
    return {
      verdict: "unchecked",
      reason: uncheckedBecause(unresolved),
      units: [],
    };
  }
  if (change.subject.kind === "boundary") {
    return BOUNDARY_VERDICTS[change.verb](
      change.subject.names,
      change.outcomes,
      readings,
    );
  }
  return EFFECT_VERDICTS[change.verb](
    change.subject.effect,
    change.at,
    readings,
  );
}

function uncheckedBecause({ spelled, candidates }: Unresolved): string {
  return candidates.length === 0
    ? `suss has no boundary spelled ${spelled}, so it cannot check this entry.`
    : `${couldMean(spelled, candidates)}, so suss cannot check this entry. Spell out the one it is about.`;
}

type BoundaryVerdict = (
  names: string,
  outcomes: ChangeOutcome[],
  readings: Readings,
) => Judgement;

const BOUNDARY_VERDICTS: Record<ChangeVerb, BoundaryVerdict> = {
  adds: (names, outcomes, readings) => {
    const label = spelled(names, readings);
    const moved = blocksAt(names, readings).filter(
      (block) => block.change !== "removed",
    );
    if (moved.length === 0) {
      return notDone(`the diff does not show ${label} added or changed.`);
    }
    const now = transitionsAt(names, readings.after);
    return withOutcomes(
      outcomes,
      moved,
      (outcome) => now.some((t) => endsAs(outcome, t)),
      (missing) => `${label} does not ${missing}.`,
    );
  },
  changes: (names, outcomes, readings) => {
    const label = spelled(names, readings);
    const moved = blocksAt(names, readings).filter(
      (block) => block.change === "changed",
    );
    if (moved.length === 0) {
      return notDone(notChangedBecause(names, label, readings));
    }
    const changed = changedTransitionsAt(names, readings);
    return withOutcomes(
      outcomes,
      moved,
      (outcome) => changed.some((t) => endsAs(outcome, t)),
      (missing) => `no new or changed outcome at ${label} can ${missing}.`,
    );
  },
  removes: (names, outcomes, readings) => {
    const label = spelled(names, readings);
    if (outcomes.length === 0) {
      const gone = blocksAt(names, readings).filter(
        (block) => block.change === "removed",
      );
      return gone.length === 0
        ? notDone(`the diff does not show ${label} removed.`)
        : done(gone);
    }
    const was = transitionsAt(names, readings.before);
    const now = transitionsAt(names, readings.after);
    return withOutcomes(
      outcomes,
      blocksAt(names, readings),
      (outcome) =>
        was.some((t) => endsAs(outcome, t)) &&
        !now.some((t) => endsAs(outcome, t)),
      (missing) => `${label} still does, or never did, ${missing}.`,
    );
  },
};

/**
 * Why a `changes` entry found its boundary unchanged. A rename shows in
 * the diff as the old boundary removed and the new one added, so an
 * entry about the old name comes here.
 */
function notChangedBecause(
  names: string,
  label: string,
  readings: Readings,
): string {
  const whole = blocksAt(names, readings).map((block) => block.change);
  if (whole.includes("removed")) {
    return `the diff shows ${label} removed. A rename is a removes entry for the old name and an adds entry for the new one.`;
  }
  if (whole.includes("added")) {
    return `the diff shows ${label} added. A new boundary is an adds entry.`;
  }
  return `the diff does not show ${label} changed.`;
}

/** Done when every outcome the entry lists `happened`. */
function withOutcomes(
  outcomes: ChangeOutcome[],
  blocks: BoundaryBlock[],
  happened: (outcome: ChangeOutcome) => boolean,
  because: (missing: string) => string,
): Judgement {
  const missing = outcomes.filter((outcome) => !happened(outcome));
  if (missing.length > 0) {
    return notDone(
      because(missing.map((outcome) => outcomeWords(outcome)).join(" or ")),
    );
  }
  return done(blocks);
}

type EffectVerdict = (
  effect: IntentEffect,
  at: string | null,
  readings: Readings,
) => Judgement;

const EFFECT_VERDICTS: Record<ChangeVerb, EffectVerdict> = {
  adds: (effect, at, readings) => {
    const gained = servedAt(at, readings.after).filter(
      (served) =>
        reaches(served, effect) &&
        !reaches(sameServer(served, readings.before), effect),
    );
    const because =
      at === null
        ? `no boundary newly ${effectWords(effect, "s")}.`
        : `${spelled(at, readings)} does not newly ${effectWords(effect)}.`;
    return gained.length === 0 ? notDone(because) : doneBy(gained);
  },
  removes: (effect, at, readings) => {
    const lost = servedAt(at, readings.before).filter(
      (served) =>
        reaches(served, effect) &&
        !reaches(sameServer(served, readings.after), effect),
    );
    const because =
      at === null
        ? `no boundary that used to ${effectWords(effect)} has stopped.`
        : `${spelled(at, readings)} still does, or never did, ${effectWords(effect)}.`;
    return lost.length === 0 ? notDone(because) : doneBy(lost);
  },
  changes: (effect, at, readings) => {
    const changed = servedAt(at, readings.after).filter(
      (served) =>
        reaches(served, effect) &&
        readings.blocks.some(
          (block) =>
            block.change === "changed" &&
            block.file === served.summary.location.file &&
            block.unit === served.summary.identity.name,
        ),
    );
    const where = at === null ? "any boundary" : spelled(at, readings);
    return changed.length === 0
      ? notDone(
          `the diff does not show a change at ${where} that goes on to ${effectWords(effect)}.`,
        )
      : doneBy(changed);
  },
};

function done(blocks: BoundaryBlock[]): Judgement {
  return {
    verdict: "done",
    reason: null,
    units: distinct(blocks.map((block) => `${block.file}::${block.unit}`)),
  };
}

function doneBy(served: ServedBoundaryReach[]): Judgement {
  return {
    verdict: "done",
    reason: null,
    units: distinct(served.map((one) => unitOf(one.summary))),
  };
}

function notDone(reason: string): Judgement {
  return { verdict: "notDone", reason, units: [] };
}

function blocksAt(names: string, readings: Readings): BoundaryBlock[] {
  return readings.blocks.filter(
    (block) =>
      block.binding !== null && namesBoundaryExactly(names, block.binding),
  );
}

function providersAt(names: string, side: Side): BehavioralSummary[] {
  return side.units.filter(
    (unit) =>
      BOUNDARY_ROLE[unit.kind] === "provider" &&
      unit.identity.boundaryBinding !== null &&
      namesBoundaryExactly(names, unit.identity.boundaryBinding),
  );
}

function transitionsAt(names: string, side: Side): Transition[] {
  return providersAt(names, side).flatMap((unit) => unit.transitions);
}

/** The transitions at the boundary that are new, or differ from before. */
function changedTransitionsAt(names: string, readings: Readings): Transition[] {
  const before = providersAt(names, readings.before);
  return providersAt(names, readings.after).flatMap((unit) => {
    const was = before.find((one) => unitOf(one) === unitOf(unit));
    if (was === undefined) {
      return unit.transitions;
    }
    const diff = diffSummaries(was, unit);
    return [
      ...diff.addedTransitions,
      ...diff.changedTransitions.map((pair) => pair.after),
    ];
  });
}

function endsAs(outcome: ChangeOutcome, transition: Transition): boolean {
  const ending = endingOf(transition);
  return ending !== null && outcomeMatches(outcome, ending);
}

/** The units serving the boundary, or every served boundary when `at` is null. */
function servedAt(at: string | null, side: Side): ServedBoundaryReach[] {
  return side.reach.filter(
    (served) => at === null || namesBoundaryExactly(at, served.binding),
  );
}

/** The same unit serving the same boundary, on the other side. */
function sameServer(
  served: ServedBoundaryReach,
  side: Side,
): ServedBoundaryReach | undefined {
  return side.reach.find(
    (other) =>
      other.boundary === served.boundary &&
      unitOf(other.summary) === unitOf(served.summary),
  );
}

/** Whether a request through this boundary reaches the effect, by any one access. */
function reaches(
  served: ServedBoundaryReach | undefined,
  effect: IntentEffect,
): boolean {
  return (
    served?.effects.some((reached) => reachedMatches(effect, reached)) === true
  );
}

function reachedMatches(effect: IntentEffect, reached: ReachedEffect): boolean {
  return reached.accesses.some((access) =>
    effectMatches(effect, {
      does: reached.relation,
      binding: reached.binding,
      label: reached.boundary,
      fields: [...access.fields],
      by: [...access.by],
    }),
  );
}

function unitOf(summary: BehavioralSummary): string {
  return `${summary.location.file}::${summary.identity.name}`;
}

function distinct(items: string[]): string[] {
  return [...new Set(items)];
}

// ---------------------------------------------------------------------------
// Which diff lines an entry asked for
// ---------------------------------------------------------------------------

/** A line of the diff, and the block and the diff line it was printed from. */
type DiffLine = { block: BoundaryBlock; line: ChangedLine } & (
  | { outcome: OutcomeLine; effect?: undefined }
  | { effect: EffectLine; outcome?: undefined }
);

/**
 * Every line of the diff that counts against the list. An outcome a
 * wrapper brought is left out, because the wrapper is shared code and
 * the report lists it under the wrapper for the developer to read.
 */
function diffLines(readings: Readings): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const block of readings.blocks) {
    for (const outcome of block.outcomes) {
      if (outcome.wrapper !== undefined) {
        continue;
      }
      const moved = onlyItsConditionMoved(block, outcome, readings);
      lines.push({
        block,
        outcome,
        line: changedLine(block, outcome.change, outcomeTexts(outcome), moved),
      });
    }

    for (const effect of block.effects) {
      lines.push({
        block,
        effect,
        line: changedLine(
          block,
          effect.change,
          [effectText(effect, CHAIN_HOPS)],
          false,
        ),
      });
    }
  }
  return lines;
}

/** Whether the entry asks for this line of the diff. */
function asksFor(entry: Entry, diffLine: DiffLine): boolean {
  if (diffLine.effect !== undefined) {
    return coversEffect(entry, diffLine.block, diffLine.effect);
  }
  return (
    coversOutcome(entry, diffLine.block, diffLine.outcome) ||
    (diffLine.line.conditionMoved && mentions(entry, diffLine.block))
  );
}

/** The outcomes a wrapper brought to one boundary, which no cause lifted out. */
function wrapperLinesOf(block: BoundaryBlock): WrapperLine[] {
  return block.outcomes.flatMap((line) =>
    line.wrapper === undefined
      ? []
      : [
          {
            from: line.wrapper,
            change: line.change === "removed" ? "removed" : "added",
            outcome: line.outcome,
            at: [block.boundary],
          },
        ],
  );
}

function changedLine(
  block: BoundaryBlock,
  change: ChangedLine["change"],
  text: string[],
  conditionMoved: boolean,
): ChangedLine {
  return {
    does: block.does,
    boundary: block.boundary,
    unit: block.unit,
    file: block.file,
    change,
    text,
    conditionMoved,
  };
}

/** Whether the entry is about this block's boundary, by its subject or its `at`. */
function mentions(entry: Entry, block: BoundaryBlock): boolean {
  const names = placeOf(entry);
  return (
    names !== null &&
    block.binding !== null &&
    namesBoundaryExactly(names, block.binding)
  );
}

/**
 * An outcome of the handler's own body is asked for by a boundary entry
 * that lists it, or that lists no outcomes at all. A caller's outcomes
 * change with the boundary it calls, so an entry about the boundary
 * covers them.
 */
function coversOutcome(
  entry: Entry,
  block: BoundaryBlock,
  line: OutcomeLine,
): boolean {
  if (!mentions(entry, block)) {
    return false;
  }
  if (block.does === "calls") {
    return true;
  }
  return (
    entry.subject.kind === "boundary" &&
    (entry.outcomes.length === 0 ||
      entry.outcomes.some((outcome) => endsAs(outcome, line.transition)))
  );
}

/**
 * A new branch moves the condition of the outcomes below it. The diff
 * shows each of those as changed, or as one outcome gone and one added.
 * When the unit ends the same way on the other side, the outcome itself
 * is not new.
 */
function onlyItsConditionMoved(
  block: BoundaryBlock,
  line: OutcomeLine,
  readings: Readings,
): boolean {
  if (line.change === "changed") {
    return (
      line.previous !== undefined &&
      JSON.stringify(line.previous.output) ===
        JSON.stringify(line.transition.output)
    );
  }
  const other = line.change === "added" ? readings.before : readings.after;
  const unit = other.units.find(
    (one) =>
      one.location.file === block.file && one.identity.name === block.unit,
  );
  const ending = endingOf(line.transition);
  return (
    unit !== undefined &&
    ending !== null &&
    unit.transitions.some((t) => endsAs(asOutcome(ending), t))
  );
}

function asOutcome(ending: CodeEnding): ChangeOutcome {
  return {
    kind: ending.kind,
    status: ending.status,
    errorType: ending.errorType,
  };
}

/** An effect is asked for at a boundary an entry is about, or by an effect entry with no `at`. */
function coversEffect(
  entry: Entry,
  block: BoundaryBlock,
  line: EffectLine,
): boolean {
  if (mentions(entry, block)) {
    return true;
  }
  if (
    entry.subject.kind !== "effect" ||
    entry.at !== null ||
    line.relation === undefined ||
    line.binding === undefined
  ) {
    return false;
  }
  const made: CodeEffect = {
    does: line.relation,
    binding: line.binding,
    label: line.boundary ?? "",
    fields: line.detail === undefined ? [] : [line.detail],
    by: [],
  };
  return (
    effectMatches(entry.subject.effect, made) ||
    declaresWhatItTouches(entry.subject.effect, made)
  );
}

/**
 * A template that starts declaring a variable, and code that starts
 * reading it, are the two sides of one change to a deployable's
 * environment. So an entry about the read covers the declaration too.
 */
function declaresWhatItTouches(
  effect: IntentEffect,
  made: CodeEffect,
): boolean {
  return (
    made.does === "provides" &&
    effectMatches(effect, { ...made, does: effect.does })
  );
}

// ---------------------------------------------------------------------------
// Whether the developer asked
// ---------------------------------------------------------------------------

/**
 * Whether a message the developer sent contains the quote. Case, the kind
 * of quote marks and the spacing are ignored, and `...` in the quote
 * skips any stretch of the message, so an agent can shorten a long one.
 */
export function quotedIn(
  quote: string | null,
  prompts: readonly string[],
): boolean {
  if (quote === null) {
    return false;
  }
  const pieces = quote
    .split(/\.\.\.|…/)
    .map(plain)
    .filter((piece) => piece.length > 0);
  if (pieces.length === 0) {
    return false;
  }
  return prompts.some((prompt) => inOrder(pieces, plain(prompt)));
}

function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function inOrder(pieces: string[], text: string): boolean {
  let from = 0;
  for (const piece of pieces) {
    const at = text.indexOf(piece, from);
    if (at === -1) {
      return false;
    }
    from = at + piece.length;
  }
  return true;
}

// ---------------------------------------------------------------------------
// How an entry reads
// ---------------------------------------------------------------------------

const VERB_MARKS: Record<ChangeVerb, string> = {
  adds: "+",
  removes: "-",
  changes: "~",
};

/** `+ POST /orders/{id}/cancel responds 200, 404`, with the route spelled as the diff spells it. */
function saidOf(
  entry: Entry & { note?: string | null },
  readings: Readings,
): string {
  const note =
    entry.note === undefined || entry.note === null ? "" : ` ${entry.note}`;
  return `${VERB_MARKS[entry.verb]} ${subjectWords(entry, readings)}${note}`;
}

function subjectWords(entry: Entry, readings: Readings): string {
  if (entry.subject.kind === "boundary") {
    const outcomes =
      entry.outcomes.length === 0 ? "" : ` ${outcomeList(entry.outcomes)}`;
    return `${spelled(entry.subject.names, readings)}${outcomes}`;
  }
  const effect = entry.subject.effect;
  const at = entry.at === null ? "" : `${spelled(entry.at, readings)} `;
  const fields =
    effect.fields.length === 0 ? "" : ` [${effect.fields.join(", ")}]`;
  const by = effect.by.length === 0 ? "" : ` by ${effect.by.join(", ")}`;
  return `${at}${effect.does} ${effect.names}${fields}${by}`;
}

/** The boundary as the diff prints it, when a unit on either side has it. */
function spelled(names: string, readings: Readings): string {
  const unit = [...readings.after.units, ...readings.before.units].find(
    (one) =>
      one.identity.boundaryBinding !== null &&
      namesBoundaryExactly(names, one.identity.boundaryBinding),
  );
  const binding = unit?.identity.boundaryBinding;
  return binding === undefined || binding === null
    ? names
    : displayLabel(binding);
}

/** `responds 200, 404, throws NotFoundError`. */
function outcomeList(outcomes: ChangeOutcome[]): string {
  const statuses = outcomes
    .filter((outcome) => outcome.status !== null)
    .map((outcome) => String(outcome.status));
  const others = outcomes
    .filter((outcome) => outcome.status === null)
    .map((outcome) => outcomeWords(outcome, "s"));
  const responds =
    statuses.length === 0 ? [] : [`responds ${statuses.join(", ")}`];
  return [...responds, ...others].join(", ");
}

const ENDING_WORDS: Record<
  ChangeOutcome["kind"],
  (o: ChangeOutcome) => { verb: string; object: string }
> = {
  response: (outcome) => ({ verb: "respond", object: ` ${outcome.status}` }),
  return: () => ({ verb: "return", object: "" }),
  throw: (outcome) => ({
    verb: "throw",
    object: outcome.errorType === null ? "" : ` ${outcome.errorType}`,
  }),
  exit: (outcome) => ({ verb: "exit", object: ` ${outcome.status}` }),
  effect: () => ({ verb: "end", object: " with an effect" }),
};

/** `respond 404`, or `throws NotFoundError` given the ending `s`. */
function outcomeWords(outcome: ChangeOutcome, ending = ""): string {
  const { verb, object } = ENDING_WORDS[outcome.kind](outcome);
  return `${verb}${ending}${object}`;
}

/** `write postgresql:orders [cancelled_at]`, with a verb ending for the sentence it goes in. */
function effectWords(effect: IntentEffect, ending = ""): string {
  const verb = effect.does.replace(/s$/, "");
  const fields =
    effect.fields.length === 0 ? "" : ` [${effect.fields.join(", ")}]`;
  return `${verb}${ending} ${effect.names}${fields}`;
}
