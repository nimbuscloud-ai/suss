import fs from "node:fs";
import path from "node:path";

import {
  BOUNDARY_ROLE,
  safeParseSummaries,
  summaryRef,
} from "@suss/behavioral-ir";
import {
  applySuppressions,
  boundaryKey,
  boundaryKeyOf,
  changesSince,
  checkAll,
  checkPair,
  countsForThreshold,
  findingIdentity,
  normalizedDescription,
  readDeclaredContract,
  readGraphqlDeclaredContract,
  summaryWithDefinitionsInlined,
} from "@suss/checker";
import {
  applyIntentSuppressions,
  checkIntentAgreement,
} from "@suss/checker-intent";
import { loadIntentDirectory } from "@suss/contract-intent";

import { readProjectFile, unreadArtifacts } from "./projectFile.js";
import {
  DEFAULT_SUPPRESSIONS_FILENAMES,
  loadSuppressionsOrEmpty,
} from "./suppressionsLoader.js";
import { UsageError } from "./usageError.js";

import type {
  BehavioralSummary,
  ConfidenceInfo,
  Finding,
  RunFinding,
} from "@suss/behavioral-ir";
import type {
  ChangesSince,
  CheckAllResult,
  CheckedRun,
  ComparedPair,
  SuppressionRule,
} from "@suss/checker";
import type { CheckIntentResult, IntentFinding } from "@suss/checker-intent";

/**
 * Each summary's confidence, keyed by `summaryRef`. The checker writes
 * the same key into a finding's `side.summary`, so the report can look up
 * how sure extraction was about either side. The checker never uses
 * confidence to decide anything. The human report prints it so a
 * reviewer can weigh the finding.
 */
export type ConfidenceLookup = Map<string, ConfidenceInfo>;

export function buildConfidenceLookup(
  ...groups: BehavioralSummary[][]
): ConfidenceLookup {
  const map: ConfidenceLookup = new Map();
  for (const group of groups) {
    for (const s of group) {
      map.set(summaryRef(s), s.confidence);
    }
  }
  return map;
}

export type FailOn = "error" | "warning" | "info" | "none";

export interface CheckOptions {
  providerFile: string;
  consumerFile: string;
  json?: boolean;
  output?: string;
  failOn?: FailOn;
  /** A .sussignore file to use instead of the one found by searching. */
  sussignore?: string;
  /** Skip every .sussignore, including one the search would find. */
  noSuppressions?: boolean;
  /** Print every finding and every list instead of the collapsed report. */
  all?: boolean;
  /**
   * Let a run that compared nothing exit 0. Without it, the run fails.
   *
   * A run that pairs no boundary has no findings, and passing it would
   * hide that suss could not see enough of the code to compare anything.
   * `extract` takes the same option for the same reason. A two-file
   * `check` never counts pairs, so it refuses this option.
   */
  allowEmpty?: boolean;
}

export interface CheckDirOptions {
  dir: string;
  json?: boolean;
  output?: string;
  failOn?: FailOn;
  sussignore?: string;
  noSuppressions?: boolean;
  all?: boolean;
  /** Let a run that compared nothing exit 0. See CheckOptions. */
  allowEmpty?: boolean;
  /**
   * Exit non-zero when more boundaries went unpaired than this allows,
   * as a count ("25") or a share of all boundaries ("50%"). Without it, a
   * run that pairs three boundaries out of hundreds looks the same as
   * one that paired everything.
   */
  failOnUnpaired?: string;
  /**
   * Exit non-zero when a file in the directory could not be read as
   * summaries. Without it, a truncated or malformed file is skipped and
   * the run can still pass.
   */
  failOnUnreadable?: boolean;
  /**
   * A directory of intent docs the team wrote (`*.intent` and `*.prd`).
   * When set, each boundary intent is compared with the code summaries
   * in `dir`, and the result gains an `intent` section.
   */
  intent?: string;
  /**
   * A directory of summaries from an earlier run. When set, the report
   * narrows to what changed since then: the findings that are new, the
   * ones that went away, and the boundaries the code changed at. The
   * run fails only on new findings.
   */
  since?: string;
}

export interface CheckResult {
  findings: Finding[];
  /** Problems with the run itself, present only when there were any. */
  run?: RunFinding[];
  /**
   * The intent findings and which intents were checked or left
   * unchecked, present only when --intent was passed.
   */
  intent?: CheckIntentResult;
  hasErrors: boolean;
}

export function check(options: CheckOptions): CheckResult {
  const providerSummaries = readSummaries(options.providerFile);
  const consumerSummaries = readSummaries(options.consumerFile);

  const rawFindings: Finding[] = [];
  for (const provider of providerSummaries) {
    for (const consumer of consumerSummaries) {
      rawFindings.push(...checkPair(provider, consumer));
    }
  }

  const suppressions = loadSuppressionsForOptions(options, process.cwd());
  const findings = applySuppressions(rawFindings, suppressions);

  const confidence = buildConfidenceLookup(
    providerSummaries,
    consumerSummaries,
  );
  return emitFindings(findings, confidence, options);
}

function loadSuppressionsForOptions(
  options: { sussignore?: string; noSuppressions?: boolean },
  searchDir: string,
): SuppressionRule[] {
  if (options.noSuppressions === true) {
    return [];
  }
  return loadSuppressionsOrEmpty({
    overridePath: options.sussignore,
    searchDir,
  });
}

/** Everything one pass over a directory of summaries produced. */
export interface CheckedDirectory {
  summaries: BehavioralSummary[];
  /** The file each summary came from. */
  sourceFile: Map<BehavioralSummary, string>;
  /** Files in the directory that could not be read as summaries, each with the reason. */
  skipped: string[];
  /** The checker's result, with suppressions already applied. */
  result: CheckAllResult;
  suppressions: SuppressionRule[];
  confidence: ConfidenceLookup;
}

/**
 * Reads a directory of summaries and runs every pass over it.
 *
 * `suss check --dir` and `suss check --at` both call this, so a run
 * scoped with `--at` filters the full run's result and cannot disagree
 * with it.
 */
export function checkDirectory(options: {
  dir: string;
  sussignore?: string;
  noSuppressions?: boolean;
}): CheckedDirectory {
  const resolved = path.resolve(options.dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new UsageError(
      `No directory at ${resolved}. Pass the folder holding the summary files you wrote with \`suss extract -o\`.`,
    );
  }

  // The suppressions file can live in this directory too. Leave it out,
  // along with extract's incompleteness note.
  const entries = fs.readdirSync(resolved);
  const files = entries.filter(
    (f) =>
      f.endsWith(".json") &&
      !f.endsWith(".incomplete.json") &&
      !DEFAULT_SUPPRESSIONS_FILENAMES.includes(f),
  );

  // Extract writes this note beside its output when it could not read
  // every export. Agreement over those summaries covers only part of the
  // code, so the user has to hear about it.
  for (const note of entries.filter((f) => f.endsWith(".incomplete.json"))) {
    process.stderr.write(
      `${note} says the extract that wrote these summaries was incomplete, so agreement here covers only what it could read. Fix what the note lists, re-extract, and it disappears.\n`,
    );
  }
  if (files.length === 0) {
    throw new UsageError(
      `${resolved} has no JSON files in it. Write summaries there first, for example: suss extract -p tsconfig.json -f express -o ${path.join(options.dir, "api.json")}`,
    );
  }

  const summaries: BehavioralSummary[] = [];
  // Lets a caller report a boundary that two files both claim to provide.
  const sourceFile = new Map<BehavioralSummary, string>();
  const skipped: string[] = [];
  for (const file of files) {
    let read: BehavioralSummary[];
    try {
      read = readSummaries(path.join(resolved, file));
    } catch (error) {
      // Other JSON ends up in a summaries folder, most often a report
      // written next to the summaries. Name the file and check the rest.
      skipped.push(`${file}: ${reasonOf(error)}`);
      continue;
    }
    for (const summary of read) {
      summaries.push(summary);
      sourceFile.set(summary, file);
    }
  }

  if (skipped.length === files.length) {
    throw new UsageError(
      `Nothing in ${resolved} is a summaries file:\n${listOfSkipped(skipped)}`,
    );
  }

  if (skipped.length > 0) {
    process.stderr.write(
      `Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} in ${resolved} that suss could not read as summaries:\n${listOfSkipped(skipped)}\n`,
    );
  }

  const rawResult = checkAll(summaries);
  const suppressions = loadSuppressionsForOptions(options, resolved);
  return {
    summaries,
    sourceFile,
    skipped,
    result: {
      ...rawResult,
      findings: applySuppressions(rawResult.findings, suppressions),
    },
    suppressions,
    confidence: buildConfidenceLookup(summaries),
  };
}

export function checkDir(
  options: CheckDirOptions,
): CheckResult & { result: CheckAllResult } {
  if (options.since !== undefined && options.intent !== undefined) {
    throw new UsageError(
      "--since reports what changed between two runs and --intent scores the code against your intent docs, so they cannot run together. Run them one at a time.",
    );
  }

  const {
    summaries: allSummaries,
    sourceFile,
    skipped,
    result,
    suppressions,
    confidence,
  } = checkDirectory(options);

  const since =
    options.since === undefined
      ? null
      : compareWithEarlierRun(options.since, options, {
          summaries: allSummaries,
          findings: result.findings,
        });
  // With --since, the report is about the new findings only, and so is
  // the exit code.
  const reported = since === null ? result.findings : since.added;

  // Intent findings have their own type, so they get their own section
  // of the report. The same .sussignore rules apply to both lists.
  const intent = runIntentPass(options.intent, allSummaries, suppressions);

  const collisions = findBoundaryCollisions(allSummaries, sourceFile);

  const runtimeNamedCrossings = countRuntimeNamedCrossings(allSummaries);
  const summariesWithGaps = countSummariesWithGaps(allSummaries);
  // Checking a boundary against an intent doc counts as a comparison, so
  // provider summaries checked only against intent are not an empty run.
  const comparedIntent = (intent?.checked.length ?? 0) > 0;
  const run = [
    ...runFindings(
      options.allowEmpty !== true && !comparedIntent,
      allSummaries,
      result,
    ),
    ...unreadableFindings(options.failOnUnreadable === true, skipped),
    ...unpairedFindings(options.failOnUnpaired, result),
  ];

  const rest = {
    run,
    intent,
    pairs: result.pairs,
    unmatched: result.unmatched,
    skipped,
    runtimeNamedCrossings,
    summariesWithGaps,
    collisions,
  };
  const rendered = options.json
    ? `${JSON.stringify(since === null ? { findings: result.findings, ...rest } : { ...sinceJson(since), ...rest }, null, 2)}\n`
    : renderDirHuman(result, confidence, scopeOf(options), since) +
      renderRuntimeNamedCrossings(runtimeNamedCrossings) +
      renderGapCoverage(summariesWithGaps, allSummaries.length) +
      renderCollisions(collisions) +
      renderUnreadArtifacts(allSummaries, result.unmatched) +
      renderIntentSection(intent) +
      renderRunFindings(run);

  writeReport(rendered, options.output);

  const failOn = options.failOn ?? "error";
  return {
    findings: reported,
    ...(run.length > 0 ? { run } : {}),
    ...(intent !== undefined ? { intent } : {}),
    hasErrors:
      meetsThreshold(reported, failOn) ||
      intentMeetsThreshold(intent?.findings ?? [], failOn) ||
      run.length > 0,
    result,
  };
}

/** What moved since an earlier run, for `check --since`. */
interface SinceReport extends ChangesSince {
  /** The earlier run's directory, resolved. */
  dir: string;
}

/**
 * Checks the earlier directory the same way as the later one, with the
 * same `.sussignore`, so a finding a rule accepts counts the same on both
 * sides.
 */
function compareWithEarlierRun(
  dir: string,
  options: CheckDirOptions,
  later: CheckedRun,
): SinceReport {
  const earlier = checkDirectory({ ...options, dir });
  return {
    dir: path.resolve(dir),
    ...changesSince(
      { summaries: earlier.summaries, findings: earlier.result.findings },
      later,
    ),
  };
}

/**
 * The `--since` part of the JSON report. Each finding also gets its
 * identity, its boundary key, whether that boundary is one the code
 * changed at, and the `.sussignore` rule that would accept it, so a
 * program acting on the report does not have to work those out.
 */
function sinceJson(since: SinceReport): Record<string, unknown> {
  const changedKeys = new Set(since.changedBoundaries.map((b) => b.key));
  const described = (findings: readonly Finding[]) =>
    findings.map((finding) => {
      const rule = acceptingRule(finding);
      const key = boundaryKeyOf(finding.boundary);
      return {
        ...finding,
        identity: findingIdentity(finding),
        boundaryKey: key,
        atChangedBoundary: changedKeys.has(key),
        ...(rule !== null ? { rule } : {}),
      };
    });
  return {
    since: since.dir,
    findings: described(since.added),
    resolved: described(since.resolved),
    changedBoundaries: since.changedBoundaries,
  };
}

/** The `--since` part of the printed report, which takes the place of the full findings list. */
function renderSince(
  since: SinceReport,
  confidence: ConfidenceLookup,
  scope: ReportScope,
): string[] {
  const changed = since.changedBoundaries;
  const lines = [
    `Since ${since.dir}:`,
    changed.length === 0
      ? "  No boundary changed."
      : `  ${changed.length} boundar${changed.length === 1 ? "y" : "ies"} changed: ${changed.map((b) => b.key).join(", ")}`,
    `  ${since.added.length} new finding${since.added.length === 1 ? "" : "s"}, ${since.resolved.length} resolved.`,
  ];
  if (since.added.length > 0) {
    lines.push("", renderFindings(since.added, confidence, scope).trimEnd());
  }

  if (since.resolved.length > 0) {
    lines.push("", "Resolved:");
    for (const finding of since.resolved) {
      lines.push(
        `  ${finding.kind} at ${boundaryKeyOf(finding.boundary)}: ${normalizedDescription(finding)}`,
      );
    }
  }
  return lines;
}

/**
 * A `nothingPaired` finding when the run had summaries and paired none
 * of them. The run fails because of this finding, so an automated fixer
 * that sees the red exit also gets a reason and a remedy to act on.
 *
 * A run over no summaries at all is a different mistake that the report
 * already explains, so this returns nothing for it.
 */
function runFindings(
  shouldFail: boolean,
  summaries: readonly BehavioralSummary[],
  result: CheckAllResult,
): RunFinding[] {
  if (!shouldFail || summaries.length === 0 || result.pairs.length > 0) {
    return [];
  }
  return [
    {
      kind: "nothingPaired",
      severity: "error",
      description:
        `Read ${summaries.length} ${summaries.length === 1 ? "summary" : "summaries"} and paired nothing. ` +
        "No boundary in this run had both a provider and a consumer, so nothing was compared.",
      remedy:
        "Check that both sides of at least one boundary are in the directory. " +
        "A provider extracted from code needs its consumer extracted too, or its contract read with `suss contract`. " +
        "`suss inspect --dir` over the same files lists the boundaries each side claims, and two spellings of one boundary is the usual cause.",
    },
  ];
}

function unreadableFindings(
  asked: boolean,
  skipped: readonly string[],
): RunFinding[] {
  if (!asked || skipped.length === 0) {
    return [];
  }
  return [
    {
      kind: "unreadableInput",
      severity: "error",
      description:
        `${skipped.length} ${skipped.length === 1 ? "file" : "files"} in the directory could not be read as summaries: ` +
        skipped.join("; "),
      remedy:
        "Fix or remove the files, or write summaries somewhere reports are not written back to. " +
        "A truncated extract output and a report saved into the summaries directory are the usual causes.",
    },
  ];
}

/** "25" allows 25 unpaired boundaries; "50%" allows half of them. */
function unpairedFindings(
  threshold: string | undefined,
  result: CheckAllResult,
): RunFinding[] {
  if (threshold === undefined) {
    return [];
  }

  const match = threshold.match(/^(\d+)(%?)$/);
  if (match === null) {
    throw new UsageError(
      `--fail-on-unpaired takes a count ("25") or a share ("50%"), not "${threshold}".`,
    );
  }

  const unpaired =
    result.unmatched.providers.length + result.unmatched.consumers.length;
  const total = unpaired + result.pairs.length;
  if (total === 0) {
    return [];
  }

  const allowed =
    match[2] === "%" ? (total * Number(match[1])) / 100 : Number(match[1]);
  if (unpaired <= allowed) {
    return [];
  }

  return [
    {
      kind: "mostlyUnpaired",
      severity: "error",
      description:
        `${unpaired} of ${total} boundaries had nothing to pair with, over the --fail-on-unpaired floor of ${threshold}. ` +
        `${result.pairs.length} paired.`,
      remedy:
        "The unmatched lists in this report say which side each boundary is missing. " +
        "Extract the missing side, read its contract with `suss contract`, or raise the floor if this share is expected.",
    },
  ];
}

function renderRunFindings(findings: readonly RunFinding[]): string {
  if (findings.length === 0) {
    return "";
  }
  return findings
    .map(
      (one) =>
        `\n${one.severity}: ${one.kind}\n  ${one.description}\n  ${one.remedy}\n`,
    )
    .join("");
}

/** A boundary whose providers came from more than one summary file. */
interface BoundaryCollision {
  key: string;
  files: string[];
}

/**
 * Boundaries that two different summary files both claim to provide.
 *
 * suss keys an HTTP boundary by method and path, without the service
 * that serves it, so two services that both expose `GET /users` share one
 * key. A caller of either one is then compared with both, and gets
 * findings from an API it never calls. Projects usually write one file
 * per service, so two files providing one key most likely means this
 * happened, and the report says so.
 */
function findBoundaryCollisions(
  summaries: ReadonlyArray<BehavioralSummary>,
  sourceFile: ReadonlyMap<BehavioralSummary, string>,
): BoundaryCollision[] {
  const filesByKey = new Map<string, Set<string>>();

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null || BOUNDARY_ROLE[summary.kind] !== "provider") {
      continue;
    }
    // A spec read with `suss contract` describes the handler's route. It
    // does not serve it, so it is no second claim on the key.
    if (
      readDeclaredContract(summary)?.provenance === "derived" ||
      readGraphqlDeclaredContract(summary)?.provenance === "derived"
    ) {
      continue;
    }
    const key = boundaryKey(binding);
    const file = sourceFile.get(summary);
    if (key === null || file === undefined) {
      continue;
    }
    const seen = filesByKey.get(key);
    if (seen === undefined) {
      filesByKey.set(key, new Set([file]));
    } else {
      seen.add(file);
    }
  }

  const collisions: BoundaryCollision[] = [];
  for (const [key, files] of filesByKey) {
    if (files.size > 1) {
      collisions.push({ key, files: [...files].sort() });
    }
  }
  return collisions.sort((a, b) => a.key.localeCompare(b.key));
}

function renderCollisions(
  collisions: ReadonlyArray<BoundaryCollision>,
): string {
  if (collisions.length === 0) {
    return "";
  }
  const lines = [
    "",
    `${collisions.length} ${collisions.length === 1 ? "boundary is" : "boundaries are"} claimed by more than one file:`,
  ];
  for (const collision of collisions) {
    lines.push(`  ${collision.key}  in ${collision.files.join(" and ")}`);
  }
  lines.push("");
  lines.push(
    "  suss tells boundaries apart by method and path, so two services that",
  );
  lines.push(
    "  serve the same route look like one. Anything compared against these",
  );
  lines.push(
    "  was compared against both. Check one service at a time to be sure.",
  );
  return `${lines.join("\n")}\n`;
}

/** Rethrows any error as a UsageError, so the CLI prints its message without a stack trace. */
function attempt<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function runIntentPass(
  intentDir: string | undefined,
  code: BehavioralSummary[],
  suppressions: SuppressionRule[],
): CheckIntentResult | undefined {
  if (intentDir === undefined) {
    return undefined;
  }
  // A doc that fails to load is the author's to fix, so they get the
  // reason as a message.
  const intents = attempt(() => loadIntentDirectory(intentDir));
  if (intents.length === 0) {
    // An empty intent directory is a usage error, the same as an empty
    // --dir, so it cannot pass as a run with nothing wrong.
    throw new UsageError(
      `${intentDir} holds no intent docs. suss looks for *.intent.yaml, *.intent.yml, *.intent.json, and the same three for *.prd.`,
    );
  }
  const result = checkIntentAgreement(intents, code);
  return {
    ...result,
    findings: applyIntentSuppressions(result.findings, suppressions),
  };
}

function intentMeetsThreshold(
  findings: IntentFinding[],
  failOn: FailOn,
): boolean {
  if (failOn === "none") {
    return false;
  }
  const threshold = SEVERITY_ORDER[failOn];
  // Suppressions apply the same way as in meetsThreshold.
  return findings.some(
    (f) => countsForThreshold(f) && SEVERITY_ORDER[f.severity] <= threshold,
  );
}

function renderIntentSection(intent: CheckIntentResult | undefined): string {
  if (intent === undefined) {
    return "";
  }
  const lines = ["", "Intent:"];
  const boundaries = intent.checked.filter((c) => c.kind === "boundary");
  const prds = intent.checked.filter((c) => c.kind === "prd");
  const n = boundaries.length;
  lines.push(
    `  ${n} boundary intent${n === 1 ? "" : "s"} checked against code`,
  );
  if (prds.length > 0) {
    const scenarios = prds.reduce((sum, p) => sum + p.scenarios, 0);
    const resolved = prds.reduce((sum, p) => sum + p.resolved, 0);
    const unlinked = prds.reduce((sum, p) => sum + p.unlinked, 0);
    lines.push(
      `  ${prds.length} PRD${prds.length === 1 ? "" : "s"} checked: ${scenarios} scenario${scenarios === 1 ? "" : "s"}, ${resolved} resolved, ${unlinked} unlinked`,
    );
  }
  for (const f of intent.findings) {
    lines.push(`  [${f.severity}] ${f.boundary}: ${f.message}`);
    if (f.suppressed !== undefined) {
      lines.push(
        `    suppressed (${f.suppressed.effect}): ${f.suppressed.reason}`,
      );
    }
  }
  for (const u of intent.unchecked) {
    lines.push(`  not checked: ${u.intent}: ${u.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

function emitFindings(
  findings: Finding[],
  confidence: ConfidenceLookup,
  options: { json?: boolean; output?: string; failOn?: FailOn; all?: boolean },
): CheckResult {
  const rendered = options.json
    ? `${JSON.stringify(findings, null, 2)}\n`
    : renderFindings(findings, confidence, scopeOf(options));

  writeReport(rendered, options.output);

  return {
    findings,
    hasErrors: meetsThreshold(findings, options.failOn ?? "error"),
  };
}

/** Where a rendered report goes: a file when asked for, stdout otherwise. */
export function writeReport(
  rendered: string,
  output: string | undefined,
): void {
  if (output !== undefined) {
    fs.writeFileSync(output, rendered);
    return;
  }
  process.stdout.write(rendered);
}

const SEVERITY_ORDER: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function meetsThreshold(findings: Finding[], failOn: FailOn): boolean {
  if (failOn === "none") {
    return false;
  }
  const threshold = SEVERITY_ORDER[failOn];
  // A suppressed finding counts only when its rule downgraded it, and
  // then at the lower severity.
  return findings.some(
    (f) => countsForThreshold(f) && SEVERITY_ORDER[f.severity] <= threshold,
  );
}

function listOfSkipped(skipped: readonly string[]): string {
  return skipped.map((line) => `  - ${line}`).join("\n");
}

/**
 * The whole error message, indented to line up under a list item. The
 * specific reason starts on the second line, so printing only the first
 * line would leave it out.
 */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n").join("\n    ");
}

function readSummaries(file: string): BehavioralSummary[] {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new UsageError(`No file at ${resolved}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
  } catch (error) {
    throw new UsageError(
      `${resolved} is not JSON suss can read: ${reasonOf(error)}`,
    );
  }
  const result = safeParseSummaries(parsed);
  if (!result.success) {
    throw new UsageError(
      `suss could not read ${resolved} as summaries. It should be the output of \`suss extract\` or \`suss contract\`. What did not fit:\n${formatParseIssues(result.error.issues)}`,
    );
  }
  // A summary writes a named type once and refers to it by name after
  // that. Inline the definitions here so the checker compares the types'
  // structure and not two names.
  return result.data.map(summaryWithDefinitionsInlined);
}

function formatParseIssues(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): string {
  return issues
    .slice(0, 10)
    .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("\n");
}

/** How much of a report is printed in full. The rest is only counted. */
export interface ReportScope {
  /** Print every finding and every list in full. */
  all?: boolean;
  /** The severity the run fails on. Findings at or above it print in full. */
  failOn?: FailOn;
}

function scopeOf(options: { all?: boolean; failOn?: FailOn }): ReportScope {
  return {
    ...(options.all === true ? { all: true } : {}),
    ...(options.failOn !== undefined ? { failOn: options.failOn } : {}),
  };
}

/**
 * The severity a finding has to reach to print in full. It matches the
 * severity the run fails on, so every finding that sets the exit code is
 * printed and none is reduced to a count.
 */
function printedSeverity(failOn: FailOn | undefined): number {
  const threshold =
    failOn === undefined || failOn === "none" ? "error" : failOn;
  return SEVERITY_ORDER[threshold];
}

/**
 * Renders the findings for a person. Findings that fail the run print in
 * full and the rest are counted by kind, unless `scope.all` is set.
 * `--json` output does not go through here.
 */
export function renderFindings(
  findings: Finding[],
  confidence: ConfidenceLookup,
  scope: ReportScope = {},
): string {
  if (findings.length === 0) {
    return "No findings.\n";
  }

  const lines: string[] = [];
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity] += 1;
  }

  const printed = printedSeverity(scope.failOn);
  const shown =
    scope.all === true
      ? findings
      : findings.filter((f) => SEVERITY_ORDER[f.severity] <= printed);
  for (const f of shown) {
    lines.push(`${"─".repeat(60)}`);
    const sevLabel = formatSeverityHeader(f);
    lines.push(`[${sevLabel}] ${f.kind}`);
    lines.push(`  ${f.description}`);
    if (f.suppressed !== undefined) {
      lines.push(
        `  suppressed (${f.suppressed.effect}): ${f.suppressed.reason}`,
      );
    }
    lines.push(`  provider: ${formatSide(f.provider, confidence)}`);
    // A finding merged from several providers lists the other sources,
    // so a reviewer can see every provider that produced it.
    if (f.sources !== undefined && f.sources.length > 1) {
      const others = f.sources.filter((s) => s !== f.provider.summary);
      for (const other of others) {
        lines.push(`    also from: ${other}`);
      }
    }
    lines.push(`  consumer: ${formatSide(f.consumer, confidence)}`);
    lines.push(
      `  boundary: ${f.boundary.recognition} (${f.boundary.transport})${formatRoute(f.boundary)}`,
    );
    lines.push(...formatSuppressionRule(f));
  }
  if (shown.length > 0) {
    lines.push("─".repeat(60));
  }
  lines.push(
    `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${counts.error} error, ${counts.warning} warning, ${counts.info} info`,
  );
  lines.push(...notShownLines(findings, shown));

  return `${lines.join("\n")}\n`;
}

/**
 * A count, by kind, of the findings the report did not print. Empty
 * when every finding was printed.
 */
function notShownLines(
  findings: ReadonlyArray<Finding>,
  shown: ReadonlyArray<Finding>,
): string[] {
  const printedOut = new Set(shown);
  const hidden = findings.filter((f) => !printedOut.has(f));
  if (hidden.length === 0) {
    return [];
  }

  const perKind = new Map<string, number>();
  for (const f of hidden) {
    const key = `${f.kind} (${f.severity})`;
    perKind.set(key, (perKind.get(key) ?? 0) + 1);
  }
  const spelled = [...perKind]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${count} ${key}`)
    .join(", ");
  return [
    "",
    `Not shown: ${spelled}. Run the same command with --all to see ${hidden.length === 1 ? "it" : "them"}.`,
  ];
}

function formatSeverityHeader(f: Finding): string {
  if (
    f.suppressed !== undefined &&
    f.suppressed.effect === "downgrade" &&
    f.suppressed.originalSeverity !== undefined
  ) {
    return `${f.severity.toUpperCase()}, downgraded from ${f.suppressed.originalSeverity.toUpperCase()}`;
  }
  if (f.suppressed !== undefined && f.suppressed.effect !== "downgrade") {
    return `${f.severity.toUpperCase()}, suppressed`;
  }
  return f.severity.toUpperCase();
}

function formatSide(
  side: Finding["provider"],
  confidence: ConfidenceLookup,
): string {
  const loc = `${side.location.file}:${side.location.range.start}`;
  const info = confidence.get(side.summary);
  // Mention confidence only when it is below `high`, since that is when a
  // reviewer should weigh the finding. It never changes the severity.
  const conf =
    info !== undefined && info.level !== "high"
      ? ` (confidence: ${info.level})`
      : "";
  return `${side.summary} (${loc})${conf}`;
}

/**
 * A `.sussignore` rule that matches this finding and nothing else, ready
 * to paste.
 *
 * The rule has to key on the side that has the transition id. A finding
 * about a status the provider returns has its id on the provider side,
 * and a rule keyed on `consumer.transitionId` would never match it.
 *
 * A finding with no transition on either side gets no rule, because
 * `kind` plus `boundary` would also silence every other finding of that
 * kind on the boundary. A finding a rule already covers gets none either.
 */
function formatSuppressionRule(f: Finding): string[] {
  const rule = acceptingRule(f);
  if (rule === null || f.suppressed !== undefined) {
    return [];
  }
  const lines = [
    "  to silence this one, add to the rules in .sussignore.yml:",
    `    - kind: ${rule.kind}`,
  ];
  if (rule.boundary !== undefined) {
    lines.push(`      boundary: ${JSON.stringify(rule.boundary)}`);
  }

  for (const side of ["provider", "consumer"] as const) {
    const transitionId = rule[side]?.transitionId;
    if (transitionId !== undefined) {
      lines.push(
        `      ${side}: { transitionId: ${JSON.stringify(transitionId)} }`,
      );
    }
  }
  lines.push("      reason: TODO say why you accept this");
  return lines;
}

/** A `.sussignore` rule without its reason, which the person accepting it writes. */
export interface AcceptingRule {
  kind: Finding["kind"];
  boundary?: string;
  provider?: { transitionId: string };
  consumer?: { transitionId: string };
}

/**
 * The `.sussignore` rule that matches this finding and nothing else, or
 * null when no rule can be that narrow.
 */
export function acceptingRule(f: Finding): AcceptingRule | null {
  const side = findingTransitionSide(f);
  if (side === null) {
    return null;
  }
  const key = boundaryKey(f.boundary);
  return {
    kind: f.kind,
    ...(key !== null ? { boundary: key } : {}),
    [side.name]: { transitionId: side.transitionId },
  };
}

function findingTransitionSide(
  f: Finding,
): { name: "provider" | "consumer"; transitionId: string } | null {
  if (f.provider.transitionId !== undefined) {
    return { name: "provider", transitionId: f.provider.transitionId };
  }
  if (f.consumer.transitionId !== undefined) {
    return { name: "consumer", transitionId: f.consumer.transitionId };
  }
  return null;
}

function formatRoute(boundary: Finding["boundary"]): string {
  if (boundary.semantics.name !== "rest") {
    return "";
  }
  const { method, path } = boundary.semantics;
  if (method === null && path === null) {
    return "";
  }
  return ` ${method ?? ""} ${path ?? ""}`.trimEnd();
}

/**
 * How many message sends go to a queue or bus whose name the code works
 * out only at runtime. suss records these and cannot check them, so the
 * report prints the count to keep them from passing as checked. The
 * count is per send site, so a wrapper's summary and the summaries
 * derived from it do not count one send twice.
 */
function countRuntimeNamedCrossings(
  summaries: ReadonlyArray<BehavioralSummary>,
): number {
  const sites = new Set<string>();
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (
          effect.type !== "interaction" ||
          effect.interaction.class !== "message-send" ||
          effect.binding.semantics.name !== "message-bus" ||
          effect.binding.semantics.channel !== null
        ) {
          continue;
        }
        sites.add(
          `${summary.location.file}:${summary.location.range.start}:${effect.callee ?? ""}`,
        );
      }
    }
  }
  return sites.size;
}

function renderRuntimeNamedCrossings(count: number): string {
  if (count === 0) {
    return "";
  }
  return `\n${count} send${count === 1 ? "" : "s"} name${count === 1 ? "s" : ""} ${count === 1 ? "its" : "their"} queue or bus at runtime. Each is recorded; none can be checked from source.\n`;
}

/**
 * How many summaries describe a unit suss could not read all of. A run
 * with no findings agreed on everything it compared, and the report
 * prints this count so the reader knows how much of that code suss saw
 * only in part.
 */
function countSummariesWithGaps(
  summaries: ReadonlyArray<BehavioralSummary>,
): number {
  return summaries.filter((summary) => summary.gaps.length > 0).length;
}

function renderGapCoverage(withGaps: number, total: number): string {
  if (withGaps === 0) {
    return "";
  }
  const units = withGaps === 1 ? "one unit" : `${withGaps} units`;
  return `\nsuss met a call it could not follow in ${units}, of ${total}, so ${withGaps === 1 ? "that one is" : "those are"} described in part. \`suss inspect\` says which calls.\n`;
}

/**
 * When something went unpaired, lists the artifacts in `suss.json` that
 * this run never read, with the `suss contract` command for each.
 *
 * A declared artifact describes the other side of a boundary, so a run
 * that skips it leaves those boundaries with nothing to pair against.
 */
function renderUnreadArtifacts(
  summaries: ReadonlyArray<BehavioralSummary>,
  unmatched: CheckAllResult["unmatched"],
): string {
  if (unmatched.providers.length + unmatched.consumers.length === 0) {
    return "";
  }

  const project = readProjectFile(process.cwd());
  if (project === null) {
    return "";
  }

  const unread = unreadArtifacts(
    project,
    new Set(summaries.map((summary) => summary.location.file)),
  );
  if (unread.length === 0) {
    return "";
  }

  const lines = [
    "",
    `${unread.length} ${unread.length === 1 ? "artifact this project declares was" : "artifacts this project declares were"} not read, and ${unread.length === 1 ? "it describes" : "they describe"} the other side of a boundary:`,
    "",
  ];
  for (const entry of unread) {
    lines.push(
      `    suss contract --from ${entry.from} ${entry.file} -o summaries/${entry.from}.json`,
    );
  }
  lines.push("");
  lines.push("  Then check them together with suss check --dir summaries/.");
  return `${lines.join("\n")}\n`;
}

function renderDirHuman(
  result: CheckAllResult,
  confidence: ConfidenceLookup,
  scope: ReportScope,
  since: SinceReport | null,
): string {
  const all = scope.all === true;
  const lines: string[] = [];
  const { providers, consumers, unpairable } = result.unmatched;
  const noBoundary = unpairable.filter((u) => u.reason === "noBoundary");
  const nothingToCompare = unpairable.filter(
    (u) => u.reason === "unnamedBoundary",
  );

  // Print at most a screenful, then a count. A monorepo run has thousands
  // of these and they would bury the findings. `--json` includes them all.
  const listed = (grouped: Map<string, string[]>): string[] => {
    const out: string[] = [];
    let shown = 0;
    for (const [key, ids] of grouped) {
      if (shown === DIAGNOSTIC_LIMIT) {
        out.push(`  ... and ${grouped.size - shown} more`);
        break;
      }
      out.push(`  ${key}`);
      for (const id of ids) {
        out.push(`    ${id}`);
      }
      shown++;
    }
    return out;
  };

  // Open with how much was compared. "No findings" alone looks like a
  // pass even when nothing paired and nothing was checked.
  const comparedByBoundary = groupPairsByKey(result.pairs);
  if (comparedByBoundary.size > 0) {
    const count = comparedByBoundary.size;
    const noun = `boundar${count === 1 ? "y" : "ies"}`;
    lines.push(`Compared ${count} ${noun}${all ? ":" : "."}`);
    if (all) {
      for (const [key, sides] of comparedByBoundary) {
        lines.push(`  ${key}`);
        for (const side of sides) {
          lines.push(`    ${side}`);
        }
      }
    }
  } else {
    lines.push("Nothing was compared.");
    lines.push("");
    // Count by boundary, the way the lists below group them, so two
    // summaries of one route count as one route missing a client.
    lines.push(
      `  ${nothingComparedReason(groupByKey(providers).size, groupByKey(consumers).size)}`,
    );
    lines.push(
      "  Extract both sides of the boundary into the same folder, then check them together:",
    );
    lines.push(
      "    suss extract -p <tsconfig> -f <pack> -o summaries/<name>.json",
    );
    lines.push("    suss check --dir summaries/");
  }

  // Group by boundary. A route described by both a deploy template and
  // its handler is one boundary missing a client, and should count once.
  if (all) {
    if (providers.length > 0) {
      lines.push("");
      lines.push("Providers with no client to compare against:");
      lines.push(...listed(groupByKey(providers)));
    }

    if (consumers.length > 0) {
      lines.push("");
      lines.push("Clients with no provider to compare against:");
      lines.push(...listed(groupByKey(consumers)));
    }

    // Something crossed each of these boundaries unchecked, and a reader
    // deciding what to trust needs to see which.
    if (nothingToCompare.length > 0) {
      const many = nothingToCompare.length !== 1;
      lines.push("");
      lines.push(
        `Nothing in this run paired with ${many ? `these ${nothingToCompare.length} boundaries` : "this boundary"}, so nothing was checked across ${many ? "them" : "it"}:`,
      );
      lines.push(...listed(groupByKey(nothingToCompare)));
    }
  }

  // The closure pass adds dozens of internal helpers with no boundary.
  // That is normal, so they get one line of count and no list.
  const internal =
    noBoundary.length === 0
      ? null
      : `${noBoundary.length} other summar${noBoundary.length === 1 ? "y is" : "ies are"} internal code with no boundary, so nothing pairs with ${noBoundary.length === 1 ? "it" : "them"}.`;

  if (!all) {
    // When one side is empty, the block above already gave this count.
    // Printing it again would look like a second problem.
    const oneSided =
      comparedByBoundary.size === 0 &&
      (providers.length === 0 || consumers.length === 0);
    const counts = unpairedCounts(
      oneSided ? [] : providers,
      oneSided ? [] : consumers,
      nothingToCompare,
    );
    if (counts.length > 0) {
      lines.push("");
      for (const count of counts) {
        lines.push(`  ${count}`);
      }
      lines.push("  Run the same command with --all to list them.");
    }
  }

  if (internal !== null) {
    lines.push("", internal);
  }

  const unknownKinds = unpairable.filter((u) => u.reason === "unknownKind");
  if (unknownKinds.length > 0) {
    lines.push("");
    lines.push(
      `${unknownKinds.length} summar${unknownKinds.length === 1 ? "y carries" : "ies carry"} a kind this version does not know, likely written by a newer suss.`,
    );
  }

  lines.push(...findingLines(result, confidence, scope, since));
  return `${lines.join("\n")}\n`;
}

/** The end of the report: what changed since an earlier run, or every finding. */
function findingLines(
  result: CheckAllResult,
  confidence: ConfidenceLookup,
  scope: ReportScope,
  since: SinceReport | null,
): string[] {
  if (since !== null) {
    return ["", ...renderSince(since, confidence, scope)];
  }
  if (result.findings.length > 0) {
    return ["", renderFindings(result.findings, confidence, scope).trimEnd()];
  }
  if (result.pairs.length > 0) {
    return ["", "No findings. Every compared boundary agreed."];
  }
  return [];
}

/**
 * One sentence per kind of unpaired boundary, with a count by boundary
 * that matches how `--all` lists them. None of these are findings, and on
 * a monorepo the full lists run to thousands of lines.
 */
function unpairedCounts(
  providers: ReadonlyArray<{ id: string; key?: string | null }>,
  consumers: ReadonlyArray<{ id: string; key?: string | null }>,
  nothingToCompare: ReadonlyArray<{ id: string; key?: string | null }>,
): string[] {
  const counts: string[] = [];
  if (providers.length > 0) {
    const n = groupByKey(providers).size;
    counts.push(
      `${n} provider-side boundar${n === 1 ? "y has" : "ies have"} no client to compare against.`,
    );
  }
  if (consumers.length > 0) {
    const n = groupByKey(consumers).size;
    counts.push(
      `${n} client-side boundar${n === 1 ? "y has" : "ies have"} no provider to compare against.`,
    );
  }
  if (nothingToCompare.length > 0) {
    const n = nothingToCompare.length;
    counts.push(
      `${n} boundar${n === 1 ? "y" : "ies"} had nothing to pair with, so nothing was checked across ${n === 1 ? "it" : "them"}.`,
    );
  }
  return counts;
}

/**
 * Groups summaries under the boundary they describe. Each line under a
 * boundary is a full summary id, because two files can both export
 * `update` and the reader has to tell them apart.
 */
function groupByKey(
  entries: ReadonlyArray<{ id: string; key?: string | null }>,
): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const entry of entries) {
    fileUnderKey(byKey, entry.key ?? "no name to pair on", entry.id);
  }
  return byKey;
}

/**
 * Groups compared pairs under the boundary they met on. A route that a
 * service and its OpenAPI document both describe is one boundary with
 * two rows, so the report counts keys.
 */
function groupPairsByKey(
  pairs: ReadonlyArray<ComparedPair>,
): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const pair of pairs) {
    fileUnderKey(byKey, pair.key, `${pair.provider} <-> ${pair.consumer}`);
  }
  return byKey;
}

/** Adds a line under a key, skipping it when the key already lists that line. */
function fileUnderKey(
  byKey: Map<string, string[]>,
  key: string,
  line: string,
): void {
  const lines = byKey.get(key);
  if (lines === undefined) {
    byKey.set(key, [line]);
    return;
  }

  if (!lines.includes(line)) {
    lines.push(line);
  }
}

/** How many unpaired boundaries a report lists before it counts the rest. */
const DIAGNOSTIC_LIMIT = 10;

/** Why a run compared nothing, in terms of which side the user has and which is missing. */
function nothingComparedReason(
  providerCount: number,
  consumerCount: number,
): string {
  if (providerCount > 0 && consumerCount === 0) {
    return `These summaries cover ${providerCount} boundar${providerCount === 1 ? "y" : "ies"} on the provider side and none on the client side, so there was no other side to compare against.`;
  }
  if (consumerCount > 0 && providerCount === 0) {
    return `These summaries cover ${consumerCount} boundar${consumerCount === 1 ? "y" : "ies"} on the client side and none on the provider side, so there was no other side to compare against.`;
  }
  if (providerCount > 0 && consumerCount > 0) {
    return "No provider and client shared a boundary, so none of them line up. Check that the paths match, including any prefix your router adds.";
  }
  return "None of these summaries describe a boundary, so there was nothing to pair.";
}
