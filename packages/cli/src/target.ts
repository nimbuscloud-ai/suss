/**
 * One thing somebody can point at, and what it turns out to be.
 *
 * Four spellings, resolved in this order: a summary id, which is
 * anything with `::` in it; a file and a line, `src/dao.ts:43`; a file;
 * and a boundary, `dynamodb:editions#by-publication`. A file wins over
 * a boundary, so a path is never read as a boundary whose words happen
 * to line up.
 *
 * A spelling that matches nothing leaves the caller a sentence to
 * print. An empty report reads as agreement, and this is not that.
 */

import path from "node:path";

import { summaryIdentifier, summaryRef } from "@suss/behavioral-ir";

import {
  boundariesTouchedBy,
  namesBoundary,
  type TouchedBoundary,
} from "./boundaryReach.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export type TargetKind = "summary" | "file" | "line" | "boundary";

/** A unit the target picked out, and what it does at one boundary. */
export interface TargetTouch {
  summary: BehavioralSummary;
  touched: TouchedBoundary;
}

export interface ResolvedTarget {
  kind: TargetKind;
  /** What the caller typed. */
  spelledAs: string;
  /** What it turned out to be, as a report prints it. */
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

  // A package export boundary, `fn:@suss/checker::checkAll`, has the
  // same `::` in it as a summary id, so a spelling that matches no
  // summary is tried as a boundary before it is turned down.
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

  return boundaryTarget(spec, summaries);
}

// ---------------------------------------------------------------------------
// One spelling at a time
// ---------------------------------------------------------------------------

function summaryTarget(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetResolution {
  const matched = summaries.filter(
    (summary) =>
      idMatches(spec, summaryIdentifier(summary)) ||
      idMatches(spec, summaryRef(summary)),
  );
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

function boundaryTarget(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetResolution {
  const touches = touchesOf(summaries).filter((touch) =>
    namesBoundary(spec, touch.touched.binding),
  );
  if (touches.length === 0) {
    return {
      matched: false,
      spelledAs: spec,
      message: `Nothing here is at ${spec}. ${spelledLike(boundariesHere(summaries))}`,
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
 * The files these summaries came from that the caller could mean. Both
 * sides are compared as paths, so `dao.ts` and `src/editions/dao.ts`
 * both reach `/repo/src/editions/dao.ts`, and `ao.ts` reaches nothing.
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
 * A summary id matches the whole id or a tail of it, so somebody who
 * saw `src/dao.ts::byPublication` in one report can type it at a run
 * whose ids have a workspace in front.
 */
function idMatches(spec: string, id: string): boolean {
  return id === spec || id.endsWith(`::${spec}`);
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
