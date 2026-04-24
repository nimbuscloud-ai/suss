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
  Effect,
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

// ---------------------------------------------------------------------------
// if/elif/else transition rendering
// ---------------------------------------------------------------------------
//
// Transitions come from a linear AST walk that accumulates path predicates:
// T0's conditions are `[C0]`, T1's are `[!C0, C1]`, T2's are `[!C0, !C1, C2]`,
// and so on. Rendered naively each branch repeats the full negation chain of
// every prior branch, which drowns out the one predicate that actually
// decided the branch.
//
// `renderTransitions` folds the transitions back into a decision tree, then
// renders the tree as nested `if` / `elif` / `else` — shared prefix appears
// once, elif collapses a one-predicate else-branch onto the same indent,
// nested ifs indent further. Falls back to leaf output lines only at the
// branches.

type Leaf = {
  output: Output;
  effects: Effect[];
  isDefault: boolean;
  declaredStatuses: Set<number> | null;
};

/**
 * Render context threaded through the tree walker so leaf rendering
 * can mark effects that reach into other summaries in the same file
 * (the `→` follow-reference hint).
 */
interface RenderCtx {
  /**
   * Names of every summary in the file currently being inspected, for
   * the `→` reference marker when an effect's callee resolves to
   * another summary. Kept as a plain Set — render passes one file at
   * a time.
   */
  summaryNames: Set<string>;
  /**
   * For each parent summary (keyed by `identity.name`), the sub-units
   * that were spawned by a specific callee in the parent's body,
   * ordered by the source index the pack recorded. Example: for a
   * React component `ContainerVersionView` with three `useEffect(...)`
   * calls, this carries
   * `{ "ContainerVersionView" → { "useEffect" → ["...effect#0", "...effect#1", "...effect#2"] } }`.
   * When rendering the parent's effect list, a `+ useEffect` line is
   * replaced by a reference to the spawned sub-unit so the reader
   * isn't told "this called useEffect" three times — they're told
   * "this spawned `effect#0`, `effect#1`, `effect#2`," each of which
   * has its own summary immediately below.
   */
  spawnerIndex: Map<string, Map<string, string[]>>;
  /**
   * Identity names that appear on more than one summary in this file.
   * `Index` is the common React Router case (every route file's
   * default export often ends up named `Index`), but any collision
   * across files needs the file-path qualification to stay legible.
   * Populated at ctx-build time from the full summary list.
   */
  ambiguousNames: Set<string>;
}

/**
 * Per-summary mutable state for the effect renderer: we count how many
 * times each spawning callee has already been replaced so subsequent
 * encounters pick the next sub-unit in order.
 */
interface PerSummaryRenderCtx {
  readonly base: RenderCtx;
  readonly parentName: string;
  readonly spawnerUsed: Map<string, number>;
}

function perSummary(base: RenderCtx, parentName: string): PerSummaryRenderCtx {
  return { base, parentName, spawnerUsed: new Map() };
}

/**
 * Summary names whose identity is generic enough that the path-free
 * header carries zero information — routing conventions dominated by
 * React Router / Remix / Express / default-exporting files. When the
 * name is one of these, prefix it with the relative file path (minus
 * extension) so a reader skimming inspect output can distinguish
 * `app/routes/_app.loader` from `app/routes/_app.admin/route.loader`.
 */
const GENERIC_NAMES = new Set([
  "default",
  "loader",
  "action",
  "handler",
  "handleRequest",
]);

function qualifyGenericName(
  summary: BehavioralSummary,
  ambiguousNames: Set<string>,
): string {
  const name = summary.identity.name;
  // Qualify when the name is a known convention *or* collides with
  // another summary in the file — both cases leave the bare name
  // ambiguous to a reader skimming the output.
  if (!GENERIC_NAMES.has(name) && !ambiguousNames.has(name)) {
    return name;
  }
  const stripped = summary.location.file.replace(/\.[^./]+$/, "");
  return `${stripped}.${name}`;
}

type TreeNode =
  | { kind: "empty" }
  | { kind: "leaf"; leaf: Leaf }
  | {
      kind: "branch";
      predicate: Predicate;
      thenBranch: TreeNode;
      elseBranch: TreeNode;
    };

function predicateEqual(a: Predicate, b: Predicate): boolean {
  // Structural equality via JSON — predicates are plain zod-shaped data and
  // the schemas fix key order, so round-tripping is stable. Good enough for
  // display-time tree building; not a load-bearing invariant.
  return JSON.stringify(a) === JSON.stringify(b);
}

function insertIntoTree(
  node: TreeNode,
  conditions: Predicate[],
  i: number,
  leaf: Leaf,
): TreeNode {
  if (i >= conditions.length) {
    if (node.kind === "empty") {
      return { kind: "leaf", leaf };
    }
    if (node.kind === "leaf") {
      // Earlier transition already captured this slot; preserve precedence.
      return node;
    }
    // Arrived at a branch node when the transition's conditions end mid-way.
    // This happens when the assembler records a fall-through leaf whose
    // condition list is shorter than a sibling's. Attach the leaf to the
    // nearest empty else slot: that's the "if this branch's `if` didn't
    // match" location. Walking down-and-right lets us land on the
    // innermost empty else which corresponds to the fall-through.
    return attachToDeepestEmptyElse(node, leaf);
  }
  const cond = conditions[i];
  const positive = cond.type !== "negation";
  const pred = positive ? cond : cond.operand;

  if (node.kind === "empty") {
    const branch: TreeNode = {
      kind: "branch",
      predicate: pred,
      thenBranch: { kind: "empty" },
      elseBranch: { kind: "empty" },
    };
    return insertIntoTree(branch, conditions, i, leaf);
  }
  if (node.kind === "leaf") {
    return node;
  }
  if (!predicateEqual(node.predicate, pred)) {
    // Predicate shape mismatch at this depth. The transitions don't line up
    // into a clean decision tree — fall back to treating the incoming
    // condition as a fresh branch in the else slot.
    return {
      ...node,
      elseBranch: insertIntoTree(node.elseBranch, conditions, i, leaf),
    };
  }
  if (positive) {
    return {
      ...node,
      thenBranch: insertIntoTree(node.thenBranch, conditions, i + 1, leaf),
    };
  }
  return {
    ...node,
    elseBranch: insertIntoTree(node.elseBranch, conditions, i + 1, leaf),
  };
}

function attachToDeepestEmptyElse(node: TreeNode, leaf: Leaf): TreeNode {
  if (node.kind !== "branch") {
    return node;
  }
  if (node.elseBranch.kind === "empty") {
    return { ...node, elseBranch: { kind: "leaf", leaf } };
  }
  return {
    ...node,
    elseBranch: attachToDeepestEmptyElse(node.elseBranch, leaf),
  };
}

function buildDecisionTree(transitions: Transition[]): TreeNode {
  let root: TreeNode = { kind: "empty" };
  for (const t of transitions) {
    root = insertIntoTree(root, t.conditions, 0, {
      output: t.output,
      effects: t.effects,
      isDefault: t.isDefault,
      declaredStatuses: null, // filled by caller wrapper
    });
  }
  return root;
}

function renderLeaf(
  leaf: Leaf,
  indent: string,
  ctx: PerSummaryRenderCtx,
): string[] {
  const lines: string[] = [];
  let line = `${indent}-> ${formatOutput(leaf.output)}`;
  if (leaf.declaredStatuses !== null && leaf.output.type === "response") {
    const sc = leaf.output.statusCode;
    if (
      sc !== null &&
      sc.type === "literal" &&
      typeof sc.value === "number" &&
      !leaf.declaredStatuses.has(sc.value)
    ) {
      line += "  !! undeclared";
    }
  }
  lines.push(line);
  // Effects, rendered as compact cross-references. Each effect is one
  // line at the same indent as the terminal, prefixed `+ `. When an
  // effect's callee resolves to a summary in the same file, append a
  // `→` marker to signal "this has its own summary nearby — follow
  // it for detail." No arg expansion in the default view; the idea
  // is a navigable index, not an inline function body.
  for (const effect of leaf.effects) {
    const rendered = renderEffect(effect, ctx);
    if (rendered !== null) {
      lines.push(`${indent}  ${rendered}`);
    }
  }
  return lines;
}

/**
 * Short, reference-style effect rendering. Only invocation effects
 * surface by default — mutation/emission/stateChange are folded in
 * too, but invocation is the dominant case and the one readers care
 * about for "what did this handler call."
 */
function renderEffect(effect: Effect, ctx: PerSummaryRenderCtx): string | null {
  if (effect.type === "invocation") {
    const callee = effect.callee;
    // Check whether this callee spawned a sub-unit for the current
    // parent summary. If so, render the sub-unit reference instead
    // of the raw callee — `+ ComponentName.effect#0 →` is more
    // informative than `+ useEffect` three times in a row when the
    // sub-unit summaries are right below.
    const spawned = consumeSpawnedSubUnit(ctx, callee);
    if (spawned !== null) {
      return `+ ${spawned} →`;
    }
    const followMark = isFollowTarget(callee, ctx.base.summaryNames)
      ? " →"
      : "";
    return `+ ${callee}${followMark}`;
  }
  if (effect.type === "mutation") {
    return `+ mutate ${effect.target} (${effect.operation})`;
  }
  if (effect.type === "emission") {
    return `+ emit ${effect.event}`;
  }
  if (effect.type === "stateChange") {
    return `+ state ${effect.variable}`;
  }
  return null;
}

/**
 * When the current parent summary has sub-units spawned by this callee,
 * return the name of the next one in order and advance the counter.
 * Returns null when no more sub-units remain or no relationship exists.
 */
function consumeSpawnedSubUnit(
  ctx: PerSummaryRenderCtx,
  callee: string,
): string | null {
  const byCallee = ctx.base.spawnerIndex.get(ctx.parentName);
  if (byCallee === undefined) {
    return null;
  }
  const subUnits = byCallee.get(callee);
  if (subUnits === undefined) {
    return null;
  }
  const used = ctx.spawnerUsed.get(callee) ?? 0;
  if (used >= subUnits.length) {
    return null;
  }
  ctx.spawnerUsed.set(callee, used + 1);
  return subUnits[used];
}

/**
 * Is this effect's callee a reference to another summary in the set?
 * Match in precedence: full callee text, then the last dotted segment
 * (so `utils.formatError` resolves against a `formatError` summary),
 * then the qualified React sub-unit name if the callee happens to
 * read that way (e.g. `Form.onSubmit`).
 */
function isFollowTarget(callee: string, names: Set<string>): boolean {
  if (names.has(callee)) {
    return true;
  }
  const last = callee.split(".").pop();
  if (last !== undefined && last !== callee && names.has(last)) {
    return true;
  }
  return false;
}

function renderNode(
  node: TreeNode,
  indent: string,
  keyword: "if" | "elif",
  ctx: PerSummaryRenderCtx,
): string[] {
  if (node.kind === "empty") {
    return [];
  }
  if (node.kind === "leaf") {
    return renderLeaf(node.leaf, indent, ctx);
  }
  const lines: string[] = [];
  lines.push(`${indent}${keyword}  ${formatCondition(node.predicate)}`);
  const inner = `${indent}  `;
  lines.push(...renderThenSide(node.thenBranch, inner, ctx));

  // Chain elif when the else side is a single branch; emit a bare `else`
  // when it's a leaf.
  let el: TreeNode = node.elseBranch;
  while (el.kind === "branch") {
    lines.push(`${indent}elif  ${formatCondition(el.predicate)}`);
    lines.push(...renderThenSide(el.thenBranch, inner, ctx));
    el = el.elseBranch;
  }
  if (el.kind === "leaf") {
    lines.push(`${indent}else`);
    lines.push(...renderLeaf(el.leaf, inner, ctx));
  }
  return lines;
}

function renderThenSide(
  node: TreeNode,
  indent: string,
  ctx: PerSummaryRenderCtx,
): string[] {
  if (node.kind === "empty") {
    return [];
  }
  if (node.kind === "leaf") {
    return renderLeaf(node.leaf, indent, ctx);
  }
  return renderNode(node, indent, "if", ctx);
}

function renderTransitions(
  transitions: Transition[],
  declaredStatuses: Set<number> | null,
  ctx: PerSummaryRenderCtx,
): string[] {
  // Propagate declaredStatuses onto every leaf so the undeclared-status
  // annotation can be emitted without re-threading the argument through
  // the recursion.
  const tree = buildDecisionTree(transitions);
  stampDeclaredStatuses(tree, declaredStatuses);
  const baseIndent = "    ";
  if (tree.kind === "leaf") {
    return renderLeaf(tree.leaf, baseIndent, ctx);
  }
  if (tree.kind === "branch") {
    return renderNode(tree, baseIndent, "if", ctx);
  }
  return [];
}

function stampDeclaredStatuses(
  node: TreeNode,
  declaredStatuses: Set<number> | null,
): void {
  if (node.kind === "leaf") {
    node.leaf.declaredStatuses = declaredStatuses;
    return;
  }
  if (node.kind === "branch") {
    stampDeclaredStatuses(node.thenBranch, declaredStatuses);
    stampDeclaredStatuses(node.elseBranch, declaredStatuses);
  }
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

/**
 * How a summary renders inside a file-group tree:
 *   - `elbow` ("├─ " or "└─ ") precedes the header line
 *   - `bodyPrefix` ("│ " for non-last, "  " for last) precedes every
 *     subsequent line (contract, transitions, gaps)
 */
interface SummaryLayout {
  readonly elbow: string;
  readonly bodyPrefix: string;
  /**
   * When true, the summary is rendered under a file-group header and
   * the file path provides disambiguation context — bare `loader` /
   * `Index` is unambiguous within a file. When false (standalone),
   * generic / colliding names get path-qualified so they don't read
   * as interchangeable.
   */
  readonly inFileGroup: boolean;
}

const STANDALONE_LAYOUT: SummaryLayout = {
  elbow: "",
  bodyPrefix: "",
  inFileGroup: false,
};

function renderSummary(
  summary: BehavioralSummary,
  ctx: RenderCtx,
  layout: SummaryLayout = STANDALONE_LAYOUT,
): string {
  const perCtx = perSummary(ctx, summary.identity.name);
  const lines: string[] = [];

  // Single header line: `<name> (<recognition> <kind> | line N [| confidence])`.
  // Collapsed from the old two-line form — file path lives in the
  // file-group header one level up, so repeating it here is noise.
  const headerName = summaryHeaderName(summary, ctx, layout);
  const metadata = summaryMetadata(summary);
  lines.push(`${layout.elbow}${headerName}  (${metadata})`);

  const bodyLines: string[] = [];

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
    bodyLines.push(`  Contract: ${statuses.join(", ")}`);
  }

  // Transitions
  if (summary.transitions.length > 0) {
    bodyLines.push(
      ...renderTransitions(summary.transitions, declaredStatuses, perCtx),
    );
  }

  // Gaps
  if (summary.gaps.length > 0) {
    bodyLines.push("");
    for (const gap of summary.gaps) {
      bodyLines.push(formatGap(gap));
    }
  }

  for (const line of bodyLines) {
    lines.push(`${layout.bodyPrefix}${line}`);
  }

  return lines.join("\n");
}

/**
 * The left side of the collapsed header: endpoint for REST, identity
 * target for function-call callers/library, qualified bare name
 * otherwise.
 */
function summaryHeaderName(
  summary: BehavioralSummary,
  ctx: RenderCtx,
  layout: SummaryLayout,
): string {
  const binding = summary.identity.boundaryBinding;
  const rest =
    binding !== null && binding.semantics.name === "rest"
      ? binding.semantics
      : null;
  const fn =
    binding !== null && binding.semantics.name === "function-call"
      ? binding.semantics
      : null;
  if (rest !== null && (rest.method !== "" || rest.path !== "")) {
    return `${rest.method} ${rest.path}`.trim();
  }
  if (
    fn !== null &&
    fn.package !== undefined &&
    fn.exportPath !== undefined &&
    fn.exportPath.length > 0
  ) {
    const target = `${fn.package}::${fn.exportPath.join(".")}`;
    return summary.kind === "caller"
      ? `${summary.identity.name} → ${target}`
      : target;
  }
  // Inside a file-group, the file path is already visible in the
  // group header — bare name is unambiguous. Only qualify when the
  // summary is standalone.
  if (layout.inFileGroup) {
    return summary.identity.name;
  }
  return qualifyGenericName(summary, ctx.ambiguousNames);
}

/**
 * The parenthesized right side of the header. React `useEffect`
 * sub-units (`metadata.react.kind === "effect"`) surface as
 * `react useEffect` instead of the bland `react handler` — both are
 * `kind: "handler"` summaries, but readers of inspect want to
 * distinguish "event handler" from "effect body".
 */
function summaryMetadata(summary: BehavioralSummary): string {
  const parts: string[] = [];
  const binding = summary.identity.boundaryBinding;
  if (binding !== null) {
    parts.push(`${binding.recognition} ${unitKindLabel(summary)}`);
  }
  parts.push(`line ${summary.location.range.start}`);
  if (summary.confidence.level !== "high") {
    parts.push(`confidence: ${summary.confidence.level}`);
  }
  return parts.join(" | ");
}

function unitKindLabel(summary: BehavioralSummary): string {
  const react = summary.metadata?.react as { kind?: string } | undefined;
  if (react?.kind === "effect") {
    return "useEffect";
  }
  return summary.kind;
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
  const ctx = buildRenderCtx(summaries);

  // Group by file; within each file, order by line number. File insertion
  // order (first time a file is seen in the summary list) is preserved as
  // the between-group order — usually meaningful since extractors walk
  // files in some natural sequence. Each group renders under its file
  // header with elbow / body-prefix tree decoration.
  const byFile = new Map<string, BehavioralSummary[]>();
  for (const s of summaries) {
    const list = byFile.get(s.location.file);
    if (list === undefined) {
      byFile.set(s.location.file, [s]);
    } else {
      list.push(s);
    }
  }
  for (const list of byFile.values()) {
    list.sort((a, b) => a.location.range.start - b.location.range.start);
  }

  let first = true;
  for (const [file, group] of byFile) {
    if (!first) {
      process.stdout.write("\n");
    }
    first = false;
    process.stdout.write(`${file}\n`);
    for (let i = 0; i < group.length; i++) {
      const isLast = i === group.length - 1;
      const layout: SummaryLayout = {
        elbow: isLast ? "└─ " : "├─ ",
        bodyPrefix: isLast ? "   " : "│  ",
        inFileGroup: true,
      };
      process.stdout.write(`${renderSummary(group[i], ctx, layout)}\n`);
      // Blank line between siblings. The pipe continues through the
      // spacer so the visual tree stays unbroken; the last summary
      // doesn't get one — the next iteration either starts a new file
      // group (with its own spacing) or ends the output.
      if (!isLast) {
        process.stdout.write("│\n");
      }
    }
  }

  process.stdout.write(`\n${summaries.length} summaries inspected.\n`);
}

function buildRenderCtx(summaries: BehavioralSummary[]): RenderCtx {
  // Every summary name in the file — inspect's `→` follow-reference
  // marker uses this to flag effects whose callee is itself summarized.
  // Includes the full identity name and the last dotted segment so
  // `Form.onSubmit` and `onSubmit` both resolve.
  const names = new Set<string>();
  for (const s of summaries) {
    names.add(s.identity.name);
    const last = s.identity.name.split(".").pop();
    if (last !== undefined) {
      names.add(last);
    }
  }

  // Identity names that appear on more than one summary — those need
  // file-path qualification in the header so `Index` at _app._index.tsx
  // vs `Index` at _app.tsx don't render indistinguishably.
  const nameCounts = new Map<string, number>();
  for (const s of summaries) {
    nameCounts.set(s.identity.name, (nameCounts.get(s.identity.name) ?? 0) + 1);
  }
  const ambiguousNames = new Set<string>();
  for (const [name, count] of nameCounts) {
    if (count > 1) {
      ambiguousNames.add(name);
    }
  }

  // Spawner index: detect sub-units whose metadata records a parent
  // and spawning callee + source index, group by parent, order by
  // index. Today this is React-shaped only (`metadata.react.kind ===
  // "effect"` with `component` + `index`); the shape is generic —
  // any pack that emits sub-units with parent + spawner + index
  // metadata benefits from the same rendering.
  const spawnerIndex = new Map<string, Map<string, string[]>>();
  interface SpawnEntry {
    subUnit: string;
    index: number;
  }
  const gather: Map<string, Map<string, SpawnEntry[]>> = new Map();
  for (const s of summaries) {
    const react = s.metadata?.react as
      | { kind?: string; component?: string; index?: number }
      | undefined;
    if (
      react?.kind !== "effect" ||
      typeof react.component !== "string" ||
      typeof react.index !== "number"
    ) {
      continue;
    }
    let byCallee = gather.get(react.component);
    if (byCallee === undefined) {
      byCallee = new Map();
      gather.set(react.component, byCallee);
    }
    const callee = "useEffect";
    let entries = byCallee.get(callee);
    if (entries === undefined) {
      entries = [];
      byCallee.set(callee, entries);
    }
    entries.push({ subUnit: s.identity.name, index: react.index });
  }
  for (const [parent, byCallee] of gather) {
    const ordered = new Map<string, string[]>();
    for (const [callee, entries] of byCallee) {
      ordered.set(
        callee,
        entries.sort((a, b) => a.index - b.index).map((e) => e.subUnit),
      );
    }
    spawnerIndex.set(parent, ordered);
  }

  return { summaryNames: names, spawnerIndex, ambiguousNames };
}

// ---------------------------------------------------------------------------
// Diff command
// ---------------------------------------------------------------------------

function summaryKey(s: BehavioralSummary): string {
  const binding = s.identity.boundaryBinding;
  if (binding !== null && binding.semantics.name === "rest") {
    const { method, path } = binding.semantics;
    if (method !== "" || path !== "") {
      return `${s.kind}:${method || "*"} ${path || "*"}`;
    }
  }
  return `${s.kind}::${s.identity.name}`;
}

/**
 * Human-readable `METHOD path` for a REST-shaped binding, or null
 * when the summary has no placeable REST routing (function-call
 * semantics, or REST with empty method/path from a partial
 * extraction).
 */
function restKey(s: BehavioralSummary): string | null {
  const sem = s.identity.boundaryBinding?.semantics;
  if (sem?.name !== "rest") {
    return null;
  }
  if (sem.method === "" && sem.path === "") {
    return null;
  }
  return `${sem.method} ${sem.path}`;
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
    lines.push(`  ${binding.recognition} ${before.kind}`);
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
        const fw = p.identity.boundaryBinding?.recognition ?? "?";
        process.stdout.write(
          `    provider: ${p.identity.name} (${fw}, ${p.transitions.length} transitions)\n`,
        );
      }
      for (const c of group.consumers) {
        const fw = c.identity.boundaryBinding?.recognition ?? "?";
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
      const key = restKey(p) ?? "no path";
      process.stdout.write(
        `  ${p.identity.name} (${key}) — no matching client\n`,
      );
    }
    for (const c of consumers) {
      const key = restKey(c) ?? "no path";
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
