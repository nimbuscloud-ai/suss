/**
 * The other paths that send the same data as a path a change moved, and
 * did not change themselves.
 *
 * A pull request that stops showing a count on screen and leaves the CSV
 * export showing it changed one exit of that data and missed another.
 * For each unit the diff reports, this works out which of its data moved
 * and asks `@suss/checker`'s data facts which other paths read or send
 * that same data and send it out. The README beside the data facts says
 * what counts as the same data and as sending it out.
 */

import {
  BOUNDARY_ROLE,
  displayLabel,
  leavesTheProcess,
} from "@suss/behavioral-ir";
import { datumKey, readDataFacts } from "@suss/checker";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";
import type {
  CallFacts,
  DataPath,
  Datum,
  PathData,
  Sharing,
  UnreadData,
} from "@suss/checker";
import type { MovedUnit } from "./inspect.js";

/** Why these data were taken from the changed unit. */
export type SiblingBasis = "fields" | "conditions" | "removed" | "asked";

export interface SiblingUnit {
  readonly unit: string;
  readonly file: string;
  readonly line: number;
  /** The boundary it serves or calls, when it is on one that leaves the process. */
  readonly boundary: string | null;
  readonly role: "serves" | "calls" | null;
}

export interface SiblingPath extends SiblingUnit {
  readonly shares: readonly Datum[];
  readonly sends: readonly string[];
}

export interface UncheckedSibling extends SiblingUnit {
  readonly reasons: readonly string[];
  readonly sends: readonly string[];
}

/** One changed unit, the data of it that moved, and the paths that send the same data. */
export interface SiblingGroup {
  readonly changed: SiblingUnit & { readonly change: MovedUnit["change"] };
  readonly basis: SiblingBasis;
  readonly data: readonly Datum[];
  readonly siblings: readonly SiblingPath[];
  readonly unchecked: readonly UncheckedSibling[];
  /** What suss could not read on the changed unit's own paths. */
  readonly notes: readonly string[];
}

/** The last segment of a field path, which is what a column and a body field can share. */
function leafName(field: string): string {
  return field.slice(field.lastIndexOf(".") + 1);
}

function placeOf(summary: BehavioralSummary): SiblingUnit {
  const binding = summary.identity.boundaryBinding;
  const outside = binding !== null && leavesTheProcess(binding);
  return {
    unit: summary.identity.name,
    file: summary.location.file,
    line: summary.location.range.start,
    boundary: outside ? displayLabel(binding) : null,
    role: outside ? ROLE_WORDS[BOUNDARY_ROLE[summary.kind]] : null,
  };
}

const ROLE_WORDS: Record<
  (typeof BOUNDARY_ROLE)[BehavioralSummary["kind"]],
  "serves" | "calls"
> = {
  provider: "serves",
  consumer: "calls",
};

/** Which summary each transition belongs to, so a diff's transitions find their unit. */
function ownerOf(
  summaries: readonly BehavioralSummary[],
): Map<Transition, BehavioralSummary> {
  const owner = new Map<Transition, BehavioralSummary>();
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      owner.set(transition, summary);
    }
  }
  return owner;
}

function pathsOf(
  transitions: readonly Transition[],
  owner: ReadonlyMap<Transition, BehavioralSummary>,
): DataPath[] {
  return transitions.flatMap((transition) => {
    const summary = owner.get(transition);
    return summary === undefined ? [] : [{ summary, transition }];
  });
}

interface UsedData {
  readonly named: Map<string, Datum>;
  readonly unread: UnreadData[];
}

/** Everything these paths use, and what they read that suss could not, from one `dataOn` answer. */
function usedOn(
  answer: ReadonlyMap<Transition, PathData>,
  transitions: readonly Transition[],
): UsedData {
  const named = new Map<string, Datum>();
  const unread: UnreadData[] = [];
  for (const transition of transitions) {
    const data = answer.get(transition);
    for (const datum of data?.named ?? []) {
      named.set(datumKey(datum), datum);
    }
    unread.push(...(data?.unread ?? []));
  }
  return { named, unread };
}

/** The body fields of a response that changed type between the two sides. */
function retypedFields(before: Transition, after: Transition): string[] {
  const was = recordOf(before);
  const now = recordOf(after);
  if (was === null || now === null) {
    return [];
  }
  return Object.keys(now).filter(
    (field) =>
      was[field] !== undefined &&
      JSON.stringify(was[field]) !== JSON.stringify(now[field]),
  );
}

function recordOf(transition: Transition): Record<string, unknown> | null {
  const output = transition.output;
  if (output.type !== "response" || output.body?.type !== "record") {
    return null;
  }
  return output.body.properties;
}

/** The two sides of one changed unit's moved paths. */
interface MovedPaths {
  readonly before: readonly Transition[];
  readonly after: readonly Transition[];
  readonly retyped: readonly string[];
}

function movedPaths(unit: MovedUnit): MovedPaths | null {
  if (unit.change === "removed") {
    return {
      before: unit.outcomes.map((line) => line.transition),
      after: [],
      retyped: [],
    };
  }

  if (unit.diff === null) {
    return null;
  }
  const { addedTransitions, removedTransitions, changedTransitions } =
    unit.diff;
  return {
    before: [
      ...removedTransitions,
      ...changedTransitions.map((pair) => pair.before),
    ],
    after: [
      ...addedTransitions,
      ...changedTransitions.map((pair) => pair.after),
    ],
    retyped: changedTransitions.flatMap((pair) =>
      retypedFields(pair.before, pair.after),
    ),
  };
}

/**
 * The data a changed unit moved. When a field came, went or changed
 * type, that is every datum with the field's name, so a column the path
 * reads joins the body field it sends under the same name. When only the
 * conditions moved, or the unit went whole, it is what the path sends
 * and every column it reads under a name it sends.
 */
function movedData(
  named: ReadonlyMap<string, Datum>,
  beforeKeys: ReadonlySet<string>,
  afterKeys: ReadonlySet<string>,
  retyped: readonly string[],
  removed: boolean,
): { basis: SiblingBasis; data: Datum[] } {
  const moved = new Set(retyped);
  for (const [key, datum] of named) {
    if (beforeKeys.has(key) !== afterKeys.has(key)) {
      moved.add(leafName(datum.field));
    }
  }
  if (moved.size > 0 && !removed) {
    return {
      basis: "fields",
      data: [...named.values()].filter((datum) =>
        moved.has(leafName(datum.field)),
      ),
    };
  }
  return {
    basis: removed ? "removed" : "conditions",
    data: sentData([...named.values()]),
  };
}

/** What a path sends, and every column it reads under a name it sends. */
function sentData(named: readonly Datum[]): Datum[] {
  const sent = new Set(
    named
      .filter((datum) => datum.kind === "sends")
      .map((datum) => leafName(datum.field)),
  );
  return named.filter(
    (datum) =>
      datum.kind === "sends" ||
      (datum.kind === "column" && sent.has(leafName(datum.field))),
  );
}

/** A body field the change moved that no column the path reads shares a name with. */
function unmatchedFields(data: readonly Datum[]): string[] {
  const columns = new Set(
    data
      .filter((datum) => datum.kind === "column")
      .map((datum) => leafName(datum.field)),
  );
  return [
    ...new Set(
      data
        .filter(
          (datum) =>
            datum.kind !== "column" && !columns.has(leafName(datum.field)),
        )
        .map((datum) => datum.field),
    ),
  ];
}

interface FoundSiblings {
  readonly siblings: SiblingPath[];
  readonly unchecked: UncheckedSibling[];
}

/** The scope key an unread read is matched on, the same one its datum would have. */
function scopeOf(entry: Pick<Datum, "kind" | "scope">): string {
  return JSON.stringify([entry.kind, entry.scope]);
}

/**
 * One line per sibling unit, with every path of it merged, keeping only
 * what shares one of these data. One `sharing` answer covers every
 * changed unit, so each group takes its own part of it.
 */
function byUnit(sharing: Sharing, data: readonly Datum[]): FoundSiblings {
  const keys = new Set(data.map(datumKey));
  const scopes = new Set(data.map(scopeOf));
  const siblings = new Map<BehavioralSummary, SiblingPath>();
  for (const path of sharing.sharing) {
    const shares = path.shares.filter((datum) => keys.has(datumKey(datum)));
    if (shares.length === 0) {
      continue;
    }
    const already = siblings.get(path.summary);
    siblings.set(path.summary, {
      ...placeOf(path.summary),
      shares: mergedData(already?.shares ?? [], shares),
      sends: [...new Set([...(already?.sends ?? []), ...path.sends])],
    });
  }

  const unchecked = new Map<BehavioralSummary, UncheckedSibling>();
  for (const path of sharing.unchecked) {
    const unread = path.unread.filter((one) => scopes.has(scopeOf(one)));
    if (unread.length === 0 || siblings.has(path.summary)) {
      continue;
    }
    const already = unchecked.get(path.summary);
    unchecked.set(path.summary, {
      ...placeOf(path.summary),
      reasons: [
        ...new Set([
          ...(already?.reasons ?? []),
          ...unread.map((one) => one.reason),
        ]),
      ],
      sends: [...new Set([...(already?.sends ?? []), ...path.sends])],
    });
  }

  return {
    siblings: [...siblings.values()].sort(byPlace),
    unchecked: [...unchecked.values()].sort(byPlace),
  };
}

function mergedData(a: readonly Datum[], b: readonly Datum[]): Datum[] {
  const merged = new Map<string, Datum>();
  for (const datum of [...a, ...b]) {
    merged.set(datumKey(datum), datum);
  }
  return [...merged.values()];
}

function byPlace(a: SiblingUnit, b: SiblingUnit): number {
  return (
    (a.boundary ?? "").localeCompare(b.boundary ?? "") ||
    a.file.localeCompare(b.file) ||
    a.unit.localeCompare(b.unit)
  );
}

/** The after side's summaries for the units that moved, so their own calls are left out. */
function changedSummaries(
  moved: readonly MovedUnit[],
  after: readonly BehavioralSummary[],
): BehavioralSummary[] {
  const places = new Set(
    moved.map((unit) => `${unit.kind} ${unit.file}::${unit.name}`),
  );
  return after.filter((summary) =>
    places.has(
      `${summary.kind} ${summary.location.file}::${summary.identity.name}`,
    ),
  );
}

/**
 * For every unit the diff reports as changed or removed, the other paths
 * on the after side that send the data it moved. A unit that came whole
 * is left out, since a new exit has no sibling it could have missed.
 */
export function siblingExits(
  moved: readonly MovedUnit[],
  before: readonly BehavioralSummary[],
  after: readonly BehavioralSummary[],
): SiblingGroup[] {
  const moves = moved.flatMap((unit) => {
    const paths = unit.change === "added" ? null : movedPaths(unit);
    return paths === null ? [] : [{ unit, paths }];
  });
  if (moves.length === 0) {
    return [];
  }
  const beforeOwner = ownerOf(before);
  const afterOwner = ownerOf(after);
  const afterFacts = readDataFacts(after);
  // Every moved path on a side is asked in one question, rather than one
  // question per unit, since each question loads every fact again.
  const was = readDataFacts(before).dataOn(
    pathsOf(
      moves.flatMap(({ paths }) => paths.before),
      beforeOwner,
    ),
  );
  const now = afterFacts.dataOn(
    pathsOf(
      moves.flatMap(({ paths }) => paths.after),
      afterOwner,
    ),
  );

  const drafts = moves.flatMap(({ unit, paths }) => {
    const owner =
      afterOwner.get(paths.after[0] as Transition) ??
      beforeOwner.get(paths.before[0] as Transition);
    if (owner === undefined) {
      return [];
    }
    const draft = movedGroup(
      unit,
      owner,
      usedOn(was, paths.before),
      usedOn(now, paths.after),
      paths.retyped,
    );
    return draft === null ? [] : [draft];
  });

  const asked = drafts.flatMap((draft) => draft.data);
  const sharing =
    asked.length === 0
      ? { sharing: [], unchecked: [] }
      : afterFacts.sharing(asked, changedSummaries(moved, after));
  return drafts
    .map((draft) => ({ ...draft, ...byUnit(sharing, draft.data) }))
    .sort((a, b) => byPlace(a.changed, b.changed));
}

/** One changed unit's group before its siblings are known, or null when it has nothing to say. */
function movedGroup(
  unit: MovedUnit,
  owner: BehavioralSummary,
  was: UsedData,
  now: UsedData,
  retyped: readonly string[],
): Omit<SiblingGroup, "siblings" | "unchecked"> | null {
  const { basis, data } = movedData(
    new Map([...was.named, ...now.named]),
    new Set(was.named.keys()),
    new Set(now.named.keys()),
    retyped,
    unit.change === "removed",
  );
  const unmatched = basis === "fields" ? unmatchedFields(data) : [];
  const notes = [
    ...new Set([...was.unread, ...now.unread].map((one) => one.reason)),
    ...unmatched.map(
      (field) =>
        `${field} matches no column this path reads, so suss cannot say which stored data it is`,
    ),
  ];
  if (data.length === 0 && notes.length === 0) {
    return null;
  }
  return {
    changed: { ...placeOf(owner), change: unit.change },
    basis,
    data,
    notes,
  };
}

/**
 * Every datum these units use, and the other paths that send it out.
 * `suss ask` uses this for one unit, outside any diff.
 */
export function sharedDataOf(
  units: readonly BehavioralSummary[],
  summaries: readonly BehavioralSummary[],
  calls?: CallFacts,
): { data: Datum[]; notes: string[]; found: FoundSiblings } {
  const facts = readDataFacts(summaries, calls);
  const paths = units.flatMap((summary) =>
    summary.transitions.map((transition) => ({ summary, transition })),
  );
  const { named, unread } = usedOn(
    facts.dataOn(paths),
    paths.map((path) => path.transition),
  );
  const data = [...named.values()];
  return {
    data,
    notes: [...new Set(unread.map((one) => one.reason))],
    found:
      data.length === 0
        ? { siblings: [], unchecked: [] }
        : byUnit(facts.sharing(data, units), data),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const DATUM_WORDS: Record<Datum["kind"], (datum: Datum) => string> = {
  column: (datum) => `${datum.at}.${datum.field}`,
  sends: (datum) => `${datum.field} sent to ${datum.at}`,
  reads: (datum) => `${datum.field} read from ${datum.at}`,
};

export function datumText(datum: Datum): string {
  return DATUM_WORDS[datum.kind](datum);
}

export function placeText(place: SiblingUnit): string {
  const where = `${place.file}::${place.unit}`;
  return place.boundary === null || place.role === null
    ? where
    : `${place.role} ${place.boundary}  ${where}`;
}

const BASIS_WORDS: Record<SiblingBasis, string> = {
  fields: "data it changed",
  conditions: "data it sends, under conditions that changed",
  removed: "data it sent",
  asked: "data it reads or sends",
};

export const SIBLINGS_HEADING =
  "Other paths that send the same data and did not change";

/** The section `inspect --diff` prints, empty when no group has a path to list. */
export function siblingSection(groups: readonly SiblingGroup[]): string[] {
  const shown = groups.filter(
    (group) => group.siblings.length + group.unchecked.length > 0,
  );
  if (shown.length === 0) {
    return [];
  }
  return [
    SIBLINGS_HEADING,
    "",
    ...shown.flatMap((group) => [...groupLines(group), ""]),
  ];
}

const CHANGE_MARKERS: Record<MovedUnit["change"], string> = {
  added: "+",
  removed: "-",
  changed: "~",
};

function groupLines(group: SiblingGroup): string[] {
  return [
    `${CHANGE_MARKERS[group.changed.change]} ${placeText(group.changed)}`,
    `  ${BASIS_WORDS[group.basis]}: ${group.data.map(datumText).join(", ")}`,
    ...siblingLines(group),
  ];
}

/** The siblings and the unchecked paths of one group, indented under it. */
export function siblingLines(
  group: Pick<SiblingGroup, "siblings" | "unchecked" | "notes">,
): string[] {
  const lines: string[] = [];
  for (const sibling of group.siblings) {
    lines.push(`    ${placeText(sibling)}`);
    lines.push(
      `      shares ${sibling.shares.map(datumText).join(", ")}; ${sibling.sends.join(", ")}`,
    );
  }

  if (group.unchecked.length > 0) {
    lines.push("  not checked");
  }

  for (const path of group.unchecked) {
    lines.push(`    ${placeText(path)}`);
    lines.push(...path.reasons.map((reason) => `      ${reason}`));
  }

  for (const note of group.notes) {
    lines.push(`  suss could not read part of this unit: ${note}`);
  }
  return lines;
}

function datumJson(datum: Datum): Record<string, string> {
  return { kind: datum.kind, at: datum.at, field: datum.field };
}

/** The groups as `inspect --diff --json` writes them, leaving out any with nothing to say. */
export function siblingJson(
  groups: readonly SiblingGroup[],
): Array<Record<string, unknown>> {
  return groups
    .filter(
      (group) =>
        group.siblings.length + group.unchecked.length + group.notes.length > 0,
    )
    .map((group) => ({
      changed: group.changed,
      basis: group.basis,
      data: group.data.map(datumJson),
      siblings: group.siblings.map((sibling) => ({
        ...sibling,
        shares: sibling.shares.map(datumJson),
      })),
      unchecked: group.unchecked,
      notes: group.notes,
    }));
}
