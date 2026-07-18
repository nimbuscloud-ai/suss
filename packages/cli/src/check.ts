import fs from "node:fs";
import path from "node:path";

import { safeParseSummaries } from "@suss/behavioral-ir";
import {
  applySuppressions,
  checkAll,
  checkPair,
  countsForThreshold,
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
      map.set(`${s.location.file}::${s.identity.name}`, s.confidence);
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
    throw new Error(`Directory not found: ${resolved}`);
  }

  // .sussignore.json is auto-discovered from this same directory — it's
  // suppression config, not a summaries file, so exclude it from the walk.
  const files = fs
    .readdirSync(resolved)
    .filter(
      (f) => f.endsWith(".json") && !DEFAULT_SUPPRESSIONS_FILENAMES.includes(f),
    );
  if (files.length === 0) {
    throw new Error(`No JSON files found in ${resolved}`);
  }

  const allSummaries: BehavioralSummary[] = [];
  for (const file of files) {
    allSummaries.push(...readSummaries(path.join(resolved, file)));
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

  const rendered = options.json
    ? `${JSON.stringify({ findings: result.findings, intent, pairs: result.pairs, unmatched: result.unmatched }, null, 2)}\n`
    : renderDirHuman(result, confidence) + renderIntentSection(intent);

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
      `No intent docs (*.intent.{yaml,yml,json} / *.prd.{yaml,yml,json}) found in ${intentDir}`,
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
    throw new Error(`File not found: ${resolved}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
  const result = safeParseSummaries(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid summary file ${resolved}:\n${formatParseIssues(result.error.issues)}`,
    );
  }
  return result.data;
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
  const txn = side.transitionId ? ` @ ${side.transitionId}` : "";
  const info = confidence.get(side.summary);
  // Only annotate when the level is below `high` — reviewers don't need
  // to know the analysis was confident; they need to know when it
  // wasn't. Informational only; checker severity is unchanged.
  const conf =
    info !== undefined && info.level !== "high"
      ? ` (confidence: ${info.level})`
      : "";
  return `${side.summary}${txn} (${loc})${conf}`;
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

  // Pairing summary
  lines.push(
    `Paired ${result.pairs.length} provider-consumer combination${result.pairs.length === 1 ? "" : "s"}:`,
  );
  for (const pair of result.pairs) {
    lines.push(`  ${pair.key}: ${pair.provider} <-> ${pair.consumer}`);
  }

  const { providers, consumers, noBinding } = result.unmatched;
  if (providers.length > 0 || consumers.length > 0 || noBinding.length > 0) {
    lines.push("");
    lines.push("Unmatched:");
    for (const p of providers) {
      lines.push(
        `  provider ${p.name} (${p.key ?? "no path"}) — no matching consumer`,
      );
    }
    for (const c of consumers) {
      lines.push(
        `  consumer ${c.name} (${c.key ?? "no path"}) — no matching provider`,
      );
    }
    for (const name of noBinding) {
      lines.push(`  ${name} — no boundary binding`);
    }
  }

  lines.push("");

  // Findings
  if (result.findings.length === 0) {
    lines.push("No findings.");
  } else {
    lines.push(renderHuman(result.findings, confidence).trimEnd());
  }

  return `${lines.join("\n")}\n`;
}
