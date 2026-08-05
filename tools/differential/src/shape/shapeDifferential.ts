// shapeDifferential.ts: run every oracle against one generated shape.
//
// Three oracles, and each catches something the others cannot:
//
// - execution: the program runs, and a transition whose conditions hold
//   promised a different status than the one observed.
// - invariants: the summary set is wrong on its own terms, whatever the
//   program does (nothing said at high confidence, two summaries on one
//   identity, a boundary with no key).
// - equivalence: the same behavior written the plainest way produced a
//   different summary. A spelling that loses a claim is invisible to
//   the other two, because the program still runs and the summary that
//   survives is well-formed.

import { apolloFramework } from "@suss/framework-apollo";
import {
  awsLambdaFramework,
  clearTemplateCache,
} from "@suss/framework-aws-lambda";
import { sqsFramework } from "@suss/framework-aws-sqs";
import { expressFramework } from "@suss/framework-express";
import { nestjsGraphqlFramework } from "@suss/framework-nestjs-graphql";
import { nodeRuntimePack } from "@suss/runtime-node";

import { judgeObservation } from "../differential.js";
import { executeHandler } from "../execute.js";
import { extractAllSummaries, extractFromDisk } from "../extract.js";
import { requestBattery } from "../requests.js";
import {
  type AnnounceShapeSpec,
  renderAnnounceShape,
  SIMPLEST_ANNOUNCEMENT,
} from "./announceShape.js";
import {
  type ComponentShapeSpec,
  renderComponentShape,
  SIMPLEST_COMPONENT_SHAPE,
} from "./componentShape.js";
import {
  type EnvShapeSpec,
  renderEnvShape,
  SIMPLEST_ENV_SHAPE,
} from "./envShape.js";
import { summarySetDifferences } from "./equivalence.js";
import { checkInvariants } from "./invariants.js";
import { REACH_PATHS_FROM_A_CALLER } from "./knownBugs.js";
import {
  type PackageShapeSpec,
  type RenderedPackageShape,
  renderPackageShape,
  writePackageShape,
} from "./packageShape.js";
import {
  PRODUCER_HANDLER_PACK,
  type ProducerShapeSpec,
  renderProducerShape,
  SIMPLEST_PRODUCER_SHAPE,
} from "./producerShape.js";
import {
  type QueueShapeSpec,
  type RenderedQueueShape,
  renderQueueShape,
  SIMPLEST_QUEUE_SHAPE,
  writeQueueShape,
} from "./queueShape.js";
import {
  type ApolloResolverSpec,
  type NestResolverSpec,
  type RenderedResolverShape,
  renderApolloResolverShape,
  renderNestResolverShape,
  SIMPLEST_APOLLO_RESOLVER,
  SIMPLEST_NEST_RESOLVER,
} from "./resolverShape.js";
import { renderShape, type ShapeSpec, SIMPLEST_SHAPE } from "./shapeProgram.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { GeneratedRequest } from "../requests.js";
import type { ShapeExpectation } from "./invariants.js";
import type { WideTypeSize } from "./shapeProgram.js";
import type { ShapeTarget } from "./shapeTargets.js";

export type Oracle = "execution" | "invariant" | "equivalence";

export interface ShapeFinding {
  oracle: Oracle;
  detail: string;
}

export interface ShapeHarnessFailure {
  request: GeneratedRequest;
  message: string;
}

export interface ShapeResult {
  spec:
    | ShapeSpec
    | ComponentShapeSpec
    | AnnounceShapeSpec
    | EnvShapeSpec
    | ApolloResolverSpec
    | NestResolverSpec
    | QueueShapeSpec
    | PackageShapeSpec
    | ProducerShapeSpec;
  /** The dimension values this shape was drawn at, for the failure line. */
  label: string;
  files: Record<string, string>;
  baselineFiles: Record<string, string>;
  summaries: BehavioralSummary[];
  findings: ShapeFinding[];
  harnessFailures: ShapeHarnessFailure[];
  requestsRun: number;
}

/** Kept small: the risk a wide type carries is breadth, not size on disk. */
export const WIDE_TYPE_SIZE: WideTypeSize = { width: 10, depth: 4 };

/** The plainest spelling of the same behavior. */
export function baselineOf(spec: ShapeSpec): ShapeSpec {
  return { ...SIMPLEST_SHAPE, result: spec.result, body: spec.body };
}

const sameShape = (left: ShapeSpec, right: ShapeSpec): boolean =>
  left.form === right.form &&
  left.binding === right.binding &&
  left.reach === right.reach &&
  left.result === right.result;

const EXPECTATION: Omit<ShapeExpectation, "kind"> = {
  boundaryCount: 1,
  unitName: null,
};

const handlerComesFromACaller = (spec: ShapeSpec): boolean =>
  (REACH_PATHS_FROM_A_CALLER as readonly string[]).includes(spec.reach);

/**
 * Where the summaries fall short of what a route registered with a
 * handler nobody here can follow should say: the route is a fact about
 * the code, so the boundary is there, and the handler is a limit on the
 * reading, so the summary says nothing about behaviour and says why.
 * Silence on any of the three is what this is watching for.
 */
function unreadHandlerComplaints(
  baseline: BehavioralSummary[],
  summaries: BehavioralSummary[],
): string[] {
  const handlers = summaries.filter((summary) => summary.kind === "handler");
  if (handlers.length !== 1) {
    return [
      `summaries.length: a route whose handler comes from a caller should produce one handler summary, this produced ${handlers.length}`,
    ];
  }
  const summary = handlers[0];
  const complaints: string[] = [];
  const route = JSON.stringify(summary.identity.boundaryBinding);
  const baselineRoute = JSON.stringify(
    baseline.find((s) => s.kind === "handler")?.identity.boundaryBinding,
  );
  if (route !== baselineRoute) {
    complaints.push(
      `summaries[0].identity.boundaryBinding: the plainest spelling says ${baselineRoute}, this spelling says ${route}`,
    );
  }
  if (summary.transitions.length > 0) {
    complaints.push(
      `summaries[0].transitions: nothing about the handler was read, so the summary should claim no behaviour, and it claims ${summary.transitions.length} transitions`,
    );
  }
  if (!summary.gaps.some((gap) => gap.type === "unreadOutcome")) {
    complaints.push(
      "summaries[0].gaps: nothing about the handler was read, and no gap says so",
    );
  }
  if (summary.confidence.level !== "low") {
    complaints.push(
      `summaries[0].confidence: nothing about the handler was read, at confidence ${summary.confidence.level}`,
    );
  }
  return complaints;
}

export async function runShapeDifferential(
  spec: ShapeSpec,
  shapeTarget: ShapeTarget,
): Promise<ShapeResult> {
  const rendered = renderShape({
    spec,
    syntax: shapeTarget.syntax,
    wideType: WIDE_TYPE_SIZE,
  });
  const pack = shapeTarget.target.pack();
  const summaries = await extractAllSummaries({ files: rendered.files, pack });

  const expectation: ShapeExpectation = { ...EXPECTATION, kind: "handler" };
  const findings: ShapeFinding[] = checkInvariants(summaries, expectation).map(
    (violation) => ({
      oracle: "invariant" as const,
      detail: `${violation.invariant}: ${violation.detail}`,
    }),
  );

  const baseline = baselineOf(spec);
  const baselineRendered = renderShape({
    spec: baseline,
    syntax: shapeTarget.syntax,
    wideType: WIDE_TYPE_SIZE,
  });
  if (handlerComesFromACaller(spec)) {
    const baselineSummaries = await extractAllSummaries({
      files: baselineRendered.files,
      pack,
    });
    for (const detail of unreadHandlerComplaints(
      baselineSummaries,
      summaries,
    )) {
      findings.push({ oracle: "equivalence", detail });
    }
  } else if (!sameShape(spec, baseline)) {
    const baselineSummaries = await extractAllSummaries({
      files: baselineRendered.files,
      pack,
    });
    for (const difference of summarySetDifferences(
      baselineSummaries,
      summaries,
    )) {
      findings.push({
        oracle: "equivalence",
        detail: `${difference.path}: the plainest spelling says ${difference.baseline}, this spelling says ${difference.variant}`,
      });
    }
  }

  const harnessFailures: ShapeHarnessFailure[] = [];
  const handlerSummaries = summaries.filter((s) => s.kind === "handler");
  const requests = requestBattery(spec.body);
  const runExecution = rendered.executable && handlerSummaries.length === 1;

  if (runExecution) {
    const summary = handlerSummaries[0];
    for (const request of requests) {
      const execution = executeHandler(
        rendered.handlerSource,
        request,
        shapeTarget.target.makeResponder,
      );
      if (execution.type === "error") {
        harnessFailures.push({ request, message: execution.message });
        continue;
      }
      const mismatch = judgeObservation(
        summary,
        request,
        execution.observed.status,
      );
      if (mismatch !== null) {
        findings.push({
          oracle: "execution",
          detail: `${mismatch.verdict}: ${mismatch.detail} (request ${JSON.stringify(mismatch.request)})`,
        });
      }
    }
  }

  return {
    spec,
    label: `${spec.form} / ${spec.binding} / ${spec.reach} / ${spec.result}`,
    files: rendered.files,
    baselineFiles: baselineRendered.files,
    summaries,
    findings,
    harnessFailures,
    requestsRun: runExecution ? requests.length : 0,
  };
}

// ---------------------------------------------------------------------------
// The render boundary
// ---------------------------------------------------------------------------

/**
 * A component shape changes how the component is written, bound, and
 * exported, never what it renders, so execution cannot see a shape bug
 * here at all: the module runs the same whichever way it is exported.
 * The invariants and the baseline comparison are the whole oracle.
 */
export async function runComponentShapeDifferential(
  spec: ComponentShapeSpec,
  pack: PatternPack,
): Promise<ShapeResult> {
  const rendered = renderComponentShape(spec);
  const summaries = await extractAllSummaries({ files: rendered.files, pack });

  const findings: ShapeFinding[] = checkInvariants(summaries, {
    kind: "component",
    boundaryCount: 1,
    unitName: rendered.expectedName,
  }).map((violation) => ({
    oracle: "invariant" as const,
    detail: `${violation.invariant}: ${violation.detail}`,
  }));

  const baseline = { ...SIMPLEST_COMPONENT_SHAPE, body: spec.body };
  const baselineRendered = renderComponentShape(baseline);
  const isBaseline =
    spec.form === baseline.form &&
    spec.binding === baseline.binding &&
    spec.route === baseline.route;

  if (!isBaseline) {
    const baselineSummaries = await extractAllSummaries({
      files: baselineRendered.files,
      pack,
    });
    for (const difference of summarySetDifferences(
      baselineSummaries,
      summaries,
      { ignorePaths: ["identity.name"] },
    )) {
      findings.push({
        oracle: "equivalence",
        detail: `${difference.path}: the plainest spelling says ${difference.baseline}, this spelling says ${difference.variant}`,
      });
    }
  }

  return {
    spec,
    label: `${spec.form} / ${spec.binding} / ${spec.route}`,
    files: rendered.files,
    baselineFiles: baselineRendered.files,
    summaries,
    findings,
    harnessFailures: [],
    requestsRun: 0,
  };
}

// ---------------------------------------------------------------------------
// How a boundary announces itself
// ---------------------------------------------------------------------------

/**
 * A decorated controller is not run either: NestJS reads the decorators
 * and calls the method itself, so what a generated one does in a vm
 * says nothing. The invariants and the comparison against the bare
 * decorator are the oracle.
 */
export async function runAnnounceShapeDifferential(
  spec: AnnounceShapeSpec,
  pack: PatternPack,
): Promise<ShapeResult> {
  const files = renderAnnounceShape(spec);
  const summaries = await extractAllSummaries({ files, pack });

  const findings: ShapeFinding[] = checkInvariants(summaries, {
    kind: "handler",
    boundaryCount: 1,
    unitName: null,
  }).map((violation) => ({
    oracle: "invariant" as const,
    detail: `${violation.invariant}: ${violation.detail}`,
  }));

  const baseline = { ...SIMPLEST_ANNOUNCEMENT, bodyKey: spec.bodyKey };
  const baselineFiles = renderAnnounceShape(baseline);
  const isBaseline =
    spec.announcement === baseline.announcement &&
    spec.method === baseline.method;

  if (!isBaseline) {
    const baselineSummaries = await extractAllSummaries({
      files: baselineFiles,
      pack,
    });
    for (const difference of summarySetDifferences(
      baselineSummaries,
      summaries,
    )) {
      findings.push({
        oracle: "equivalence",
        detail: `${difference.path}: the plainest spelling says ${difference.baseline}, this spelling says ${difference.variant}`,
      });
    }
  }

  return {
    spec,
    label: `${spec.announcement} / ${spec.method}`,
    files,
    baselineFiles,
    summaries,
    findings,
    harnessFailures: [],
    requestsRun: 0,
  };
}

// ---------------------------------------------------------------------------
// GraphQL resolvers, where the pair a query names is what has to survive
// ---------------------------------------------------------------------------

/**
 * Both resolver frameworks are read the same way: render the program,
 * render the plainest spelling of the same field, and require the two
 * to agree. What differs is which spellings mean the same field, so
 * each caller says which of its own it wants compared.
 */
interface ResolverRun<S> {
  spec: S;
  label: string;
  pack: PatternPack;
  render: (spec: S) => RenderedResolverShape;
  /** The spelling to compare against, or null when there is none. */
  baseline: S | null;
}

async function runResolverShape<
  S extends ApolloResolverSpec | NestResolverSpec,
>(run: ResolverRun<S>): Promise<ShapeResult> {
  const rendered = run.render(run.spec);
  const summaries = await extractAllSummaries({
    files: rendered.files,
    pack: run.pack,
  });

  const findings: ShapeFinding[] = checkInvariants(summaries, {
    kind: "resolver",
    boundaryCount: 1,
    unitName: rendered.unitName,
    resolver: {
      typeName: rendered.typeName,
      fieldName: rendered.fieldName,
    },
  }).map((violation) => ({
    oracle: "invariant" as const,
    detail: `${violation.invariant}: ${violation.detail}`,
  }));

  const baselineFiles =
    run.baseline === null ? rendered.files : run.render(run.baseline).files;
  if (run.baseline !== null) {
    const baselineSummaries = await extractAllSummaries({
      files: baselineFiles,
      pack: run.pack,
    });
    for (const difference of summarySetDifferences(
      baselineSummaries,
      summaries,
    )) {
      findings.push({
        oracle: "equivalence",
        detail: `${difference.path}: the plainest spelling says ${difference.baseline}, this spelling says ${difference.variant}`,
      });
    }
  }

  return {
    spec: run.spec,
    label: run.label,
    files: rendered.files,
    baselineFiles,
    summaries,
    findings,
    harnessFailures: [],
    requestsRun: 0,
  };
}

const APOLLO_PACK = apolloFramework();
const NEST_GRAPHQL_PACK = nestjsGraphqlFramework();

export async function runApolloResolverDifferential(
  spec: ApolloResolverSpec,
): Promise<ShapeResult> {
  const baseline = { ...SIMPLEST_APOLLO_RESOLVER, owner: spec.owner };
  const isBaseline =
    spec.route === baseline.route && spec.field === baseline.field;
  return runResolverShape({
    spec,
    label: `${spec.route} / ${spec.field} / ${spec.owner}`,
    pack: APOLLO_PACK,
    render: renderApolloResolverShape,
    baseline: isBaseline ? null : baseline,
  });
}

/**
 * A class that names no type resolves for a different type than one
 * that names it, and a method that renames its field answers a
 * different field, so neither has a plainest spelling to compare
 * against and the invariants carry them.
 */
function nestResolverBaseline(spec: NestResolverSpec): NestResolverSpec | null {
  if (
    spec.announcement === "noTypeArgument" ||
    spec.method === "renamedField"
  ) {
    return null;
  }
  const baseline: NestResolverSpec = {
    ...SIMPLEST_NEST_RESOLVER,
    operation: spec.operation,
    method: spec.method,
  };
  return baseline.announcement === spec.announcement ? null : baseline;
}

export async function runNestResolverDifferential(
  spec: NestResolverSpec,
): Promise<ShapeResult> {
  return runResolverShape({
    spec,
    label: `${spec.announcement} / ${spec.operation} / ${spec.method}`,
    pack: NEST_GRAPHQL_PACK,
    render: renderNestResolverShape,
    baseline: nestResolverBaseline(spec),
  });
}

// ---------------------------------------------------------------------------
// Runtime configuration, where the read is what has to survive
// ---------------------------------------------------------------------------

/**
 * The packs a unit reading its configuration needs: one that finds the
 * unit and one that reads what happens inside it.
 */
export function envPacks(): PatternPack[] {
  return [expressFramework(), nodeRuntimePack()];
}

/**
 * A read in a helper only shows up when the extraction follows the call
 * into it, which is what a project run does, so this family asks for
 * the same.
 */
const ENV_EXTRACT = { includeReachable: true } as const;

/**
 * Where the read sits and how it is spelled are two different
 * questions. Two spellings of a read in the same place mean the same
 * program, so those compare against each other. Two places do not: a
 * read at module scope runs when the module loads and one in the
 * handler runs per request, so there is no plainest spelling across
 * sites and the invariants carry that dimension alone.
 */
function envBaselineOf(spec: EnvShapeSpec): EnvShapeSpec | null {
  if (spec.form === SIMPLEST_ENV_SHAPE.form || spec.form === "defaulted") {
    return null;
  }
  return { ...spec, form: SIMPLEST_ENV_SHAPE.form };
}

export async function runEnvShapeDifferential(
  spec: EnvShapeSpec,
): Promise<ShapeResult> {
  const rendered = renderEnvShape(spec);
  const packs = envPacks();
  const summaries = await extractAllSummaries({
    files: rendered.files,
    pack: packs,
    ...ENV_EXTRACT,
  });

  const findings: ShapeFinding[] = checkInvariants(summaries, {
    kind: "handler",
    boundaryCount: 1,
    unitName: null,
    configReads: rendered.reads,
  }).map((violation) => ({
    oracle: "invariant" as const,
    detail: `${violation.invariant}: ${violation.detail}`,
  }));

  const baseline = envBaselineOf(spec);
  const baselineFiles =
    baseline === null ? rendered.files : renderEnvShape(baseline).files;
  if (baseline !== null) {
    const baselineSummaries = await extractAllSummaries({
      files: baselineFiles,
      pack: packs,
      ...ENV_EXTRACT,
    });
    for (const difference of summarySetDifferences(
      baselineSummaries,
      summaries,
    )) {
      findings.push({
        oracle: "equivalence",
        detail: `${difference.path}: the plainest spelling says ${difference.baseline}, this spelling says ${difference.variant}`,
      });
    }
  }

  return {
    spec,
    label: `${spec.site} / ${spec.form}`,
    files: rendered.files,
    baselineFiles,
    summaries,
    findings,
    harnessFailures: [],
    requestsRun: 0,
  };
}

// ---------------------------------------------------------------------------
// Queue consumers, where the program and its configuration are one thing
// ---------------------------------------------------------------------------

/** The TypeScript files a rendered queue program spans. */
const typeScriptFiles = (
  files: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(([filePath]) => filePath.endsWith(".ts")),
  );

async function extractQueueShape(
  rendered: RenderedQueueShape,
): Promise<BehavioralSummary[]> {
  writeQueueShape(rendered);
  // The template is read off disk and memoized per directory, and the
  // generator rewrites that directory per program.
  clearTemplateCache();
  return extractFromDisk({
    files: typeScriptFiles(rendered.files),
    pack: awsLambdaFramework({ subjectFactories: rendered.subjectFactories }),
  });
}

export async function runQueueShapeDifferential(
  spec: QueueShapeSpec,
): Promise<ShapeResult> {
  const rendered = renderQueueShape(spec);
  const summaries = await extractQueueShape(rendered);

  const findings: ShapeFinding[] = checkInvariants(summaries, {
    kind: "handler",
    boundaryCount: 1,
    unitName: null,
    channel: rendered.channel,
  }).map((violation) => ({
    oracle: "invariant" as const,
    detail: `${violation.invariant}: ${violation.detail}`,
  }));

  // A consumer built by no factory names no subject, so it is a
  // different program rather than another spelling of this one.
  const baseline =
    spec.build === "bareFunction" ||
    (spec.build === SIMPLEST_QUEUE_SHAPE.build &&
      spec.config === SIMPLEST_QUEUE_SHAPE.config)
      ? null
      : SIMPLEST_QUEUE_SHAPE;
  const baselineRendered = renderQueueShape(baseline ?? spec);
  if (baseline !== null) {
    const baselineSummaries = await extractQueueShape(baselineRendered);
    for (const difference of summarySetDifferences(
      baselineSummaries,
      summaries,
    )) {
      findings.push({
        oracle: "equivalence",
        detail: `${difference.path}: the plainest spelling says ${difference.baseline}, this spelling says ${difference.variant}`,
      });
    }
  }

  return {
    spec,
    label: `${spec.build} / ${spec.config}`,
    files: rendered.files,
    baselineFiles: baselineRendered.files,
    summaries,
    findings,
    harnessFailures: [],
    requestsRun: 0,
  };
}

// ---------------------------------------------------------------------------
// Queue producers, where the send has to survive however its queue is
// named
// ---------------------------------------------------------------------------

interface SendRecord {
  interactionClass: string;
  channel: string | null;
  bodyFields: string[];
}

/** Every message-send effect in the set, reduced to what the property compares. */
function messageSends(summaries: BehavioralSummary[]): SendRecord[] {
  const sends: SendRecord[] = [];
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (
          effect.type !== "interaction" ||
          effect.interaction.class !== "message-send"
        ) {
          continue;
        }
        const semantics = effect.binding.semantics;
        const body = effect.interaction.body as
          | { kind?: string; fields?: Record<string, unknown> }
          | undefined;
        sends.push({
          interactionClass: effect.interaction.class,
          channel: semantics.name === "message-bus" ? semantics.channel : null,
          bodyFields: Object.keys(body?.fields ?? {}).sort(),
        });
      }
    }
  }
  return sends;
}

export async function runProducerShapeDifferential(
  spec: ProducerShapeSpec,
): Promise<ShapeResult> {
  const rendered = renderProducerShape(spec);
  const producerPacks = [sqsFramework(), PRODUCER_HANDLER_PACK];
  const summaries = await extractAllSummaries({
    files: rendered.files,
    pack: producerPacks,
  });
  const findings: ShapeFinding[] = [];

  const sends = messageSends(summaries);
  if (sends.length !== 1) {
    findings.push({
      oracle: "invariant",
      detail: `theSendSurvivesItsNaming: the program sends once and extraction recorded ${sends.length} sends`,
    });
  } else {
    const send = sends[0] as SendRecord;
    if (send.channel !== rendered.expectedChannel) {
      findings.push({
        oracle: "invariant",
        detail: `theNamingReachesTheChannel: this naming should carry ${JSON.stringify(rendered.expectedChannel)} and the summary carries ${JSON.stringify(send.channel)}`,
      });
    }
  }

  // The same send, named less: against the plainest spelling, with the
  // channel put aside, the send should look identical.
  const baselineRendered = renderProducerShape(SIMPLEST_PRODUCER_SHAPE);
  if (spec.naming !== SIMPLEST_PRODUCER_SHAPE.naming) {
    const baselineSummaries = await extractAllSummaries({
      files: baselineRendered.files,
      pack: producerPacks,
    });
    const erase = (send: SendRecord): string =>
      JSON.stringify({
        interactionClass: send.interactionClass,
        bodyFields: send.bodyFields,
      });
    const left = messageSends(baselineSummaries).map(erase).sort();
    const right = sends.map(erase).sort();
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      findings.push({
        oracle: "equivalence",
        detail: `with the channel put aside, the plainest spelling sends ${left.join(", ")} and this spelling sends ${right.join(", ")}`,
      });
    }
  }

  return {
    spec,
    label: spec.naming,
    files: rendered.files,
    baselineFiles: baselineRendered.files,
    summaries,
    findings,
    harnessFailures: [],
    requestsRun: 0,
  };
}

// ---------------------------------------------------------------------------
// Package exports, where both sides of the boundary are generated
// ---------------------------------------------------------------------------

/**
 * The pack a project points at its own package, the same one the
 * dogfood run builds: the manifest names the provider side, and the
 * package name names the call sites.
 */
function packageBoundaryPack(rendered: RenderedPackageShape): PatternPack {
  return {
    name: "package-exports:generated",
    languages: ["typescript"],
    protocol: "in-process",
    discovery: [
      {
        kind: "library",
        match: {
          type: "packageExports",
          packageJsonPath: rendered.packageJsonPath,
        },
      },
      {
        kind: "caller",
        match: { type: "packageImport", packages: [rendered.importSpecifier] },
      },
    ],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
    ],
    inputMapping: {
      type: "positionalParams",
      params: [{ position: 0, role: "arg0" }],
    },
  };
}

export async function runPackageShapeDifferential(
  spec: PackageShapeSpec,
): Promise<ShapeResult> {
  const rendered = renderPackageShape(spec);
  writePackageShape(rendered);
  const summaries = await extractFromDisk({
    files: typeScriptFiles(rendered.files),
    pack: packageBoundaryPack(rendered),
  });

  // Two sides, two expectations: the package publishes one function
  // and the calling package calls it once.
  const findings: ShapeFinding[] = [
    ...checkInvariants(summaries, {
      kind: "library",
      boundaryCount: 1,
      unitName: null,
      exportPath: rendered.exportPath,
    }),
    ...checkInvariants(summaries, {
      kind: "caller",
      boundaryCount: 1,
      unitName: null,
    }),
  ].map((violation) => ({
    oracle: "invariant" as const,
    detail: `${violation.invariant}: ${violation.detail}`,
  }));

  return {
    spec,
    label: `${spec.route} / ${spec.form}`,
    files: rendered.files,
    // Two ways of publishing put the export under different paths, and
    // two ways of importing are two call sites, so no pair of these
    // programs is the same program written twice. The invariants are
    // the whole oracle.
    baselineFiles: rendered.files,
    summaries,
    findings,
    harnessFailures: [],
    requestsRun: 0,
  };
}

export const shapeFailed = (result: ShapeResult): boolean =>
  result.findings.length > 0 || result.harnessFailures.length > 0;

/** The failure text a run prints: the finding, then the program it came from. */
export function formatShapeFailure(result: ShapeResult): string {
  const files = Object.entries(result.files)
    .map(([path, content]) => `--- ${path} ---\n${content}`)
    .join("\n");
  return [
    `shape finding (${result.label})`,
    "",
    ...result.findings.map(
      (finding) => `[${finding.oracle}] ${finding.detail}`,
    ),
    ...result.harnessFailures.map(
      (failure) =>
        `[harness] ${failure.message} (request ${JSON.stringify(failure.request)})`,
    ),
    "",
    "=== program ===",
    files,
  ].join("\n");
}
