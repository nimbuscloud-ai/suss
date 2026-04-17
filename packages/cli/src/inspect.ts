// inspect.ts — `suss inspect` command implementation
//
// Renders behavioral summaries as human-readable descriptions.
// Lead with what the code DOES (output), follow with WHEN (conditions).

import fs from "node:fs";
import path from "node:path";

import type {
  BehavioralSummary,
  Gap,
  Output,
  Predicate,
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
