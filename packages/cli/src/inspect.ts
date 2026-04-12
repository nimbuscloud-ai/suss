// inspect.ts — `suss inspect` command implementation

import fs from "node:fs";
import path from "node:path";

import type {
  BehavioralSummary,
  Gap,
  Output,
  Predicate,
  Transition,
  ValueRef,
} from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatPredicate(p: Predicate): string {
  switch (p.type) {
    case "comparison":
      return `${formatValueRef(p.left)} ${p.op} ${formatValueRef(p.right)}`;
    case "truthinessCheck":
      return `${p.negated ? "!" : ""}${formatValueRef(p.subject)}`;
    case "nullCheck":
      return `${formatValueRef(p.subject)} ${p.negated ? "!=" : "=="} null`;
    case "typeCheck":
      return `typeof ${formatValueRef(p.subject)} === "${p.expectedType}"`;
    case "negation":
      return `!(${formatPredicate(p.operand)})`;
    case "compound":
      return p.operands
        .map((o) => formatPredicate(o))
        .join(p.op === "and" ? " && " : " || ");
    case "call":
      return `${p.callee}(${p.args.map(formatValueRef).join(", ")})`;
    case "propertyExists":
      return `${p.negated ? "!" : ""}${formatValueRef(p.subject)}.has("${p.property}")`;
    case "opaque":
      return p.sourceText;
  }
}

function formatValueRef(v: ValueRef): string {
  switch (v.type) {
    case "literal":
      return JSON.stringify(v.value);
    case "input":
      return `${v.inputRef}${v.path.length > 0 ? `.${v.path.join(".")}` : ""}`;
    case "dependency":
      return `${v.name}()${v.accessChain.length > 0 ? `.${v.accessChain.join(".")}` : ""}`;
    case "derived":
      return `${formatValueRef(v.from)}.${formatDerivation(v.derivation)}`;
    case "state":
      return `state.${v.name}`;
    case "unresolved":
      return v.sourceText;
  }
}

function formatDerivation(d: { type: string; [key: string]: unknown }): string {
  switch (d.type) {
    case "propertyAccess":
      return d.property as string;
    case "indexAccess":
      return `[${d.index}]`;
    case "destructured":
      return `{${d.field}}`;
    case "methodCall":
      return `${d.method}()`;
    case "awaited":
      return "await";
    default:
      return "?";
  }
}

function formatOutput(output: Output): string {
  switch (output.type) {
    case "response": {
      const status =
        output.statusCode !== null ? formatValueRef(output.statusCode) : "?";
      return `response ${status}`;
    }
    case "throw":
      return `throw ${output.exceptionType ?? "Error"}`;
    case "render":
      return `render <${output.component} />`;
    case "return":
      return "return";
    case "delegate":
      return `delegate → ${output.to}`;
    case "emit":
      return `emit "${output.event}"`;
    case "void":
      return "void";
  }
}

function formatTransition(t: Transition, idx: number): string {
  const lines: string[] = [];
  const label = t.isDefault ? `[${idx}] DEFAULT` : `[${idx}]`;

  const conditions = t.conditions.map((c) => formatPredicate(c)).join(" AND ");

  lines.push(`  ${label} ${conditions || "(unconditional)"}`);
  lines.push(`    → ${formatOutput(t.output)}`);

  return lines.join("\n");
}

function formatGap(g: Gap): string {
  return `  - ${g.type}: ${g.description}`;
}

// ---------------------------------------------------------------------------
// Inspect command
// ---------------------------------------------------------------------------

export interface InspectOptions {
  file: string;
}

export function inspect(options: InspectOptions): void {
  const filePath = path.resolve(options.file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const summaries = JSON.parse(content) as BehavioralSummary[];

  if (!Array.isArray(summaries)) {
    throw new Error("Expected a JSON array of BehavioralSummary objects");
  }

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    const method = binding?.method !== undefined ? `${binding.method} ` : "";
    const endpoint = `${method}${binding?.path ?? ""}`;

    process.stdout.write(`\n${"─".repeat(60)}\n`);
    process.stdout.write(`${summary.identity.name} (${summary.kind})\n`);
    if (binding !== null) {
      process.stdout.write(`  ${binding.framework} | ${endpoint}\n`);
    }
    process.stdout.write(
      `  file: ${summary.location.file}:${summary.location.range.start}\n`,
    );
    process.stdout.write(`  confidence: ${summary.confidence.level}\n`);

    if (summary.transitions.length > 0) {
      process.stdout.write("\n  Transitions:\n");
      for (let i = 0; i < summary.transitions.length; i++) {
        process.stdout.write(
          `${formatTransition(summary.transitions[i], i)}\n`,
        );
      }
    }

    if (summary.gaps.length > 0) {
      process.stdout.write("\n  Gaps:\n");
      for (const gap of summary.gaps) {
        process.stdout.write(`${formatGap(gap)}\n`);
      }
    }
  }

  process.stdout.write(`\n${summaries.length} summaries inspected.\n`);
}
