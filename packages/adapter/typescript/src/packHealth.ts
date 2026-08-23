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

import type { DeclaredMatch } from "@suss/extractor";
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

  // A pack that recognises calls had its chance the moment some pack
  // walked a body in a file its gate selected. Matching nothing there
  // means either the library is installed and not usable yet, the way
  // a Prisma client is before it is generated, or the code calls it in
  // a shape the pack does not describe. The count only means something
  // when the gate resolved, since an unresolved gate has its own copy.
  if (funnel.recognizes && !funnel.discovers && gateSaysSomething) {
    stages.push({
      from: {
        name: "unit bodies to look inside",
        count: funnel.unitsInGatedFiles,
      },
      to: { name: "effects recognized", count: funnel.effectsRecognized },
      meaning:
        "its import gate found the library and it matched nothing in the bodies it saw",
    });
  }

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
      from: { name: "summaries bound", count: funnel.summariesBound },
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
          ? ` and on ${rest} ${rest === 1 ? "other file" : "other files"}`
          : "";
      return {
        label: funnel.pack,
        detail: `threw from ${first.hook} on ${first.file}${alsoIn}, so its counts below are a floor: ${first.message}`,
      };
    });
}

/**
 * What one pack paid for what it matches.
 *
 * Expressiveness is bought link by link, and #542 asks for the price to
 * be printed. A pack with every link written as data runs on any
 * adapter with the executor ops. A link written as a function runs only
 * where its own language does, and one that reads the syntax tree is
 * the floor. All three are allowed, and this says which is which.
 */
export interface PackGradient {
  pack: string;
  /** Links written as data, across every declaration. */
  dataLinks: number;
  /** Links written as a function, as "declaration.question". */
  functionLinks: string[];
  /** Links whose function reads the adapter's own syntax tree. */
  astLinks: string[];
  /** Declarations shipped without a line of code to run against them. */
  withoutExample: string[];
}

/** The gradient for every pack in a run that declared anything. */
export function packGradients(report: ExtractionReport): PackGradient[] {
  const gradients: PackGradient[] = [];
  for (const funnel of report.packs) {
    if (funnel.declarations === null) {
      continue;
    }
    gradients.push(gradientOf(funnel.pack, funnel.declarations.declarations));
  }
  return gradients;
}

function gradientOf(
  pack: string,
  declarations: ReadonlyArray<DeclaredMatch>,
): PackGradient {
  const gradient: PackGradient = {
    pack,
    dataLinks: 0,
    functionLinks: [],
    astLinks: [],
    withoutExample: [],
  };
  for (const declaration of declarations) {
    gradient.dataLinks += declaration.dataLinks;
    for (const question of declaration.functionLinks) {
      gradient.functionLinks.push(`${declaration.name}.${question}`);
    }
    for (const question of declaration.astLinks) {
      gradient.astLinks.push(`${declaration.name}.${question}`);
    }
    if (declaration.example === null) {
      gradient.withoutExample.push(declaration.name);
    }
  }
  return gradient;
}

/**
 * A declared pack wrote a link as a function.
 *
 * The function is the pack's own domain knowledge and it is meant to be
 * there. What the report adds is the price beside it, so a pack
 * drifting back towards a hand-rolled walk shows up while it happens.
 */
function opaqueLinks(
  gradients: ReadonlyArray<PackGradient>,
): HealthViolation[] {
  return gradients
    .filter((gradient) => gradient.functionLinks.length > 0)
    .map((gradient) => ({
      label: gradient.pack,
      detail: `${gradient.dataLinks} link(s) are data and ${gradient.functionLinks.length} written as a function: ${gradient.functionLinks.join(", ")}`,
    }));
}

/**
 * A declared pack reads the adapter's own syntax tree.
 *
 * Reaching the tree needs its own import, so a pack cannot arrive here
 * by accident. Saying so on every run is what keeps the escape rare.
 */
function reachesTheSyntaxTree(
  gradients: ReadonlyArray<PackGradient>,
): HealthViolation[] {
  return gradients
    .filter((gradient) => gradient.astLinks.length > 0)
    .map((gradient) => ({
      label: gradient.pack,
      detail: `reads the syntax tree at ${gradient.astLinks.join(", ")}, so those links run on this adapter alone`,
    }));
}

/**
 * A declaration ships without a line of code to run against it.
 *
 * An example the pack's tests run is documentation that fails when it
 * stops being true. A declaration without one documents nothing, and
 * nobody finds out when it stops matching.
 */
function undocumentedDeclarations(
  gradients: ReadonlyArray<PackGradient>,
): HealthViolation[] {
  return gradients
    .filter((gradient) => gradient.withoutExample.length > 0)
    .map((gradient) => ({
      label: gradient.pack,
      detail: `${gradient.withoutExample.join(", ")} state no example, so nothing runs when they stop matching`,
    }));
}

/**
 * Run every health check over one extraction report and return what
 * fired, grouped by which check caught it.
 */
export function evaluatePackHealth(report: ExtractionReport): HealthCheck[] {
  const gradients = packGradients(report);
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
    {
      name: "every link a declared pack states is data",
      whenBroken: "a declared pack wrote a link as a function",
      audience: "pack",
      violations: opaqueLinks(gradients),
    },
    {
      name: "no declared pack reads the syntax tree",
      whenBroken: "a declared pack reads the syntax tree",
      audience: "pack",
      violations: reachesTheSyntaxTree(gradients),
    },
    {
      name: "every declaration states an example",
      whenBroken: "a declaration states no example",
      audience: "pack",
      violations: undocumentedDeclarations(gradients),
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
