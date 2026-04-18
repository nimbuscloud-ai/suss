import fs from "node:fs";
import path from "node:path";

import { safeParseSummaries } from "@suss/behavioral-ir";
import { checkAll, checkPair } from "@suss/checker";

import type {
  BehavioralSummary,
  ConfidenceInfo,
  Finding,
} from "@suss/behavioral-ir";
import type { CheckAllResult } from "@suss/checker";

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
}

export interface CheckDirOptions {
  dir: string;
  json?: boolean;
  output?: string;
  failOn?: FailOn;
}

export interface CheckResult {
  findings: Finding[];
  hasErrors: boolean;
}

export function check(options: CheckOptions): CheckResult {
  const providerSummaries = readSummaries(options.providerFile);
  const consumerSummaries = readSummaries(options.consumerFile);

  const findings: Finding[] = [];
  for (const provider of providerSummaries) {
    for (const consumer of consumerSummaries) {
      findings.push(...checkPair(provider, consumer));
    }
  }

  const confidence = buildConfidenceLookup(
    providerSummaries,
    consumerSummaries,
  );
  return emitFindings(findings, confidence, options);
}

export function checkDir(
  options: CheckDirOptions,
): CheckResult & { result: CheckAllResult } {
  const resolved = path.resolve(options.dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Directory not found: ${resolved}`);
  }

  const files = fs.readdirSync(resolved).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error(`No JSON files found in ${resolved}`);
  }

  const allSummaries: BehavioralSummary[] = [];
  for (const file of files) {
    allSummaries.push(...readSummaries(path.join(resolved, file)));
  }

  const result = checkAll(allSummaries);
  const confidence = buildConfidenceLookup(allSummaries);

  const rendered = options.json
    ? `${JSON.stringify({ findings: result.findings, pairs: result.pairs, unmatched: result.unmatched }, null, 2)}\n`
    : renderDirHuman(result, confidence);

  if (options.output !== undefined) {
    fs.writeFileSync(options.output, rendered);
  } else {
    process.stdout.write(rendered);
  }

  return {
    findings: result.findings,
    hasErrors: meetsThreshold(result.findings, options.failOn ?? "error"),
    result,
  };
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
  return findings.some((f) => SEVERITY_ORDER[f.severity] <= threshold);
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
    lines.push(`[${f.severity.toUpperCase()}] ${f.kind}`);
    lines.push(`  ${f.description}`);
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
      `  boundary: ${f.boundary.framework} (${f.boundary.protocol})${formatRoute(f.boundary)}`,
    );
  }
  lines.push("─".repeat(60));
  lines.push(
    `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${counts.error} error, ${counts.warning} warning, ${counts.info} info`,
  );

  return `${lines.join("\n")}\n`;
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
  if (boundary.method !== undefined || boundary.path !== undefined) {
    const method = boundary.method ?? "";
    const p = boundary.path ?? "";
    return ` ${method} ${p}`.trimEnd();
  }
  return "";
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
