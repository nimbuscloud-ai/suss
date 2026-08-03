// packHealth.ts: when a pack is probably not working.
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
// here" and then failing to look. The same shape repeats at every
// later stage, which is why the checks below are one comparison
// applied to a list of pairs rather than a check written per stage.
//
// Everything here reports. Nothing here fails a run, because a
// threshold nobody has watched fire is a threshold nobody should be
// blocked by. That also means one count above zero anywhere silences
// the pair holding it, which the notes next to `stagesOf` say more
// about.

import type {
  ExtractionReport,
  PackFailure,
  PackFunnel,
} from "./diagnostics.js";

/** One thing that looks wrong, in the same shape the dogfood invariants report. */
export interface HealthViolation {
  label: string;
  detail: string;
}

export interface HealthCheck {
  /** The property, as something that either holds or does not. */
  name: string;
  /**
   * The heading printed when this check finds something.
   *
   * The property reads as an assertion, so printing `name` above the
   * violations of it says "no pack collides with itself" and then lists
   * a pack colliding with itself.
   */
  whenBroken: string;
  /**
   * Who the finding is addressed to.
   *
   * A `run` check found something about the code in front of it, and
   * the person who started the run can do something about it: drop a
   * pack, install a dependency, open an issue with the file that
   * broke. A `pack` check found something about how a pack was built,
   * which only whoever ships that pack can fix. Printing the second
   * kind on every run would teach people to skim past the first.
   */
  audience: "run" | "pack";
  violations: HealthViolation[];
}

/**
 * A pack's funnel, as the ordered stages a health check walks.
 *
 * The discovery pair comes first, and it is comparable only when the
 * pack gated itself: an ungated pack is handed every file in the
 * project, so its candidate count says only that the project has files.
 *
 * Every count compared here is the pack's own work. That rules out the
 * one thing a pack made of recognisers could be measured against,
 * because a recogniser fires inside units some other pack discovered,
 * so any count of what it had to look at is a count of what its
 * companions found. Measuring against it made the same pack read as
 * working or broken depending on which unrelated pack was passed
 * alongside it. Those packs are counted, in `effectsRecognized`, and
 * not judged.
 */
function stagesOf(funnel: PackFunnel): Array<{
  from: { name: string; count: number };
  to: { name: string; count: number };
  meaning: string;
}> {
  const stages = [];
  const gateSaysSomething =
    funnel.gates.length > 0 && funnel.unresolvedGates.length === 0;

  if (funnel.discovers && gateSaysSomething) {
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
      meaning: "it claimed units and turned none of them into a bound summary",
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

/** A stage went to zero while the stage feeding it did not. */
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
 * A pack's hook threw while it was reading.
 *
 * The run carries on so one bad file does not cost a whole extract, and
 * the pack's counts stop being totals the moment that happens. This
 * says so, because a pack that broke on every file it was handed
 * reports the same zero as a pack that looked and found nothing.
 *
 * This is the one check whose finding is never about the codebase. The
 * pack is at fault, and the person running it is told anyway, since
 * their numbers are the ones that came out short.
 */
function threwWhileReading(
  packs: ReadonlyArray<PackFunnel>,
): HealthViolation[] {
  return packs
    .filter((funnel) => funnel.failures.length > 0)
    .map((funnel) => {
      const first = funnel.failures[0] as PackFailure;
      const rest = funnel.failures.length - 1;
      const alsoIn =
        rest > 0
          ? ` and on ${rest} other ${rest === 1 ? "file" : "files"}`
          : "";
      return {
        label: funnel.pack,
        detail: `threw from ${first.hook} on ${first.file}${alsoIn}, so its counts below are a floor: ${first.message}`,
      };
    });
}

/**
 * Run every health check over one extraction report and return what
 * fired, grouped by which check caught it.
 */
export function evaluatePackHealth(report: ExtractionReport): HealthCheck[] {
  return [
    {
      name: "no pack throws while it reads",
      whenBroken: "a pack threw while it was reading",
      audience: "run",
      violations: threwWhileReading(report.packs),
    },
    {
      name: "no pack drops everything it was holding",
      whenBroken: "a pack dropped everything it was holding",
      audience: "run",
      violations: funnelDrops(report.packs),
    },
    {
      name: "no pack collides with itself",
      whenBroken: "a pack collided with itself",
      audience: "run",
      violations: selfCollisions(report.packs),
    },
    {
      name: "every pack declares a version",
      whenBroken: "a pack declares no version",
      audience: "pack",
      violations: unversionedPacks(report.packs),
    },
  ];
}

/**
 * The health checks that fired, as lines for a terminal.
 *
 * `audiences` is who the caller is printing for, and it is required
 * because there is no answer that suits every caller: a CLI run prints
 * what the person who started it can act on, and a run whose reader is
 * a pack author wants both.
 */
export function formatPackHealth(
  checks: ReadonlyArray<HealthCheck>,
  audiences: ReadonlyArray<HealthCheck["audience"]>,
): string {
  const fired = checks.filter(
    (check) =>
      check.violations.length > 0 && audiences.includes(check.audience),
  );
  if (fired.length === 0) {
    return "";
  }

  const lines = ["", "Pack health:"];
  for (const check of fired) {
    lines.push(`  ${check.whenBroken}`);
    for (const violation of check.violations) {
      lines.push(`    ${violation.label}: ${violation.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
