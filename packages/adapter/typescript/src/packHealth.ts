// packHealth.ts — when a pack is probably not working.
//
// The funnel says where a run's counts reached zero. This asks a
// narrower question of each pack on its own: did this pack drop
// everything it was holding at some stage, having been holding
// something the stage before?
//
// One rule covers most of it. A pack that finds nothing on a codebase
// that does not use its library is working correctly, so a bare count
// of zero is never the signal. What makes zero a signal is the count
// before it. The pack's own import gate selecting forty files and its
// discovery finding no unit in any of them is the pack saying "look
// here" and then failing to look. The same shape repeats one stage
// later, and again one stage after that, which is why the checks below
// are one function applied to adjacent pairs rather than a check per
// stage.
//
// Everything here reports. Nothing here fails a run, because a
// threshold nobody has watched fire is a threshold nobody should be
// blocked by.

import type { ExtractionReport, PackFunnel } from "./diagnostics.js";

/** One thing that looks wrong, in the same shape the dogfood invariants report. */
export interface HealthViolation {
  label: string;
  detail: string;
}

export interface HealthCheck {
  name: string;
  violations: HealthViolation[];
}

/**
 * A pack's funnel, as the ordered stages a health check walks.
 *
 * `discovery` is only comparable against `candidateFiles` when the pack
 * gated itself, since an ungated pack is handed every file in the
 * project and so its candidate count says nothing about whether the
 * project uses it.
 */
function stagesOf(funnel: PackFunnel): Array<{
  from: { name: string; count: number };
  to: { name: string; count: number };
  meaning: string;
}> {
  const stages = [];

  if (
    funnel.discovers &&
    funnel.gates.length > 0 &&
    funnel.unresolvedGates.length === 0
  ) {
    stages.push({
      from: { name: "candidate files", count: funnel.candidateFiles },
      to: { name: "units discovered", count: funnel.unitsDiscovered },
      meaning:
        "its import gate selected files and discovery matched nothing in them",
    });
  }

  stages.push(
    {
      from: { name: "units claimed", count: funnel.unitsClaimed },
      to: { name: "summaries bound", count: funnel.summariesBound },
      meaning: "it recognised units and bound none of them to a boundary",
    },
    {
      from: { name: "provider summaries", count: funnel.providerSummaries },
      to: {
        name: "summaries with behavior",
        count: funnel.summariesWithBehavior,
      },
      meaning: "every summary it produced is empty of transitions",
    },
  );

  return stages;
}

/**
 * A stage went to zero while the stage feeding it did not.
 *
 * This is heuristics 1 through 4 of the original list, which turned out
 * to be one property stated at four points along the same pipeline.
 */
function funnelDrops(packs: ReadonlyArray<PackFunnel>): HealthViolation[] {
  const violations: HealthViolation[] = [];
  for (const funnel of packs) {
    for (const stage of stagesOf(funnel)) {
      if (stage.from.count === 0 || stage.to.count > 0) {
        continue;
      }
      violations.push({
        label: funnel.pack,
        detail: `${stage.meaning} (${stage.from.count} ${stage.from.name}, 0 ${stage.to.name})`,
      });
    }
  }
  return violations;
}

/**
 * A pack declares no version.
 *
 * The extraction cache keys on the pack's name and version together. A
 * pack that never stamps a version is indistinguishable from every
 * earlier build of itself, so editing it and re-running answers from
 * the cache written by the code that was there before.
 *
 * This is the one check that needs no codebase to be true or false, and
 * the one that costs a pack author something: it asks for a field.
 */
function unversionedPacks(packs: ReadonlyArray<PackFunnel>): HealthViolation[] {
  return packs
    .filter((funnel) => funnel.version === null)
    .map((funnel) => ({
      label: funnel.pack,
      detail:
        "declares no version, so a cache entry cannot tell its builds apart",
    }));
}

/**
 * A pack discovered the same unit twice.
 *
 * Two packs claiming one unit is the point of the claim set and the
 * user's `-f` order decides it. One pack claiming a unit twice means
 * two of its own patterns overlap, and the second is dropped with
 * nobody choosing which of the two readings was wanted.
 */
function selfCollisions(packs: ReadonlyArray<PackFunnel>): HealthViolation[] {
  return packs
    .filter((funnel) => funnel.selfCollisions > 0)
    .map((funnel) => ({
      label: funnel.pack,
      detail: `discovered ${funnel.selfCollisions} unit(s) twice over, so two of its own patterns overlap`,
    }));
}

/**
 * Run every health check over one extraction report and return what
 * fired, grouped by which check caught it.
 */
export function evaluatePackHealth(report: ExtractionReport): HealthCheck[] {
  return [
    {
      name: "no pack drops everything it was holding",
      violations: funnelDrops(report.packs),
    },
    {
      name: "no pack collides with itself",
      violations: selfCollisions(report.packs),
    },
    {
      name: "every pack declares a version",
      violations: unversionedPacks(report.packs),
    },
  ];
}

/** The health checks that fired, as lines for a terminal. */
export function formatPackHealth(checks: ReadonlyArray<HealthCheck>): string {
  const fired = checks.filter((check) => check.violations.length > 0);
  if (fired.length === 0) {
    return "";
  }

  const lines = ["", "Pack health:"];
  for (const check of fired) {
    lines.push(`  ${check.name}`);
    for (const violation of check.violations) {
      lines.push(`    ${violation.label}: ${violation.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
