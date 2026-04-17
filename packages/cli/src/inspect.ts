// inspect.ts — `suss inspect` command implementation
//
// Renders behavioral summaries as human-readable descriptions.
// Lead with what the code DOES (output), follow with WHEN (conditions).

import fs from "node:fs";
import path from "node:path";

import { diffSummaries } from "@suss/behavioral-ir";
import { pairSummaries } from "@suss/checker";

import type {
  BehavioralSummary,
  Gap,
  Output,
  Predicate,
  SummaryDiff,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Body shape rendering
// ---------------------------------------------------------------------------

/** Compact representation of a body shape: `{ id, name, email }` */
function formatBodyShape(shape: TypeShape | null | undefined): string {
  if (shape == null) {
    return "";
  }
  switch (shape.type) {
    case "record": {
      const keys = Object.keys(shape.properties);
      if (keys.length === 0) {
        return "{}";
      }
      if (keys.length <= 5) {
        return `{ ${keys.join(", ")} }`;
      }
      return `{ ${keys.slice(0, 4).join(", ")}, ... }`;
    }
    case "literal":
      return JSON.stringify(shape.value);
    case "ref":
      return shape.name;
    case "array":
      return `[${formatBodyShape(shape.items)}]`;
    case "dictionary":
      return `{ [key]: ${formatBodyShape(shape.values)} }`;
    case "union":
      return shape.variants.map(formatBodyShape).join(" | ");
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Condition rendering (human-readable)
// ---------------------------------------------------------------------------

function formatCondition(p: Predicate): string {
  switch (p.type) {
    case "comparison":
      return `${formatRef(p.left)} ${formatOp(p.op)} ${formatRef(p.right)}`;
    case "truthinessCheck":
      return p.negated ? `!${formatRef(p.subject)}` : formatRef(p.subject);
    case "nullCheck":
      return `${formatRef(p.subject)} ${p.negated ? "!=" : "=="} null`;
    case "typeCheck":
      return `typeof ${formatRef(p.subject)} === "${p.expectedType}"`;
    case "negation":
      // Simplify double negation: !(!(x)) → x, !(!x) → x
      if (p.operand.type === "negation") {
        return formatCondition(p.operand.operand);
      }
      if (p.operand.type === "truthinessCheck") {
        return formatCondition({ ...p.operand, negated: !p.operand.negated });
      }
      if (p.operand.type === "nullCheck") {
        return formatCondition({ ...p.operand, negated: !p.operand.negated });
      }
      return `!(${formatCondition(p.operand)})`;
    case "compound":
      return p.operands
        .map((o) => formatCondition(o))
        .join(p.op === "and" ? " && " : " || ");
    case "call":
      return `${p.callee}(${p.args.map(formatRef).join(", ")})`;
    case "propertyExists":
      return `${p.negated ? "!" : ""}${formatRef(p.subject)}.has("${p.property}")`;
    case "opaque":
      return p.sourceText;
  }
}

function formatOp(op: string): string {
  const ops: Record<string, string> = {
    eq: "===",
    neq: "!==",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  };
  return ops[op] ?? op;
}

function formatRef(v: ValueRef): string {
  switch (v.type) {
    case "literal":
      return JSON.stringify(v.value);
    case "input":
      return v.path.length > 0
        ? `${v.inputRef}.${v.path.join(".")}`
        : v.inputRef;
    case "dependency":
      return v.accessChain.length > 0
        ? `${v.name}().${v.accessChain.join(".")}`
        : `${v.name}()`;
    case "derived":
      return `${formatRef(v.from)}.${formatDerivation(v.derivation)}`;
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
      return d.field as string;
    case "methodCall":
      return `${d.method}()`;
    case "awaited":
      return "await";
    default:
      return "?";
  }
}

// ---------------------------------------------------------------------------
// Transition rendering — output-first
// ---------------------------------------------------------------------------

function formatOutput(output: Output): string {
  switch (output.type) {
    case "response": {
      const status =
        output.statusCode !== null ? formatRef(output.statusCode) : "???";
      const body = formatBodyShape(output.body);
      return body ? `${status} ${body}` : `${status}`;
    }
    case "throw":
      return `throw ${output.exceptionType ?? "Error"}`;
    case "render":
      return `render <${output.component} />`;
    case "return": {
      const body = formatBodyShape(output.value);
      return body ? `return ${body}` : "return";
    }
    case "delegate":
      return `delegate -> ${output.to}`;
    case "emit":
      return `emit "${output.event}"`;
    case "void":
      return "void";
  }
}

function formatTransition(
  t: Transition,
  declaredStatuses: Set<number> | null,
): string {
  const output = formatOutput(t.output);
  const conditions = t.conditions.map((c) => formatCondition(c)).join(" && ");

  let line = `    -> ${output}`;

  if (t.isDefault) {
    line += "  (default)";
  } else if (conditions) {
    line += `  when  ${conditions}`;
  }

  // Flag undeclared status codes
  if (declaredStatuses !== null && t.output.type === "response") {
    const sc = t.output.statusCode;
    if (sc !== null && sc.type === "literal" && typeof sc.value === "number") {
      if (!declaredStatuses.has(sc.value)) {
        line += "  !! undeclared";
      }
    }
  }

  return line;
}

// ---------------------------------------------------------------------------
// Gap rendering
// ---------------------------------------------------------------------------

function formatGap(g: Gap): string {
  return `    !! ${g.description}`;
}

// ---------------------------------------------------------------------------
// Summary rendering
// ---------------------------------------------------------------------------

function renderSummary(summary: BehavioralSummary): string {
  const lines: string[] = [];
  const binding = summary.identity.boundaryBinding;

  // Header: endpoint or function name
  if (binding?.method || binding?.path) {
    const method = binding.method ?? "";
    const endpoint = binding.path ?? "";
    lines.push(`${method} ${endpoint}`.trim());
  } else {
    lines.push(summary.identity.name);
  }

  // Metadata line
  const meta: string[] = [];
  if (binding !== null) {
    meta.push(`${binding.framework} ${summary.kind}`);
  }
  meta.push(`${summary.location.file}:${summary.location.range.start}`);
  if (summary.confidence.level !== "high") {
    meta.push(`confidence: ${summary.confidence.level}`);
  }
  lines.push(`  ${meta.join(" | ")}`);

  // Contract line
  const contract = summary.metadata?.declaredContract as
    | { responses: Array<{ statusCode: number }> }
    | undefined;
  let declaredStatuses: Set<number> | null = null;
  if (contract?.responses) {
    const statuses = contract.responses
      .map((r: { statusCode: number }) => r.statusCode)
      .sort((a: number, b: number) => a - b);
    declaredStatuses = new Set(statuses);
    lines.push(`  Contract: ${statuses.join(", ")}`);
  }

  // Transitions
  if (summary.transitions.length > 0) {
    lines.push("");
    for (const t of summary.transitions) {
      lines.push(formatTransition(t, declaredStatuses));
    }
  }

  // Gaps
  if (summary.gaps.length > 0) {
    lines.push("");
    for (const gap of summary.gaps) {
      lines.push(formatGap(gap));
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Inspect command
// ---------------------------------------------------------------------------

export interface InspectOptions {
  file: string;
}

export interface DirOptions {
  dir: string;
}

export interface DiffOptions {
  before: string;
  after: string;
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

  for (let i = 0; i < summaries.length; i++) {
    if (i > 0) {
      process.stdout.write("\n");
    }
    process.stdout.write(`${renderSummary(summaries[i])}\n`);
  }

  process.stdout.write(`\n${summaries.length} summaries inspected.\n`);
}

// ---------------------------------------------------------------------------
// Diff command
// ---------------------------------------------------------------------------

function summaryKey(s: BehavioralSummary): string {
  const binding = s.identity.boundaryBinding;
  if (binding?.method || binding?.path) {
    const method = binding.method ?? "*";
    const endpoint = binding.path ?? "*";
    return `${s.kind}:${method} ${endpoint}`;
  }
  return `${s.kind}::${s.identity.name}`;
}

function renderTransitionShort(t: Transition): string {
  const output = formatOutput(t.output);
  const conditions = t.conditions.map((c) => formatCondition(c)).join(" && ");
  if (t.isDefault) {
    return `${output}  (default)`;
  }
  return conditions ? `${output}  when  ${conditions}` : output;
}

function renderDiff(
  key: string,
  before: BehavioralSummary,
  diff: SummaryDiff,
): string {
  const lines: string[] = [];

  const total =
    diff.addedTransitions.length +
    diff.removedTransitions.length +
    diff.changedTransitions.length;

  lines.push(`${key}`);

  const binding = before.identity.boundaryBinding;
  if (binding !== null) {
    lines.push(`  ${binding.framework} ${before.kind}`);
  }

  lines.push(`  ${total} change${total === 1 ? "" : "s"}`);

  for (const t of diff.addedTransitions) {
    lines.push(`    + ${renderTransitionShort(t)}`);
  }

  for (const t of diff.removedTransitions) {
    lines.push(`    - ${renderTransitionShort(t)}`);
  }

  for (const { before: b, after: a } of diff.changedTransitions) {
    lines.push(`    ~ ${renderTransitionShort(b)}`);
    lines.push(`      -> ${renderTransitionShort(a)}`);
  }

  return lines.join("\n");
}

export function inspectDiff(options: DiffOptions): void {
  const beforePath = path.resolve(options.before);
  const afterPath = path.resolve(options.after);

  if (!fs.existsSync(beforePath)) {
    throw new Error(`File not found: ${beforePath}`);
  }
  if (!fs.existsSync(afterPath)) {
    throw new Error(`File not found: ${afterPath}`);
  }

  const beforeSummaries = JSON.parse(
    fs.readFileSync(beforePath, "utf-8"),
  ) as BehavioralSummary[];
  const afterSummaries = JSON.parse(
    fs.readFileSync(afterPath, "utf-8"),
  ) as BehavioralSummary[];

  // Index by key
  const beforeByKey = new Map<string, BehavioralSummary>();
  for (const s of beforeSummaries) {
    beforeByKey.set(summaryKey(s), s);
  }
  const afterByKey = new Map<string, BehavioralSummary>();
  for (const s of afterSummaries) {
    afterByKey.set(summaryKey(s), s);
  }

  let hasChanges = false;

  // New summaries (in after but not before)
  for (const [key, s] of afterByKey) {
    if (!beforeByKey.has(key)) {
      hasChanges = true;
      process.stdout.write(`+ ${key}\n`);
      process.stdout.write(
        `  new ${s.kind} with ${s.transitions.length} transition${s.transitions.length === 1 ? "" : "s"}\n\n`,
      );
    }
  }

  // Removed summaries (in before but not after)
  for (const [key, s] of beforeByKey) {
    if (!afterByKey.has(key)) {
      hasChanges = true;
      process.stdout.write(`- ${key}\n`);
      process.stdout.write(
        `  removed ${s.kind} (had ${s.transitions.length} transition${s.transitions.length === 1 ? "" : "s"})\n\n`,
      );
    }
  }

  // Changed summaries
  for (const [key, beforeS] of beforeByKey) {
    const afterS = afterByKey.get(key);
    if (afterS === undefined) {
      continue;
    }
    const diff = diffSummaries(beforeS, afterS);
    if (
      diff.addedTransitions.length === 0 &&
      diff.removedTransitions.length === 0 &&
      diff.changedTransitions.length === 0
    ) {
      continue;
    }
    hasChanges = true;
    process.stdout.write(`${renderDiff(key, beforeS, diff)}\n\n`);
  }

  if (!hasChanges) {
    process.stdout.write("No behavioral changes.\n");
  }
}

// ---------------------------------------------------------------------------
// Dir command — boundary pair overview
// ---------------------------------------------------------------------------

function readSummariesFromDir(dir: string): BehavioralSummary[] {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Directory not found: ${resolved}`);
  }

  const files = fs.readdirSync(resolved).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error(`No JSON files found in ${resolved}`);
  }

  const all: BehavioralSummary[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(resolved, file), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      all.push(...(parsed as BehavioralSummary[]));
    }
  }
  return all;
}

export function inspectDir(options: DirOptions): void {
  const summaries = readSummariesFromDir(options.dir);
  const result = pairSummaries(summaries);

  // Paired boundaries
  // Group pairs by key and show provider/consumer transition counts
  const pairsByKey = new Map<
    string,
    { providers: BehavioralSummary[]; consumers: BehavioralSummary[] }
  >();
  for (const pair of result.pairs) {
    let group = pairsByKey.get(pair.key);
    if (group === undefined) {
      group = { providers: [], consumers: [] };
      pairsByKey.set(pair.key, group);
    }
    if (!group.providers.includes(pair.provider)) {
      group.providers.push(pair.provider);
    }
    if (!group.consumers.includes(pair.consumer)) {
      group.consumers.push(pair.consumer);
    }
  }

  if (pairsByKey.size > 0) {
    process.stdout.write(
      `${pairsByKey.size} paired boundar${pairsByKey.size === 1 ? "y" : "ies"}:\n\n`,
    );

    for (const [key, group] of pairsByKey) {
      process.stdout.write(`  ${key}\n`);
      for (const p of group.providers) {
        const binding = p.identity.boundaryBinding;
        const fw = binding?.framework ?? "?";
        process.stdout.write(
          `    provider: ${p.identity.name} (${fw}, ${p.transitions.length} transitions)\n`,
        );
      }
      for (const c of group.consumers) {
        const binding = c.identity.boundaryBinding;
        const fw = binding?.framework ?? "?";
        process.stdout.write(
          `    client:   ${c.identity.name} (${fw}, ${c.transitions.length} transitions)\n`,
        );
      }
    }
  }

  // Unmatched
  const { providers, consumers, noBinding } = result.unmatched;
  const unmatchedCount = providers.length + consumers.length + noBinding.length;

  if (unmatchedCount > 0) {
    if (pairsByKey.size > 0) {
      process.stdout.write("\n");
    }
    process.stdout.write(`${unmatchedCount} unmatched:\n`);
    for (const p of providers) {
      const key =
        p.identity.boundaryBinding?.method && p.identity.boundaryBinding.path
          ? `${p.identity.boundaryBinding.method} ${p.identity.boundaryBinding.path}`
          : "no path";
      process.stdout.write(
        `  ${p.identity.name} (${key}) — no matching client\n`,
      );
    }
    for (const c of consumers) {
      const key =
        c.identity.boundaryBinding?.method && c.identity.boundaryBinding.path
          ? `${c.identity.boundaryBinding.method} ${c.identity.boundaryBinding.path}`
          : "no path";
      process.stdout.write(
        `  ${c.identity.name} (${key}) — no matching provider\n`,
      );
    }
    for (const s of noBinding) {
      process.stdout.write(`  ${s.identity.name} — no boundary binding\n`);
    }
  }

  if (pairsByKey.size === 0 && unmatchedCount === 0) {
    process.stdout.write("No summaries found.\n");
  }

  process.stdout.write(
    `\n${summaries.length} summaries from ${fs.readdirSync(path.resolve(options.dir)).filter((f) => f.endsWith(".json")).length} files.\n`,
  );
}
