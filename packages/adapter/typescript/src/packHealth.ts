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
   * The short word this check reports under, kebab-case.
   *
   * It is the first column of every line the check prints, so a reader
   * works out what it means once and recognises it after that. `name`
   * is written as an assertion and would read backwards over a list of
   * things failing it.
   */
  code: string;
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
interface FunnelStage {
  from: { count: number; name: string };
  to: { count: number; name: string };
}

function stagesOf(funnel: PackFunnel): FunnelStage[] {
  const stages: FunnelStage[] = [];
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
      from: { count: funnel.unitsInGatedFiles, name: "unit bodies" },
      to: { count: funnel.effectsRecognized, name: "effects" },
    });
  }

  if (funnel.discovers && gateSaysSomething) {
    stages.push({
      from: { count: funnel.candidateFiles, name: "source files" },
      to: { count: funnel.unitsDiscovered, name: "units" },
    });
  }

  stages.push(
    {
      from: { count: funnel.unitsClaimed, name: "units" },
      to: { count: funnel.summariesBound, name: "summaries" },
    },
    {
      from: { count: funnel.summariesBound, name: "summaries" },
      to: { count: funnel.summariesWithBehavior, name: "transitions" },
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
        detail: `${stage.from.count} ${stage.from.name} -> 0 ${stage.to.name}`,
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
/**
 * A recognizer pack whose gate selected files, in a run where no pack
 * discovered a unit in any of them.
 *
 * A recognizer reads calls inside units other packs discover, so a run
 * with the recognizer alone walks nothing and writes nothing, and the
 * funnel's own drop check stays quiet because its first count is
 * already zero. Somebody who ran `-f prisma` on a working application
 * saw exactly that silence, and the missing pack is the one thing the
 * output did not say.
 */
function recognizersWithNoUnits(
  packs: ReadonlyArray<PackFunnel>,
): HealthViolation[] {
  return packs
    .filter(
      (funnel) =>
        funnel.recognizes &&
        !funnel.discovers &&
        funnel.gates.length > 0 &&
        funnel.unresolvedGates.length === 0 &&
        funnel.candidateFiles > 0 &&
        funnel.unitsInGatedFiles === 0 &&
        // The closure walks a recognizer-only pack's gated exports as
        // roots, so effects recognized there mean the run worked and
        // the missing framework pack costs attribution, not existence.
        funnel.effectsRecognized === 0,
    )
    .map((funnel) => ({
      label: funnel.pack,
      detail: `${funnel.candidateFiles} gated files, and no pack in this run discovered a unit in them. ${funnel.pack} reads calls inside units another pack finds, so add the pack that finds this project's handlers (-f express, -f fastify, ...), or run suss init to work out which.`,
    }));
}

function unversionedPacks(packs: ReadonlyArray<PackFunnel>): HealthViolation[] {
  return packs
    .filter((funnel) => funnel.version === null)
    .map((funnel) => ({
      label: funnel.pack,
      detail: "no version declared",
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
      detail: `${funnel.selfCollisions} ${funnel.selfCollisions === 1 ? "unit" : "units"} matched twice, second dropped`,
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
      const alsoIn = rest > 0 ? ` (+${rest} more)` : "";
      return {
        label: funnel.pack,
        detail: `${first.hook} on ${first.file}${alsoIn}: ${first.message}`,
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
      detail: `${gradient.functionLinks.join(", ")} (${gradient.dataLinks} data)`,
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
      detail: gradient.astLinks.join(", "),
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
      detail: gradient.withoutExample.join(", "),
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
      code: "threw",
      audience: "run",
      violations: threwWhileReading(report.packs),
    },
    {
      name: "no pack finds something and records nothing",
      code: "no-output",
      audience: "run",
      violations: funnelDrops(report.packs),
    },
    {
      name: "no pack collides with itself",
      code: "double-match",
      audience: "run",
      violations: selfCollisions(report.packs),
    },
    {
      name: "every recognizer had units to look inside",
      code: "no-units",
      audience: "run",
      violations: recognizersWithNoUnits(report.packs),
    },
    {
      name: "every pack declares a version",
      code: "no-version",
      audience: "pack",
      violations: unversionedPacks(report.packs),
    },
    {
      name: "every link a declared pack states is data",
      code: "fn-link",
      audience: "pack",
      violations: opaqueLinks(gradients),
    },
    {
      name: "no declared pack reads the syntax tree",
      code: "ast-link",
      audience: "pack",
      violations: reachesTheSyntaxTree(gradients),
    },
    {
      name: "every declaration states an example",
      code: "no-example",
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

  const rows = fired.flatMap((check) =>
    check.violations.map((violation) => ({
      code: check.code,
      pack: violation.label,
      detail: violation.detail,
    })),
  );
  const codeWidth = Math.max(...rows.map((row) => row.code.length));
  const packWidth = Math.max(...rows.map((row) => row.pack.length));

  const lines = ["", `Pack health (${rows.length}):`];
  for (const row of rows) {
    lines.push(
      `  ${row.code.padEnd(codeWidth)}  ${row.pack.padEnd(packWidth)}  ${row.detail}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
