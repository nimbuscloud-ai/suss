/**
 * Checks that tell you a pack is probably not working.
 *
 * The funnel shows where a run's counts dropped to zero. These checks
 * ask something narrower of each pack on its own: did this pack lose
 * everything at some stage, when the stage before it had something?
 *
 * A pack that finds nothing in a codebase that does not use its library
 * is working correctly, so a count of zero on its own is never the
 * signal. What makes zero a signal is the count before it. A pack whose
 * import gate picked forty files and whose discovery then found no unit
 * in any of them said "look here" and failed to look. Every later stage
 * works the same way, which is why these checks are one comparison run
 * over a list of pairs rather than one check written per stage.
 */

import type {
  ExtractionReport,
  PackFailure,
  PackFunnel,
} from "./diagnostics.js";

/** One thing that looks wrong, reported the way the dogfood invariants are. */
export interface HealthViolation {
  label: string;
  detail: string;
}

export interface HealthCheck {
  /** The property being checked, as something either true or false. */
  name: string;
  /**
   * The heading printed when this check finds something.
   *
   * `name` is written as an assertion, so printing it above the
   * violations would say "no pack collides with itself" and then list a
   * pack colliding with itself.
   */
  whenBroken: string;
  /**
   * Who the finding is addressed to.
   *
   * A `run` check found something about the code in front of it, and
   * the person who started the run can do something about it: drop a
   * pack, install a dependency, open an issue with the file that broke.
   * A `pack` check found something about how a pack was built, which
   * only whoever ships that pack can fix. Printing the second kind on
   * every run would teach people to skim past the first.
   */
  audience: "run" | "pack";
  violations: HealthViolation[];
}

/**
 * A pack's funnel, as the ordered stages a health check walks.
 *
 * The discovery pair comes first, and it only means something when the
 * pack gated itself: an ungated pack is handed every file in the
 * project, so its candidate count only tells you the project has files.
 *
 * Every count compared here is the pack's own work, which is why a pack
 * made only of recognisers is counted and never judged. A recogniser
 * fires inside units some other pack discovered, so any count of what it
 * had to look at is really a count of what the packs beside it found.
 * Measuring against that made the same pack look working or broken
 * depending on which unrelated pack was passed alongside it.
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

/** A stage dropped to zero while the stage feeding it did not. */
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
 * pack that never stamps a version looks identical to every earlier
 * build of itself, so editing it and re-running gives you back what the
 * code that was there before produced.
 *
 * This is the one check that needs no codebase to decide, and the one
 * that costs a pack author something: it asks for a field.
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
 * Two packs claiming one unit is the point of the claim set, and the
 * user's `-f` order decides it. One pack claiming a unit twice means two
 * of its own patterns overlap, and the second is dropped without anybody
 * choosing which of the two was wanted.
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
 * The run continues so that one bad file does not cost a whole extract,
 * and the pack's counts stop being totals the moment that happens. This
 * check says so, because a pack that broke on every file it was given
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
 * `audiences` is who the caller is printing for. It is required because
 * no single choice suits every caller: a CLI run prints what the person
 * who started it can act on, while a run a pack author is reading wants
 * both kinds.
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
