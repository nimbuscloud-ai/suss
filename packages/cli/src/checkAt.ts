/**
 * `suss check --at`: the findings for one thing.
 *
 * The run is the same run. `checkDirectory` reads the folder and every
 * pass looks at every summary, exactly as a full check does, and what
 * changes is how much of the result gets printed. So a scoped answer
 * cannot disagree with the full one, and there is no second checker to
 * keep in step.
 *
 * A target with a gap on it says so. "No findings here" means less when
 * part of the unit could not be read, and a reader who is not told that
 * will take the quiet for agreement.
 */

import { summaryIdentifier, summaryRef } from "@suss/behavioral-ir";

import { namesBoundary, spellingTokens } from "./boundaryReach.js";
import {
  type CheckedDirectory,
  checkDirectory,
  type FailOn,
  meetsThreshold,
  renderFindings,
  writeReport,
} from "./check.js";
import { type ResolvedTarget, resolveTarget } from "./target.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";
import type { CheckAllResult, ComparedPair } from "@suss/checker";

export interface CheckAtOptions {
  dir: string;
  /** The file, file and line, boundary, or summary id to report on. */
  at: string;
  json?: boolean;
  output?: string;
  failOn?: FailOn;
  sussignore?: string;
  noSuppressions?: boolean;
}

export interface CheckAtResult {
  findings: Finding[];
  /** False when the target picked out nothing at all. */
  matched: boolean;
  hasErrors: boolean;
}

/** What one unit records that suss could not read. */
interface UnitGaps {
  summary: string;
  records: string[];
}

interface ScopedView {
  findings: Finding[];
  pairs: ComparedPair[];
  unmatched: CheckAllResult["unmatched"];
  gaps: UnitGaps[];
}

export function checkAt(options: CheckAtOptions): CheckAtResult {
  const checked = checkDirectory(options);
  const resolution = resolveTarget(options.at, checked.summaries);

  if (!resolution.matched) {
    const rendered = options.json
      ? `${JSON.stringify({ at: options.at, matched: false, message: resolution.message }, null, 2)}\n`
      : `${resolution.message}\n`;
    writeReport(rendered, options.output);
    // A target nobody can find is not a pass. Exiting zero here would
    // read as "checked, and it agreed".
    return { findings: [], matched: false, hasErrors: true };
  }

  const target = resolution.target;
  const view = scopeTo(target, checked);
  const rendered = options.json
    ? `${JSON.stringify(asJson(target, view), null, 2)}\n`
    : renderScoped(target, view, checked);
  writeReport(rendered, options.output);

  return {
    findings: view.findings,
    matched: true,
    hasErrors: meetsThreshold(view.findings, options.failOn ?? "error"),
  };
}

// ---------------------------------------------------------------------------
// Narrowing the run to the target
// ---------------------------------------------------------------------------

function scopeTo(
  target: ResolvedTarget,
  checked: CheckedDirectory,
): ScopedView {
  const ids = new Set(target.summaries.map((s) => summaryIdentifier(s)));
  const refs = new Set<string>(target.summaries.map((s) => summaryRef(s)));
  const { result } = checked;

  const keyed = (key: string | null): boolean =>
    key !== null && spellingCovers(target.spelledAs, key);
  const pairInScope = (pair: ComparedPair): boolean =>
    target.kind === "boundary"
      ? keyed(pair.key)
      : ids.has(pair.provider) || ids.has(pair.consumer);
  const listed = <T extends { id: string; key: string | null }>(
    entries: ReadonlyArray<T>,
  ): T[] =>
    entries.filter((entry) =>
      target.kind === "boundary" ? keyed(entry.key) : ids.has(entry.id),
    );

  return {
    findings: result.findings.filter((f) => findingInScope(f, target, refs)),
    pairs: result.pairs.filter(pairInScope),
    unmatched: {
      providers: listed(result.unmatched.providers),
      consumers: listed(result.unmatched.consumers),
      unpairable: listed(result.unmatched.unpairable),
    },
    gaps: gapsOn(target.summaries),
  };
}

/**
 * A finding about a boundary belongs to that boundary's report. A
 * finding about a unit belongs to the unit's, and when the target gave
 * a line, only to the branches that line falls in: a status the rest of
 * the function returns is not what somebody pointing at line 43 asked
 * about.
 */
function findingInScope(
  finding: Finding,
  target: ResolvedTarget,
  refs: ReadonlySet<string>,
): boolean {
  if (target.kind === "boundary") {
    return namesBoundary(target.spelledAs, finding.boundary);
  }

  const sides = [finding.provider, finding.consumer].filter((side) =>
    refs.has(side.summary),
  );
  if (sides.length === 0) {
    return false;
  }
  if (target.kind !== "line" || target.transitionIds.length === 0) {
    return true;
  }

  const covered = new Set(target.transitionIds);
  return sides.some(
    (side) => side.transitionId === undefined || covered.has(side.transitionId),
  );
}

/** Whether a key a pass wrote is the boundary somebody asked about. */
function spellingCovers(subject: string, key: string): boolean {
  const wanted = spellingTokens(subject);
  if (wanted.length === 0) {
    return false;
  }
  const tokens = new Set(spellingTokens(key));
  return wanted.every((token) => tokens.has(token));
}

function gapsOn(summaries: ReadonlyArray<BehavioralSummary>): UnitGaps[] {
  return summaries
    .filter((summary) => summary.gaps.length > 0)
    .map((summary) => ({
      summary: summaryIdentifier(summary),
      records: summary.gaps.map((gap) => gap.description),
    }));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function asJson(target: ResolvedTarget, view: ScopedView): unknown {
  return {
    at: target.spelledAs,
    matched: true,
    target: {
      kind: target.kind,
      detail: target.detail,
      summaries: target.summaries.map((s) => summaryIdentifier(s)),
      transitions: target.transitionIds,
    },
    touches: target.touches.map((touch) => ({
      boundary: touch.touched.label,
      relation: touch.touched.relation,
      unit: summaryIdentifier(touch.summary),
      ...(touch.touched.callee !== undefined
        ? { via: touch.touched.callee }
        : {}),
    })),
    findings: view.findings,
    pairs: view.pairs,
    unmatched: view.unmatched,
    gaps: view.gaps,
  };
}

const WHY_UNPAIRED: Record<string, string> = {
  noBoundary: "internal code, so nothing pairs with it",
  unnamedBoundary: "its boundary has no name to pair on",
  unknownKind: "its kind is one this version does not know",
};

function renderScoped(
  target: ResolvedTarget,
  view: ScopedView,
  checked: CheckedDirectory,
): string {
  const lines = [`${target.spelledAs} (${target.detail})`];

  const touches = renderTouches(target);
  if (touches.length > 0) {
    lines.push("", "What it touches:", ...touches);
  }

  const compared = renderCompared(view.pairs);
  lines.push(
    "",
    ...(compared.length > 0 ? compared : ["Nothing was compared here."]),
  );

  const unpaired = renderUnpaired(view);
  if (unpaired.length > 0) {
    lines.push("", ...unpaired);
  }

  if (view.findings.length > 0) {
    lines.push("", renderFindings(view.findings, checked.confidence).trimEnd());
  } else {
    lines.push("", "No findings here.");
  }

  if (view.gaps.length > 0) {
    lines.push("", ...renderGaps(view.gaps));
  }

  return `${lines.join("\n")}\n`;
}

/** Each boundary the target touches, and which unit does what at it. */
function renderTouches(target: ResolvedTarget): string[] {
  const byBoundary = new Map<string, string[]>();
  for (const { summary, touched } of target.touches) {
    const via = touched.callee !== undefined ? `  via ${touched.callee}` : "";
    const line = `    ${touched.relation.padEnd(8)} ${summaryIdentifier(summary)}${via}`;
    const lines = byBoundary.get(touched.label) ?? [];
    if (!lines.includes(line)) {
      lines.push(line);
    }
    byBoundary.set(touched.label, lines);
  }

  const rendered: string[] = [];
  for (const [label, lines] of byBoundary) {
    rendered.push(`  ${label}`, ...lines);
  }
  return rendered;
}

function renderCompared(pairs: ReadonlyArray<ComparedPair>): string[] {
  if (pairs.length === 0) {
    return [];
  }
  const byKey = new Map<string, string[]>();
  for (const pair of pairs) {
    const sides = byKey.get(pair.key) ?? [];
    const line = `    ${pair.provider} <-> ${pair.consumer}`;
    if (!sides.includes(line)) {
      sides.push(line);
    }
    byKey.set(pair.key, sides);
  }

  const lines = [
    `Compared ${byKey.size} boundar${byKey.size === 1 ? "y" : "ies"} here:`,
  ];
  for (const [key, sides] of byKey) {
    lines.push(`  ${key}`, ...sides);
  }
  return lines;
}

function renderUnpaired(view: ScopedView): string[] {
  const lines: string[] = [];
  for (const provider of view.unmatched.providers) {
    lines.push(`  ${provider.id}: no client to compare against`);
  }
  for (const consumer of view.unmatched.consumers) {
    lines.push(`  ${consumer.id}: no provider to compare against`);
  }
  for (const entry of view.unmatched.unpairable) {
    lines.push(
      `  ${entry.id}: ${WHY_UNPAIRED[entry.reason] ?? "nothing pairs with it"}`,
    );
  }
  if (lines.length === 0) {
    return [];
  }
  return ["Went unchecked:", ...lines];
}

function renderGaps(gaps: ReadonlyArray<UnitGaps>): string[] {
  const total = gaps.reduce((sum, unit) => sum + unit.records.length, 0);
  const lines = [
    `${total} thing${total === 1 ? "" : "s"} here suss could not read, so what it knows about this target is partial:`,
  ];
  for (const unit of gaps) {
    lines.push(`  ${unit.summary}`);
    for (const record of unit.records) {
      lines.push(`    ${record}`);
    }
  }
  return lines;
}
