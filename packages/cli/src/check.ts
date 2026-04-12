import fs from "node:fs";
import path from "node:path";

import { checkPair } from "@suss/checker";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";

export interface CheckOptions {
  providerFile: string;
  consumerFile: string;
  json?: boolean;
  output?: string;
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

  const rendered = options.json
    ? `${JSON.stringify(findings, null, 2)}\n`
    : renderHuman(findings);

  if (options.output !== undefined) {
    fs.writeFileSync(options.output, rendered);
  } else {
    process.stdout.write(rendered);
  }

  return {
    findings,
    hasErrors: findings.some((f) => f.severity === "error"),
  };
}

function readSummaries(file: string): BehavioralSummary[] {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a JSON array of BehavioralSummary objects in ${resolved}`,
    );
  }
  return parsed as BehavioralSummary[];
}

function renderHuman(findings: Finding[]): string {
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
    lines.push(`  provider: ${formatSide(f.provider)}`);
    lines.push(`  consumer: ${formatSide(f.consumer)}`);
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

function formatSide(side: Finding["provider"]): string {
  const loc = `${side.location.file}:${side.location.range.start}`;
  const txn = side.transitionId ? ` @ ${side.transitionId}` : "";
  return `${side.summary}${txn} (${loc})`;
}

function formatRoute(boundary: Finding["boundary"]): string {
  if (boundary.method !== undefined || boundary.path !== undefined) {
    const method = boundary.method ?? "";
    const p = boundary.path ?? "";
    return ` ${method} ${p}`.trimEnd();
  }
  return "";
}
