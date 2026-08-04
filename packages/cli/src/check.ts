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

import {
  DEFAULT_SUPPRESSIONS_FILENAMES,
  loadSuppressionsOrEmpty,
} from "./suppressionsLoader.js";

import type {
  BehavioralSummary,
  ConfidenceInfo,
  Finding,
} from "@suss/behavioral-ir";
import type { CheckAllResult, SuppressionRule } from "@suss/checker";
import type { CheckIntentResult, IntentFinding } from "@suss/checker-intent";

/**
 * Look up the summary-level confidence for a `Finding` side. The
 * checker stamps `side.summary` as `${file}::${name}`, which matches
 * the key we build here. Informational only — the checker does not
 * use confidence to decide anything; the human-output renderer
 * surfaces it so reviewers can weigh findings themselves.
 */
type ConfidenceLookup = Map<string, ConfidenceInfo>;

function buildConfidenceLookup(
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
}

export interface CheckDirOptions {
  dir: string;
  json?: boolean;
  output?: string;
  failOn?: FailOn;
  sussignore?: string;
  noSuppressions?: boolean;
  /**
   * Directory of team-authored intent specs (`*.intent` / `*.prd`).
   * When set, each boundary intent is paired against the code summaries
   * from `dir`, adding intent-coverage findings to the result.
   */
  intent?: string;
}

export interface CheckResult {
  findings: Finding[];
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

export function checkDir(
  options: CheckDirOptions,
): CheckResult & { result: CheckAllResult } {
  const resolved = path.resolve(options.dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(
      `No directory at ${resolved}. Pass the folder holding the summary files you wrote with \`suss extract -o\`.`,
    );
  }

  // .sussignore.json is auto-discovered from this same directory — it's
  // suppression config, not a summaries file, so exclude it from the walk.
  const files = fs
    .readdirSync(resolved)
    .filter(
      (f) => f.endsWith(".json") && !DEFAULT_SUPPRESSIONS_FILENAMES.includes(f),
    );
  if (files.length === 0) {
    throw new Error(
      `${resolved} has no JSON files in it. Write summaries there first, for example: suss extract -p tsconfig.json -f express -o ${path.join(options.dir, "api.json")}`,
    );
  }

  const allSummaries: BehavioralSummary[] = [];
  // Which file each summary came from, so a boundary drawing providers
  // from two of them can be called out below.
  const sourceFile = new Map<BehavioralSummary, string>();
  for (const file of files) {
    for (const summary of readSummaries(path.join(resolved, file))) {
      allSummaries.push(summary);
      sourceFile.set(summary, file);
    }
  }

  const rawResult = checkAll(allSummaries);
  const suppressions = loadSuppressionsForOptions(options, resolved);
  const result: CheckAllResult = {
    ...rawResult,
    findings: applySuppressions(rawResult.findings, suppressions),
  };
  const confidence = buildConfidenceLookup(allSummaries);

  // Intent is a separate citizen with its own finding shape. When
  // --intent is supplied, pair it against the same code summaries and
  // render / score it alongside the behavioural findings rather than
  // folding it into that stream. The checker reports what it did and
  // didn't compare (checked / unchecked); this layer only renders.
  // The same .sussignore rules apply to both finding streams.
  const intent = runIntentPass(options.intent, allSummaries, suppressions);

  const collisions = findBoundaryCollisions(allSummaries, sourceFile);

  const rendered = options.json
    ? `${JSON.stringify({ findings: result.findings, intent, pairs: result.pairs, unmatched: result.unmatched, collisions }, null, 2)}\n`
    : renderDirHuman(result, confidence) +
      renderCollisions(collisions) +
      renderIntentSection(intent);

  if (options.output !== undefined) {
    fs.writeFileSync(options.output, rendered);
  } else {
    process.stdout.write(rendered);
  }

  const failOn = options.failOn ?? "error";
  return {
    findings: result.findings,
    ...(intent !== undefined ? { intent } : {}),
    hasErrors:
      meetsThreshold(result.findings, failOn) ||
      intentMeetsThreshold(intent?.findings ?? [], failOn),
    result,
  };
}

/** A boundary whose providers came from more than one summary file. */
interface BoundaryCollision {
  key: string;
  files: string[];
}

/**
 * Boundaries that two different summary files both claim to provide.
 *
 * suss identifies an HTTP boundary by its method and path, with nothing
 * to say which service serves it, so two services that both expose
 * `GET /users` land on one key. Whoever calls either one then pairs
 * against both and gets findings from an API they never touch.
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

function runIntentPass(
  intentDir: string | undefined,
  code: BehavioralSummary[],
  suppressions: SuppressionRule[],
): CheckIntentResult | undefined {
  if (intentDir === undefined) {
    return undefined;
  }
  const intents = loadIntentDirectory(intentDir);
  if (intents.length === 0) {
    // Same convention as an empty --dir: pointing at a directory with
    // nothing to load is a usage error, not a clean pass.
    throw new Error(
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
    lines.push(`  [${f.severity}] ${f.boundary} — ${f.message}`);
    if (f.suppressed !== undefined) {
      lines.push(
        `    suppressed (${f.suppressed.effect}): ${f.suppressed.reason}`,
      );
    }
  }
  for (const u of intent.unchecked) {
    lines.push(`  not checked: ${u.intent} — ${u.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

function emitFindings(
  findings: Finding[],
  confidence: ConfidenceLookup,
  options: { json?: boolean; output?: string; failOn?: FailOn },
): CheckResult {
  const rendered = options.json
    ? `${JSON.stringify(findings, null, 2)}\n`
    : renderHuman(findings, confidence);

  if (options.output !== undefined) {
    fs.writeFileSync(options.output, rendered);
  } else {
    process.stdout.write(rendered);
  }

  return {
    findings,
    hasErrors: meetsThreshold(findings, options.failOn ?? "error"),
  };
}

const SEVERITY_ORDER: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function meetsThreshold(findings: Finding[], failOn: FailOn): boolean {
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

function readSummaries(file: string): BehavioralSummary[] {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`No file at ${resolved}.`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
  const result = safeParseSummaries(parsed);
  if (!result.success) {
    throw new Error(
      `suss could not read ${resolved} as summaries. It should be the output of \`suss extract\` or \`suss contract\`. What did not fit:\n${formatParseIssues(result.error.issues)}`,
    );
  }
  // Spelled out on the way in, so everything downstream reads
  // structure. A summary writes a named type once and refers to it
  // after that, and a comparison of two names is not a comparison.
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

function renderHuman(
  findings: Finding[],
  confidence: ConfidenceLookup,
): string {
  if (findings.length === 0) {
    return "No findings.\n";
  }

  const lines: string[] = [];
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity] += 1;
  }

  for (const f of findings) {
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
  lines.push("─".repeat(60));
  lines.push(
    `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${counts.error} error, ${counts.warning} warning, ${counts.info} info`,
  );

  return `${lines.join("\n")}\n`;
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
 * Naming the transition alone left the reader to write the rule, and
 * the side it sits on decides which discriminator to write it under. A
 * finding about a status the provider produces carries its id on the
 * provider side, and a rule keyed on `consumer.transitionId` would
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

/** Which side of a finding carries the transition it points at. */
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
  if (method === "" && path === "") {
    return "";
  }
  return ` ${method} ${path}`.trimEnd();
}

function renderDirHuman(
  result: CheckAllResult,
  confidence: ConfidenceLookup,
): string {
  const lines: string[] = [];
  const { providers, consumers, noBinding } = result.unmatched;

  // Lead with how much was actually compared. "No findings" on its own
  // reads as a pass, and a run where nothing paired has checked nothing
  // at all, which is the opposite of a pass.
  if (result.pairs.length > 0) {
    lines.push(
      `Compared ${result.pairs.length} boundar${result.pairs.length === 1 ? "y" : "ies"}:`,
    );
    for (const pair of result.pairs) {
      lines.push(`  ${pair.key}: ${pair.provider} <-> ${pair.consumer}`);
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
  if (providers.length > 0) {
    lines.push("");
    lines.push("Providers with no client to compare against:");
    for (const [key, names] of groupByKey(providers)) {
      lines.push(`  ${key}`);
      lines.push(`    ${names.join(", ")}`);
    }
  }

  if (consumers.length > 0) {
    lines.push("");
    lines.push("Clients with no provider to compare against:");
    for (const [key, names] of groupByKey(consumers)) {
      lines.push(`  ${key}`);
      lines.push(`    ${names.join(", ")}`);
    }
  }

  // Internal helpers reached through the closure pass land here by the
  // dozen. Listing each one buries whatever else is on screen, and a
  // function with no boundary is the normal case rather than a problem.
  if (noBinding.length > 0) {
    lines.push("");
    lines.push(
      `${noBinding.length} other summar${noBinding.length === 1 ? "y is" : "ies are"} internal code with no boundary, so nothing pairs with ${noBinding.length === 1 ? "it" : "them"}.`,
    );
  }

  lines.push("");

  if (result.findings.length > 0) {
    lines.push(renderHuman(result.findings, confidence).trimEnd());
  } else if (result.pairs.length > 0) {
    lines.push("No findings. Every compared boundary agreed.");
  }

  return `${lines.join("\n")}\n`;
}

/** Collapse summaries onto the boundary they describe. */
function groupByKey(
  entries: ReadonlyArray<{ name: string; key?: string | null }>,
): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const entry of entries) {
    const key = entry.key ?? "no path";
    const names = byKey.get(key);
    if (names !== undefined) {
      names.push(entry.name);
    } else {
      byKey.set(key, [entry.name]);
    }
  }
  return byKey;
}

/** Why a run compared nothing, in terms of what the user has and lacks. */
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
