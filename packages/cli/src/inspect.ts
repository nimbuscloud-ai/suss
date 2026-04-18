// inspect.ts — `suss inspect` command implementation
//
// Renders behavioral summaries as human-readable descriptions.
// Lead with what the code DOES (output), follow with WHEN (conditions).

import fs from "node:fs";
import path from "node:path";

import { diffSummaries, safeParseSummaries } from "@suss/behavioral-ir";
import { pairSummaries } from "@suss/checker";

import type {
  BehavioralSummary,
  Derivation,
  Gap,
  Output,
  Predicate,
  SummaryDiff,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Variant dispatch helper
// ---------------------------------------------------------------------------
//
// Each renderer below is a Record<Variant["type"], handler> rather than a
// switch statement so that adding a new variant to the IR becomes a type
// error here at definition time, not a silent default-case fallback at
// runtime. dispatchByType is the one place we cast back to the union type
// — the caller only sees a typed result.

type DispatchTable<T extends { type: string }, R> = {
  [K in T["type"]]: (variant: Extract<T, { type: K }>) => R;
};

function dispatchByType<T extends { type: string }, R>(
  table: DispatchTable<T, R>,
  value: T,
): R {
  // The double cast is the deliberate seam between the well-typed table
  // (per-variant narrowing) and the runtime lookup (one cast, one place).
  const handler = (table as unknown as Record<string, (v: T) => R>)[value.type];
  return handler(value);
}

// ---------------------------------------------------------------------------
// Body shape rendering
// ---------------------------------------------------------------------------

const SHAPE_FORMATTERS: DispatchTable<TypeShape, string> = {
  record: (s) => {
    const keys = Object.keys(s.properties);
    if (keys.length === 0) {
      return "{}";
    }
    if (keys.length <= 5) {
      return `{ ${keys.join(", ")} }`;
    }
    return `{ ${keys.slice(0, 4).join(", ")}, ... }`;
  },
  literal: (s) => JSON.stringify(s.value),
  ref: (s) => s.name,
  array: (s) => `[${formatBodyShape(s.items)}]`,
  dictionary: (s) => `{ [key]: ${formatBodyShape(s.values)} }`,
  union: (s) => s.variants.map(formatBodyShape).join(" | "),
  text: () => "string",
  integer: () => "int",
  number: () => "number",
  boolean: () => "bool",
  null: () => "null",
  undefined: () => "undefined",
  unknown: () => "any",
};

/** Compact representation of a body shape: `{ id, name, email }` */
function formatBodyShape(shape: TypeShape | null | undefined): string {
  if (shape == null) {
    return "";
  }
  return dispatchByType(SHAPE_FORMATTERS, shape);
}

// ---------------------------------------------------------------------------
// Condition rendering (human-readable)
// ---------------------------------------------------------------------------

const CONDITION_FORMATTERS: DispatchTable<Predicate, string> = {
  comparison: (p) =>
    `${formatRef(p.left)} ${formatOp(p.op)} ${formatRef(p.right)}`,
  truthinessCheck: (p) =>
    p.negated ? `!${formatRef(p.subject)}` : formatRef(p.subject),
  nullCheck: (p) => `${formatRef(p.subject)} ${p.negated ? "!=" : "=="} null`,
  typeCheck: (p) => `typeof ${formatRef(p.subject)} === "${p.expectedType}"`,
  negation: (p) => {
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
  },
  compound: (p) =>
    p.operands
      .map((o) => formatCondition(o))
      .join(p.op === "and" ? " && " : " || "),
  call: (p) => `${p.callee}(${p.args.map(formatRef).join(", ")})`,
  propertyExists: (p) =>
    `${p.negated ? "!" : ""}${formatRef(p.subject)}.has("${p.property}")`,
  opaque: (p) => p.sourceText,
};

function formatCondition(p: Predicate): string {
  return dispatchByType(CONDITION_FORMATTERS, p);
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

const REF_FORMATTERS: DispatchTable<ValueRef, string> = {
  literal: (v) => JSON.stringify(v.value),
  input: (v) =>
    v.path.length > 0 ? `${v.inputRef}.${v.path.join(".")}` : v.inputRef,
  dependency: (v) =>
    v.accessChain.length > 0
      ? `${v.name}().${v.accessChain.join(".")}`
      : `${v.name}()`,
  derived: (v) => `${formatRef(v.from)}.${formatDerivation(v.derivation)}`,
  state: (v) => `state.${v.name}`,
  unresolved: (v) => v.sourceText,
};

function formatRef(v: ValueRef): string {
  return dispatchByType(REF_FORMATTERS, v);
}

const DERIVATION_FORMATTERS: DispatchTable<Derivation, string> = {
  propertyAccess: (d) => d.property,
  indexAccess: (d) => `[${d.index}]`,
  destructured: (d) => d.field,
  methodCall: (d) => `${d.method}()`,
  awaited: () => "await",
};

function formatDerivation(d: Derivation): string {
  return dispatchByType(DERIVATION_FORMATTERS, d);
}

// ---------------------------------------------------------------------------
// Transition rendering — output-first
// ---------------------------------------------------------------------------

const OUTPUT_FORMATTERS: DispatchTable<Output, string> = {
  response: (o) => {
    const status = o.statusCode !== null ? formatRef(o.statusCode) : "???";
    const body = formatBodyShape(o.body);
    return body ? `${status} ${body}` : `${status}`;
  },
  throw: (o) => `throw ${o.exceptionType ?? "Error"}`,
  render: (o) => `render <${o.component} />`,
  return: (o) => {
    const body = formatBodyShape(o.value);
    return body ? `return ${body}` : "return";
  },
  delegate: (o) => `delegate -> ${o.to}`,
  emit: (o) => `emit "${o.event}"`,
  void: () => "void",
};

function formatOutput(output: Output): string {
  return dispatchByType(OUTPUT_FORMATTERS, output);
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
  const http = summary.metadata?.http as Record<string, unknown> | undefined;
  const contract = http?.declaredContract as
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
  const summaries = parseSummaryFile(filePath, content);

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

  const beforeSummaries = parseSummaryFile(
    beforePath,
    fs.readFileSync(beforePath, "utf-8"),
  );
  const afterSummaries = parseSummaryFile(
    afterPath,
    fs.readFileSync(afterPath, "utf-8"),
  );

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
    const filePath = path.join(resolved, file);
    const content = fs.readFileSync(filePath, "utf-8");
    all.push(...parseSummaryFile(filePath, content));
  }
  return all;
}

function parseSummaryFile(
  filePath: string,
  content: string,
): BehavioralSummary[] {
  const json = JSON.parse(content) as unknown;
  const result = safeParseSummaries(json);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 10)
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid summary file ${filePath}:\n${issues}`);
  }
  return result.data;
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
