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
 * works the same way, so the check is one comparison run over a list of
 * stage pairs instead of one check written per stage.
 */

import type {
  ExtractionReport,
  PackFailure,
  PackFunnel,
} from "./extractionReport.js";
import type { DeclaredMatch } from "./framework.js";

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
 * The discovery pair only means something when the pack gated itself: an
 * ungated pack is handed every file in the project, so its candidate
 * count only says the project has files.
 */
interface FunnelStage {
  from: { count: number; name: string };
  to: { count: number; name: string };
}

function stagesOf(funnel: PackFunnel): FunnelStage[] {
  const stages: FunnelStage[] = [];
  const gateSaysSomething =
    funnel.gates.length > 0 && funnel.unresolvedGates.length === 0;

  // A recogniser had its chance once any pack walked a body in a gated file.
  // Matching nothing then means the library is not usable yet, as with an
  // ungenerated Prisma client, or the pack does not describe how it is called.
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
 * A recognizer pack whose gate selected files, in a run where no pack
 * discovered a unit in any of them.
 *
 * A recognizer reads calls inside units other packs discover, so a run
 * with the recognizer alone walks nothing and writes nothing, and the
 * funnel's own drop check stays quiet because its first count is
 * already zero. Running `-f prisma` alone on a working application
 * gives that silence, and this check says which pack is missing.
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
        // roots, so effects recognized there mean the run worked and only
        // the framework pack's attribution is missing.
        funnel.effectsRecognized === 0,
    )
    .map((funnel) => ({
      label: funnel.pack,
      detail: `${funnel.candidateFiles} gated files, and no pack in this run discovered a unit in them. ${funnel.pack} reads calls inside units another pack finds, so add the pack that finds this project's handlers (-f express, -f fastify, ...), or run suss init to work out which.`,
    }));
}

/**
 * The pack's library is installed and no file in the run reaches it.
 *
 * Every later count starts at zero, so no other check has anything to
 * compare, and the run says nothing at all about the pack somebody
 * asked for. The gate follows imports through a project's own modules,
 * so either the code does not use the library or it reaches it in a way
 * the gate cannot follow.
 */
function gatedPacksWithNoFiles(
  packs: ReadonlyArray<PackFunnel>,
): HealthViolation[] {
  return packs
    .filter(
      (funnel) =>
        funnel.gates.length > 0 &&
        funnel.unresolvedGates.length === 0 &&
        funnel.candidateFiles === 0,
    )
    .map((funnel) => ({
      label: funnel.pack,
      detail: `${funnel.gates.join(", ")} is installed and no file in this run imports it, directly or through a module of the project's own. Either this code does not use the library, or it reaches it some way the import gate does not follow.`,
    }));
}

/**
 * A registration helper the config asked for that no call matched.
 *
 * The routes that helper registers are missing, and nothing else in
 * the run says so: the pack's own counts come out the same as they
 * would for a project with no helpers at all.
 */
function helpersThatMatchedNothing(
  packs: ReadonlyArray<PackFunnel>,
): HealthViolation[] {
  return packs.flatMap((funnel) =>
    funnel.helpersUnmatched.map((helper) => ({
      label: funnel.pack,
      detail: `${helper} matched no call in this run, so whatever it registers is missing. suss read that helper out of the project and then failed to match a call to it, which is a bug in suss rather than in your code.`,
    })),
  );
}

/**
 * A pack declares no version.
 *
 * The extraction cache keys on the pack's name and version together. A
 * pack that never stamps a version looks identical to every earlier
 * build of itself, so after editing it a re-run returns what the old
 * code produced.
 */
function unversionedPacks(packs: ReadonlyArray<PackFunnel>): HealthViolation[] {
  return packs
    .filter((funnel) => funnel.version === null)
    .map((funnel) => ({
      label: funnel.pack,
      detail: "no version declared",
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
 * The pack is at fault, but the finding goes to the person running it,
 * since their numbers are the ones that came out short.
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
 * How much of one pack is data and how much is code (#542).
 *
 * A pack with every link written as data runs on any adapter with the
 * executor ops. A link written as a function runs only where its own
 * language does, and one that reads the syntax tree runs only on the
 * adapter whose tree it reads. All three are allowed, and this counts
 * each kind.
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
 * A function link is allowed. Reporting it beside the count of data
 * links shows a pack drifting back towards a hand-rolled walk while it
 * happens.
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
 * Reaching the tree needs its own import, so a pack cannot do it by
 * accident. Reporting every such link keeps the escape rare.
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
      name: "every pack whose library is installed had files to read",
      code: "no-files",
      audience: "run",
      violations: gatedPacksWithNoFiles(report.packs),
    },
    {
      name: "every recognizer had units to look inside",
      code: "no-units",
      audience: "run",
      violations: recognizersWithNoUnits(report.packs),
    },
    {
      name: "every registration helper the run read matched a call",
      code: "no-helper",
      audience: "run",
      violations: helpersThatMatchedNothing(report.packs),
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
