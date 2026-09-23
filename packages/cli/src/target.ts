/**
 * Resolves what a user points at with `--at` or in a question to the
 * summaries and boundary touches it means.
 *
 * The spellings are tried in this order: a summary id, which is anything
 * with `::` in it; a file and a line, `src/dao.ts:43`; a file; a summary
 * by its function name; and a boundary,
 * `aws.dynamodb:editions#by-publication`. A file comes before a boundary,
 * so a path is never read as a boundary whose words happen to match.
 *
 * When a spelling matches nothing, the result has a message for the caller
 * to print. An empty report would look like agreement.
 */

import path from "node:path";

import {
  BOUNDARY_ROLE,
  boundaryKey,
  settlingSuffix,
  summaryIdentifier,
  summaryRef,
  unsettledSummaryId,
} from "@suss/behavioral-ir";

import {
  boundariesTouchedBy,
  namesBoundary,
  namesBoundaryExactly,
  type Relation,
  type TouchedBoundary,
} from "./boundaryReach.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export type TargetKind = "summary" | "file" | "line" | "boundary";

/** A unit the target picked out, and what it does at one boundary. */
export interface TargetTouch {
  summary: BehavioralSummary;
  touched: TouchedBoundary;
  /**
   * The calls from the unit the user asked about to this one. Set only
   * when the touch was found by following calls out of that unit.
   */
  through?: string[];
}

export interface ResolvedTarget {
  kind: TargetKind;
  /** What the caller typed. */
  spelledAs: string;
  /** What the spelling resolved to, as a report prints it. */
  detail: string;
  /** The units the target picked out. */
  summaries: BehavioralSummary[];
  /** Transitions covering the line, when the target gave one. */
  transitionIds: string[];
  /** What those units do at the boundaries they touch. */
  touches: TargetTouch[];
}

export type TargetResolution =
  | { matched: true; target: ResolvedTarget }
  | { matched: false; spelledAs: string; message: string };

export function resolveTarget(
  spelledAs: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetResolution {
  const spec = spelledAs.trim();
  if (spec === "") {
    return {
      matched: false,
      spelledAs,
      message:
        "--at needs something to point at: a file, a file and a line, a boundary, or a summary id.",
    };
  }

  // A package export boundary such as `fn:@suss/checker::checkAll` also
  // contains `::`, so a spelling that matches no summary id is tried as a
  // boundary before it is rejected.
  if (spec.includes("::")) {
    const asSummary = summaryTarget(spec, summaries);
    if (asSummary.matched) {
      return asSummary;
    }
    const asBoundary = boundaryTarget(spec, summaries);
    return asBoundary.matched ? asBoundary : asSummary;
  }

  const withLine = /^(.*):(\d+)$/.exec(spec);
  if (withLine !== null && filesMatching(withLine[1], summaries).length > 0) {
    return lineTarget(withLine[1], Number(withLine[2]), spec, summaries);
  }

  if (filesMatching(spec, summaries).length > 0) {
    return fileTarget(spec, summaries);
  }

  // A report prints both a handler's function name and its route, so a
  // user may type either one.
  const asSummary = summaryTarget(spec, summaries);
  if (asSummary.matched) {
    return asSummary;
  }

  return boundaryTarget(spec, summaries);
}

// ---------------------------------------------------------------------------
// One spelling at a time
// ---------------------------------------------------------------------------

function summaryTarget(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetResolution {
  const matched = summaries.filter((summary) => idMatches(spec, summary));
  if (matched.length === 0) {
    return {
      matched: false,
      spelledAs: spec,
      message: `No summary here is called ${spec}. ${spelledLike(summaries.slice(0, 3).map((s) => summaryIdentifier(s)))}`,
    };
  }

  return {
    matched: true,
    target: {
      kind: "summary",
      spelledAs: spec,
      detail: describeUnits(matched),
      summaries: matched,
      transitionIds: [],
      touches: touchesOf(matched),
    },
  };
}

function fileTarget(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetResolution {
  const files = filesMatching(spec, summaries);
  const matched = summaries.filter((summary) =>
    files.includes(summary.location.file),
  );
  return {
    matched: true,
    target: {
      kind: "file",
      spelledAs: spec,
      detail: `${files.join(", ")}, ${describeUnits(matched)}`,
      summaries: matched,
      transitionIds: [],
      touches: touchesOf(matched),
    },
  };
}

function lineTarget(
  file: string,
  line: number,
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetResolution {
  const files = filesMatching(file, summaries);
  const inFile = summaries.filter((summary) =>
    files.includes(summary.location.file),
  );
  const matched = inFile.filter(
    (summary) =>
      summary.location.range.start <= line &&
      line <= summary.location.range.end,
  );
  if (matched.length === 0) {
    const spans = inFile
      .map((s) => `${s.location.range.start}-${s.location.range.end}`)
      .join(", ");
    return {
      matched: false,
      spelledAs: spec,
      message: `Nothing here covers line ${line} of ${files.join(", ")}. What these summaries cover in that file: ${spans}.`,
    };
  }

  const transitionIds = matched.flatMap((summary) =>
    summary.transitions
      .filter((t) => t.location.start <= line && line <= t.location.end)
      .map((t) => t.id),
  );
  const covered = new Set(transitionIds);
  return {
    matched: true,
    target: {
      kind: "line",
      spelledAs: spec,
      detail: `${files.join(", ")} line ${line}, ${describeUnits(matched)}${describeBranches(transitionIds.length)}`,
      summaries: matched,
      transitionIds,
      touches: touchesOf(matched, covered.size > 0 ? covered : undefined),
    },
  };
}

/**
 * The touches at the one boundary a spelling means, or null when it could
 * mean several. An exact match wins over a partial one, so
 * `POST /articles` picks the collection route and not the comments route
 * under it. Without a single exact match there is no way to choose, and
 * picking one silently could produce a report about a boundary the user
 * did not mean.
 */
function narrowedToOne(
  spec: string,
  matching: readonly TargetTouch[],
): TargetTouch[] | null {
  const labels = new Set(matching.map((touch) => touch.touched.label));
  if (labels.size === 1) {
    return [...matching];
  }
  const exact = matching.filter((touch) =>
    namesBoundaryExactly(spec, touch.touched.binding),
  );
  const exactLabels = new Set(exact.map((touch) => touch.touched.label));
  return exactLabels.size === 1 ? exact : null;
}

function boundaryMatches(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetTouch[] {
  return touchesOf(summaries).filter((touch) =>
    namesBoundary(spec, touch.touched.binding),
  );
}

/** The error for an ambiguous spelling: how many boundaries it could mean, and the first few labels. */
function ambiguousBoundaryMessage(
  spec: string,
  matching: readonly TargetTouch[],
): string {
  const candidates = [
    ...new Set(matching.map((touch) => touch.touched.label)),
  ].sort();
  const shown = candidates.slice(0, 6);
  const rest = candidates.length - shown.length;
  return `${spec} could mean ${candidates.length} boundaries here: ${shown.join(", ")}${rest === 0 ? "" : `, and ${rest} more`}. Ask about one of them.`;
}

/**
 * The ambiguity message when a boundary spelling matches more than one
 * boundary, using the same rules as `--at`. Returns null when the
 * spelling matches nothing or narrows to one, so `suss ask` only handles
 * the case its own answer would get wrong.
 */
export function ambiguousBoundarySpelling(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): string | null {
  const matching = boundaryMatches(spec, summaries);
  if (matching.length === 0 || narrowedToOne(spec, matching) !== null) {
    return null;
  }
  return ambiguousBoundaryMessage(spec, matching);
}

function boundaryTarget(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetResolution {
  const matching = boundaryMatches(spec, summaries);
  if (matching.length === 0) {
    return {
      matched: false,
      spelledAs: spec,
      message: `Nothing here is at ${spec}. ${spelledLike(boundariesHere(summaries))}`,
    };
  }

  const touches = narrowedToOne(spec, matching);
  if (touches === null) {
    return {
      matched: false,
      spelledAs: spec,
      message: ambiguousBoundaryMessage(spec, matching),
    };
  }

  const units = [...new Set(touches.map((touch) => touch.summary))];
  const labels = [...new Set(touches.map((touch) => touch.touched.label))];
  return {
    matched: true,
    target: {
      kind: "boundary",
      spelledAs: spec,
      detail: `${labels.join(", ")}, ${describeUnits(units)}`,
      summaries: units,
      transitionIds: [],
      touches,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * The summary files the caller could mean. Paths match on whole segments,
 * so `dao.ts` and `src/editions/dao.ts` both match
 * `/repo/src/editions/dao.ts`, and `ao.ts` matches nothing.
 */
export function filesMatching(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): string[] {
  const wanted = normalizePath(spec);
  if (wanted === "") {
    return [];
  }
  const files = new Set<string>();
  for (const summary of summaries) {
    const file = normalizePath(summary.location.file);
    if (endsWithSegments(file, wanted) || endsWithSegments(wanted, file)) {
      files.add(summary.location.file);
    }
  }
  return [...files].sort();
}

function normalizePath(spec: string): string {
  return spec.split(path.sep).join("/").replace(/^\.\//, "");
}

function endsWithSegments(whole: string, tail: string): boolean {
  return whole === tail || whole.endsWith(`/${tail}`);
}

/**
 * A spelling matches a whole summary id or a tail of it, so somebody who
 * saw `src/dao.ts::byPublication` in one report can type it against a run
 * whose ids start with a workspace. The tail is compared with the id
 * before its settling suffix, so `evaluate` matches the function of that
 * name and not every caller whose id ends in `#fn:...::evaluate`.
 */
function idMatches(spec: string, summary: BehavioralSummary): boolean {
  const id = summaryIdentifier(summary);
  if (id === spec) {
    return true;
  }
  const settledWith = settlingSuffix(summary);
  const wanted =
    settledWith !== "" && spec.endsWith(settledWith)
      ? spec.slice(0, -settledWith.length)
      : spec;
  return (
    isTailOf(wanted, unsettledSummaryId(summary)) ||
    isTailOf(wanted, summaryRef(summary))
  );
}

function isTailOf(spec: string, id: string): boolean {
  return id === spec || id.endsWith(`::${spec}`);
}

/** What one unit does at one boundary, printed as one line. */
export interface CollapsedTouch {
  boundary: string;
  unit: string;
  relations: Relation[];
  callee: string | undefined;
  /** The boundary the unit itself provides, when it provides one. */
  provides?: string;
  /** The calls from the unit the user asked about to this one, when there were any. */
  through?: string[];
}

/**
 * One entry per unit, boundary and call, with the relations merged onto
 * it. A call that both reads and writes would otherwise print as two
 * lines, and a reader would count two calls.
 */
export function collapseTouches(
  touches: ReadonlyArray<TargetTouch>,
): CollapsedTouch[] {
  const byPair = new Map<string, CollapsedTouch>();
  for (const { summary, touched, through } of touches) {
    const unit = summaryIdentifier(summary);
    const key = `${touched.label}\u0000${unit}\u0000${touched.callee ?? ""}`;
    const seen = byPair.get(key);
    if (seen === undefined) {
      const provides = providesKeyOf(summary);
      byPair.set(key, {
        boundary: touched.label,
        unit,
        relations: [touched.relation],
        callee: touched.callee,
        ...(provides !== undefined ? { provides } : {}),
        ...(through !== undefined ? { through } : {}),
      });
      continue;
    }

    if (!seen.relations.includes(touched.relation)) {
      seen.relations.push(touched.relation);
    }
  }
  return [...byPair.values()];
}

/**
 * What the given units do at every boundary they touch. For a boundary
 * target this list is wider than the target's own touches, which only
 * cover the boundary the user asked about.
 */
export function touchesOfUnits(
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetTouch[] {
  return touchesOf(summaries);
}

/**
 * The units that provide the boundary. A question about a boundary
 * follows calls out of these units only. A client of the boundary calls
 * into it, so what the client calls afterwards is not downstream of it.
 */
export function unitsServing(
  touches: ReadonlyArray<TargetTouch>,
): BehavioralSummary[] {
  return [
    ...new Set(
      touches
        .filter((touch) => touch.touched.relation === "provides")
        .map((touch) => touch.summary),
    ),
  ];
}

/**
 * The boundary key a provider unit serves on its own binding. Returns
 * undefined for any other unit, so an answer item can leave the field
 * out.
 */
export function providesKeyOf(summary: BehavioralSummary): string | undefined {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || BOUNDARY_ROLE[summary.kind] !== "provider") {
    return undefined;
  }
  return boundaryKey(binding) ?? undefined;
}

function touchesOf(
  summaries: ReadonlyArray<BehavioralSummary>,
  transitionIds?: ReadonlySet<string>,
): TargetTouch[] {
  return summaries.flatMap((summary) =>
    boundariesTouchedBy(summary, transitionIds).map((touched) => ({
      summary,
      touched,
    })),
  );
}

function describeUnits(summaries: ReadonlyArray<BehavioralSummary>): string {
  return `${summaries.length} summar${summaries.length === 1 ? "y" : "ies"}`;
}

function describeBranches(count: number): string {
  if (count === 0) {
    return "";
  }
  return `, ${count} branch${count === 1 ? "" : "es"} over that line`;
}

function boundariesHere(summaries: ReadonlyArray<BehavioralSummary>): string[] {
  const labels = new Set<string>();
  for (const summary of summaries) {
    for (const touched of boundariesTouchedBy(summary)) {
      labels.add(touched.label);
      if (labels.size === 3) {
        return [...labels];
      }
    }
  }
  return [...labels];
}

function spelledLike(examples: ReadonlyArray<string>): string {
  if (examples.length === 0) {
    return "These summaries describe nothing that could be pointed at.";
  }
  return `Things here are spelled like: ${examples.join(", ")}.`;
}
