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
  checkAll,
  checkPair,
  countsForThreshold,
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
  CheckAllResult,
  ComparedPair,
  SuppressionRule,
} from "@suss/checker";
import type { CheckIntentResult, IntentFinding } from "@suss/checker-intent";

/**
 * Look up the summary-level confidence for a `Finding` side. The
 * checker stamps `side.summary` as `${file}::${name}`, which matches
 * the key we build here. Informational only: the checker does not
 * use confidence to decide anything; the human-output renderer
 * surfaces it so reviewers can weigh findings themselves.
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
  /** Override path to a .sussignore file. */
  sussignore?: string;
  /** Skip loading any .sussignore, even if one would be auto-discovered. */
  noSuppressions?: boolean;
  /** Print every finding and every list, not the collapsed report. */
  all?: boolean;
  /**
   * Opt out of the default: a run that doesn't compare anything exits
   * non-zero.
   *
   * A run that doesn't pair a single boundary produces no findings and
   * reads as a pass, the same answer it gives when both sides agree.
   * The two are worth telling apart: one means the code is consistent,
   * the other means suss couldn't see enough of it to say. `extract`
   * takes the same option for the same reason. Two-file `check` doesn't
   * build a pairing count to gate on, so this option is refused there
   * rather than read.
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
  /** Opt out of the default: a run that doesn't compare anything exits non-zero. See CheckOptions. */
  allowEmpty?: boolean;
  /**
   * Exit non-zero when more boundaries went unpaired than this allows:
   * a count ("25") or a share of all boundaries ("50%"). A run that
   * pairs three boundaries out of hundreds otherwise reads the same as
   * one that paired everything.
   */
  failOnUnpaired?: string;
  /**
   * Exit non-zero when a file in the directory could not be read as
   * summaries. Skipping one silently turns a truncated or malformed
   * file into a pass.
   */
  failOnUnreadable?: boolean;
  /**
   * Directory of team-authored intent specs (`*.intent` / `*.prd`).
   * When set, each boundary intent is paired against the code summaries
   * from `dir`, adding intent-coverage findings to the result.
   */
  intent?: string;
}

export interface CheckResult {
  findings: Finding[];
  /** Problems with the run itself, present only when there were any. */
  run?: RunFinding[];
  /**
   * Intent pass result (findings + checked / unchecked accounting),
   * present only when --intent was supplied.
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
  /** Which file each summary came from. */
  sourceFile: Map<BehavioralSummary, string>;
  /** Files in the directory that could not be read as summaries. */
  skipped: string[];
  /** The checker's own result, with suppressions already applied. */
  result: CheckAllResult;
  suppressions: SuppressionRule[];
  confidence: ConfidenceLookup;
}

/**
 * Read a directory of summaries and run every pass over it.
 *
 * `suss check --dir` and `suss check --at` both go through here, so a
 * scoped run is the full run with a filter over it rather than a second
 * way of checking that could answer differently.
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

  // .sussignore.json is auto-discovered from this same directory: it's
  // suppression config, not a summaries file, so exclude it from the walk.
  const entries = fs.readdirSync(resolved);
  const files = entries.filter(
    (f) =>
      f.endsWith(".json") &&
      !f.endsWith(".incomplete.json") &&
      !DEFAULT_SUPPRESSIONS_FILENAMES.includes(f),
  );

  // Extract leaves this note beside its output when it could not read
  // every export, so a check over those summaries is over a partial
  // picture and has to say so.
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
  // Which file each summary came from, so a caller can report a
  // boundary two different files both claim to provide.
  const sourceFile = new Map<BehavioralSummary, string>();
  const skipped: string[] = [];
  for (const file of files) {
    let read: BehavioralSummary[];
    try {
      read = readSummaries(path.join(resolved, file));
    } catch (error) {
      // A folder of summaries picks up files that are not summaries,
      // most often a report written back where they were read from.
      // Say which one and check the rest.
      skipped.push(`${file}: ${firstLineOf(error)}`);
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
  const {
    summaries: allSummaries,
    sourceFile,
    skipped,
    result,
    suppressions,
    confidence,
  } = checkDirectory(options);

  // Intent is a separate citizen with its own finding shape. When
  // --intent is supplied, pair it against the same code summaries and
  // render / score it alongside the behavioural findings rather than
  // folding it into that stream. The checker reports what it did and
  // didn't compare (checked / unchecked); this layer only renders.
  // The same .sussignore rules apply to both finding streams.
  const intent = runIntentPass(options.intent, allSummaries, suppressions);

  const collisions = findBoundaryCollisions(allSummaries, sourceFile);

  const runtimeNamedCrossings = countRuntimeNamedCrossings(allSummaries);
  const summariesWithGaps = countSummariesWithGaps(allSummaries);
  const run = [
    ...runFindings(options.allowEmpty !== true, allSummaries, result),
    ...unreadableFindings(options.failOnUnreadable === true, skipped),
    ...unpairedFindings(options.failOnUnpaired, result),
  ];

  const rendered = options.json
    ? `${JSON.stringify({ findings: result.findings, run, intent, pairs: result.pairs, unmatched: result.unmatched, skipped, runtimeNamedCrossings, summariesWithGaps, collisions }, null, 2)}\n`
    : renderDirHuman(result, confidence, scopeOf(options)) +
      renderRuntimeNamedCrossings(runtimeNamedCrossings) +
      renderGapCoverage(summariesWithGaps, allSummaries.length) +
      renderCollisions(collisions) +
      renderUnreadArtifacts(allSummaries, result.unmatched) +
      renderIntentSection(intent) +
      renderRunFindings(run);

  writeReport(rendered, options.output);

  const failOn = options.failOn ?? "error";
  return {
    findings: result.findings,
    ...(run.length > 0 ? { run } : {}),
    ...(intent !== undefined ? { intent } : {}),
    hasErrors:
      meetsThreshold(result.findings, failOn) ||
      intentMeetsThreshold(intent?.findings ?? [], failOn) ||
      run.length > 0,
    result,
  };
}

/**
 * What went wrong with the run, as findings rather than as an exit code
 * alone.
 *
 * A red exit with nothing to read stalls an automated fixer: it has
 * something to react to and nothing to act on. So a run that fails
 * because it didn't compare anything says so in the report, with what
 * to do about it, and the exit code follows from the finding.
 *
 * A run over no summaries at all is a different mistake, and the empty
 * run already says so, so this only fires where there was something to
 * compare and no pair came out of it.
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
 * suss identifies an HTTP boundary by its method and path, and records
 * nothing about which service serves it, so two services that both
 * expose `GET /users` end up on one key. Whoever calls either one then
 * pairs against both and gets findings from an API they never touch.
 *
 * One file per service is the usual layout, so two files providing one
 * key is a good sign that this happened. Reporting it beats comparing
 * unrelated services and saying nothing.
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

/** Re-raise as a UsageError, so runCli prints the sentence, not a stack. */
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
  // A doc that fails to load is something the author has to fix, so the
  // reason reaches them as a sentence rather than as a stack trace.
  const intents = attempt(() => loadIntentDirectory(intentDir));
  if (intents.length === 0) {
    // Same convention as an empty --dir: pointing at a directory with
    // nothing to load is a usage error, not a clean pass.
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
  // Same suppression semantics as behavioural findings: mark/hide are
  // excluded from gating, downgrade counts at the new severity.
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
  // Suppressed findings are excluded from threshold calculation unless
  // their effect was "downgrade" (in which case they count at the
  // downgraded severity). See @suss/checker/countsForThreshold.
  return findings.some(
    (f) => countsForThreshold(f) && SEVERITY_ORDER[f.severity] <= threshold,
  );
}

function listOfSkipped(skipped: readonly string[]): string {
  return skipped.map((line) => `  - ${line}`).join("\n");
}

function firstLineOf(error: unknown): string {
  return error instanceof Error
    ? (error.message.split("\n")[0] as string)
    : String(error);
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
      `${resolved} is not JSON suss can read: ${firstLineOf(error)}`,
    );
  }
  const result = safeParseSummaries(parsed);
  if (!result.success) {
    throw new UsageError(
      `suss could not read ${resolved} as summaries. It should be the output of \`suss extract\` or \`suss contract\`. What did not fit:\n${formatParseIssues(result.error.issues)}`,
    );
  }
  // Types are spelled out on the way in, so everything downstream
  // compares structure. A summary writes a named type once and refers
  // to it after that, and comparing two names compares nothing.
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

/** How much of a report gets written out rather than counted. */
export interface ReportScope {
  /** Write every finding and every list out. */
  all?: boolean;
  /** The threshold the run is gated on, which decides what prints. */
  failOn?: FailOn;
}

function scopeOf(options: { all?: boolean; failOn?: FailOn }): ReportScope {
  return {
    ...(options.all === true ? { all: true } : {}),
    ...(options.failOn !== undefined ? { failOn: options.failOn } : {}),
  };
}

/**
 * The severity a finding has to reach to be written out in full. It is
 * the threshold the run fails on, so nothing that decides the exit code
 * is ever left to a count.
 */
function printedSeverity(failOn: FailOn | undefined): number {
  const threshold =
    failOn === undefined || failOn === "none" ? "error" : failOn;
  return SEVERITY_ORDER[threshold];
}

/**
 * The findings, with whatever fails the run written out and the rest
 * counted. `--all` writes every one out. `--json` is unaffected.
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
    // When the finding was collapsed across multiple provider sources,
    // list the others below the primary so reviewers can see who
    // agreed. Skipped in the common single-source case to keep output
    // uncluttered.
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
 * What the report left out, counted by kind. Written only when
 * something was left out, so a run with errors alone reads as before.
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
  // Only annotate when the level is below `high`. A reviewer does not
  // need telling the analysis was confident; they need telling when it
  // was not. Informational only; checker severity is unchanged.
  const conf =
    info !== undefined && info.level !== "high"
      ? ` (confidence: ${info.level})`
      : "";
  return `${side.summary} (${loc})${conf}`;
}

/**
 * A `.sussignore` rule that matches this finding and nothing else,
 * ready to paste.
 *
 * Printing the transition alone left the reader to write the rule, and
 * which side the transition is on decides which discriminator the rule
 * needs. A finding about a status the provider returns keeps its id on
 * the provider side, so a rule keyed on `consumer.transitionId` would
 * never match it. Printing the whole rule takes that guesswork away.
 *
 * A finding with no transition on either side gets nothing: `kind` plus
 * `boundary` is the only rule left to write, and it would silence every
 * other finding of that kind on the same boundary too. A finding a rule
 * already covers gets nothing either.
 */
function formatSuppressionRule(f: Finding): string[] {
  const side = findingTransitionSide(f);
  if (side === null || f.suppressed !== undefined) {
    return [];
  }
  const key = boundaryKey(f.boundary);
  const lines = [
    "  to silence this one, add to the rules in .sussignore.yml:",
    `    - kind: ${f.kind}`,
  ];
  if (key !== null) {
    lines.push(`      boundary: ${JSON.stringify(key)}`);
  }
  lines.push(
    `      ${side.name}: { transitionId: ${JSON.stringify(side.transitionId)} }`,
    "      reason: TODO say why you accept this",
  );
  return lines;
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
 * How many message sends cross a boundary whose name the code only
 * works out at runtime. These get recorded but can never be checked,
 * and printing the count stops them looking like coverage. Counted per
 * distinct send site, so a wrapper's summary and the summaries derived
 * from it never report one send twice.
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
 * with no findings agreed on everything it compared, and this says how
 * much of the code those comparisons were standing for.
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
 * Artifacts `suss.json` says this project declares that this run never
 * read, when something went unpaired.
 *
 * The other side of a declared boundary lives in the artifact, so a run
 * without it pairs those boundaries with nothing. Saying which file and
 * which command turns an empty comparison into one edit.
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
): string {
  const all = scope.all === true;
  const lines: string[] = [];
  const { providers, consumers, unpairable } = result.unmatched;
  const noBoundary = unpairable.filter((u) => u.reason === "noBoundary");
  const nothingToCompare = unpairable.filter(
    (u) => u.reason === "unnamedBoundary",
  );

  /**
   * At most a screenful, then a count. A run over a monorepo has
   * thousands of these, and printing them all buries whatever the run
   * found. `--json` still includes every one.
   */
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

  // Lead with how much was actually compared. "No findings" on its own
  // looks like a pass, and a run where nothing paired has checked
  // nothing at all, which is the opposite of a pass.
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
    // Counted by boundary, matching how they are listed below. Two
    // summaries describing one route are one thing missing a client.
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

  // Group by boundary rather than by summary. One route described by
  // both a deploy template and its handler code is one boundary waiting
  // for a client, and listing it twice makes the count read wrong.
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

    // A line per unit, because something crossed the boundary and a
    // reader deciding what to trust needs to know it went unchecked.
    if (nothingToCompare.length > 0) {
      const many = nothingToCompare.length !== 1;
      lines.push("");
      lines.push(
        `Nothing in this run paired with ${many ? `these ${nothingToCompare.length} boundaries` : "this boundary"}, so nothing was checked across ${many ? "them" : "it"}:`,
      );
      lines.push(...listed(groupByKey(nothingToCompare)));
    }
  }

  // Internal helpers reached through the closure pass land here by the
  // dozen. Listing each one buries whatever else is on screen, and a
  // function with no boundary is the normal case rather than a problem.
  const internal =
    noBoundary.length === 0
      ? null
      : `${noBoundary.length} other summar${noBoundary.length === 1 ? "y is" : "ies are"} internal code with no boundary, so nothing pairs with ${noBoundary.length === 1 ? "it" : "them"}.`;

  if (!all) {
    // When one side of the run is empty, the block above already gave
    // that count in a sentence, and repeating it reads as a second
    // problem rather than the same one.
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

  if (result.findings.length > 0) {
    lines.push(
      "",
      renderFindings(result.findings, confidence, scope).trimEnd(),
    );
  } else if (result.pairs.length > 0) {
    lines.push("", "No findings. Every compared boundary agreed.");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * What went unpaired, one sentence per case, counted by boundary the
 * same way `--all` lists them. Nothing here is a finding, and on a
 * monorepo the lists run to thousands of lines.
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
 * Collapse summaries onto the boundary they describe. Each line under a
 * boundary is a summary id, because two files can both export `update`
 * and a reader has to be able to tell which one a line is about.
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
 * The compared sides under the boundary they met on. A route a service
 * and its OpenAPI document both describe is one boundary, so counting
 * the rows would say two.
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

/** A line the report has already printed under this key is not printed twice. */
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

/** Why a run compared nothing, in terms of what the user has and lacks. */
/** How many unpaired boundaries a report lists before it counts them. */
const DIAGNOSTIC_LIMIT = 10;

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
