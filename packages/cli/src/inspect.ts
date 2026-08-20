// inspect.ts: `suss inspect` command implementation
//
// Renders behavioral summaries as human-readable descriptions.
// Lead with what the code DOES (output), follow with WHEN (conditions).

import fs from "node:fs";
import path from "node:path";

import {
  boundaryKey,
  boundaryLabel,
  type DispatchTable,
  diffSummaries,
  dispatchByType,
  displayLabel,
  readHttpMetadata,
  readReactMetadata,
  safeParseSummaries,
} from "@suss/behavioral-ir";
import {
  contractDeclaresStatus,
  pairSummaries,
  readDeclaredContract,
  summaryWithDefinitionsInlined,
} from "@suss/checker";

import { UsageError } from "./usageError.js";

import type {
  BehavioralSummary,
  Derivation,
  Effect,
  Gap,
  Output,
  Predicate,
  RenderNode,
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
//: the caller only sees a typed result.

// ---------------------------------------------------------------------------
// Body shape rendering
// ---------------------------------------------------------------------------

function spelledOutIfAsked(
  summaries: BehavioralSummary[],
  types: boolean | undefined,
): BehavioralSummary[] {
  return types === true
    ? summaries.map(summaryWithDefinitionsInlined)
    : summaries;
}

function shortPath(file: string): string {
  const parts = file.split("/").filter((p) => p.length > 0);
  return parts.slice(-2).join("/");
}

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
  // A name, and where the type is written. A reader who wants the
  // fields asks for them; printing every field of every named type is
  // how one summary came to be a megabyte.
  ref: (s) =>
    s.from === undefined ? s.name : `${s.name} (${shortPath(s.from)})`,
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

/**
 * Collapse runs of whitespace (including newlines) to a single space
 * and trim. Source-text fields captured from the TypeScript AST ,
 * opaque predicates, unresolved ValueRefs, dependency names that span
 * multi-line call expressions: keep the original formatting. Without
 * normalization those newlines break the tree prefix on every
 * continuation line.
 */
function normalizeSourceText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

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
  opaque: (p) => normalizeSourceText(p.sourceText),
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
  dependency: (v) => {
    const name = normalizeSourceText(v.name);
    return v.accessChain.length > 0
      ? `${name}().${v.accessChain.join(".")}`
      : `${name}()`;
  },
  derived: (v) => {
    const deriv = formatDerivation(v.derivation);
    // Index access reads `foo[0]`, not `foo.[0]`: the leading dot we
    // prefix for propertyAccess / destructured / methodCall / awaited
    // isn't part of the bracket syntax. Other derivations still use
    // `.` as the separator.
    const sep = v.derivation.type === "indexAccess" ? "" : ".";
    return `${formatRef(v.from)}${sep}${deriv}`;
  },
  state: (v) => `state.${v.name}`,
  unresolved: (v) => normalizeSourceText(v.sourceText),
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
// Transition rendering: output-first
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

/**
 * Format a render node's attributes in-line: `<Container fluid id={x}>`.
 * Empty-string values are boolean-shorthand attrs (`<input disabled>`);
 * non-empty values get brace-wrapped so they read as JSX attribute
 * expressions. Attrs are source-text verbatim from the extractor, so
 * whitespace-normalize before printing.
 */
function formatRenderAttrs(attrs: Record<string, string> | undefined): string {
  if (attrs === undefined) {
    return "";
  }
  const entries = Object.entries(attrs);
  if (entries.length === 0) {
    return "";
  }
  const parts = entries.map(([k, v]) => {
    if (v === "") {
      return k;
    }
    return `${k}={${normalizeSourceText(v)}}`;
  });
  const joined = parts.join(" ");
  // Cap the per-tag attr string so attr-heavy elements don't dominate
  // the line. The full attrs remain in the IR for consumers that need
  // them: this is inspect's readability heuristic.
  const MAX_ATTR_WIDTH = 60;
  if (joined.length > MAX_ATTR_WIDTH) {
    return ` ${parts.slice(0, 2).join(" ")} ...`;
  }
  return ` ${joined}`;
}

/**
 * Does the root render node have more than a single bare self-closing
 * element? Used to decide whether the inline `render <Foo />` form is
 * lossless or whether the subtree expansion is needed to preserve
 * per-branch differentiation (children, attrs, conditionals, text).
 */
function hasRenderedContent(root: RenderNode): boolean {
  if (root.type !== "element") {
    return true;
  }
  if (root.children.length > 0) {
    return true;
  }
  return root.attrs !== undefined && Object.keys(root.attrs).length > 0;
}

/**
 * Walk a render tree into indented lines. Elements render as
 * JSX-style open tags (`<Tag attrs>` ... `</Tag>`), leaf elements
 * collapse to self-closing (`<Leaf />`). A conditional node keeps its
 * condition's source text verbatim, ternary branches indent under it.
 */
function formatRenderNode(node: RenderNode, indent: string): string[] {
  if (node.type === "text") {
    return [`${indent}"${node.value}"`];
  }
  if (node.type === "expression") {
    return [`${indent}{${normalizeSourceText(node.sourceText)}}`];
  }
  if (node.type === "conditional") {
    const cond = normalizeSourceText(node.condition);
    const lines: string[] = [];
    lines.push(`${indent}{${cond} ?`);
    lines.push(...formatRenderNode(node.whenTrue, `${indent}  `));
    if (node.whenFalse !== null) {
      lines.push(`${indent}:`);
      lines.push(...formatRenderNode(node.whenFalse, `${indent}  `));
    }
    lines.push(`${indent}}`);
    return lines;
  }
  const attrs = formatRenderAttrs(node.attrs);
  if (node.children.length === 0) {
    return [`${indent}<${node.tag}${attrs} />`];
  }
  const lines: string[] = [`${indent}<${node.tag}${attrs}>`];
  for (const child of node.children) {
    lines.push(...formatRenderNode(child, `${indent}  `));
  }
  lines.push(`${indent}</${node.tag}>`);
  return lines;
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
// renders the tree as nested `if` / `elif` / `else`: shared prefix appears
// once, elif collapses a one-predicate else-branch onto the same indent,
// nested ifs indent further. Falls back to leaf output lines only at the
// branches.

type Leaf = {
  output: Output;
  effects: Effect[];
  isDefault: boolean;
  declares: ((status: number) => boolean) | null;
  /** The range spec ("4XX") for a response declared by class. */
  rangeSpec: string | null;
};

/**
 * Render context threaded through the tree walker so leaf rendering
 * can mark effects that reach into other summaries in the same file
 * (the `→` follow-reference hint).
 */
interface RenderCtx {
  /**
   * Map from a summary's identity name (both full name and last dotted
   * segment, so `Form.onSubmit` and `onSubmit` both resolve) to the
   * relative file path it lives in. Used to both flag an effect's
   * callee as a known follow target and decide whether to render the
   * `→` reference bare (same file) or path-qualified (cross-file, so
   * readers know which file-group to scroll to). Collisions under a
   * given name map to the first summary encountered: ambiguous names
   * are already path-qualified at the header level via
   * `ambiguousNames`, so the bare-name fallback here is safe.
   */
  fileByName: Map<string, string>;
  /**
   * Every loaded summary that has an `identity.id`, keyed by that
   * id. An invocation effect whose `summary` field points at one of these
   * ids resolves through this map instead of by matching `callee`
   * text against `fileByName`, since that field is an actual call fact
   * the extractor already worked out, not a name a reader hopes is
   * unique.
   */
  /** Follow names several files answer to, which resolve to none of them. */
  ambiguousFollowNames: ReadonlySet<string>;
  summaryById: Map<string, { name: string; file: string }>;
  /**
   * For each parent summary (keyed by `identity.name`), the sub-units
   * that were spawned by a specific callee in the parent's body,
   * ordered by the source index the pack recorded. Example: for a
   * React component `ContainerVersionView` with three `useEffect(...)`
   * calls, this contains
   * `{ "ContainerVersionView" → { "useEffect" → ["...effect#0", "...effect#1", "...effect#2"] } }`.
   * When rendering the parent's effect list, a `+ useEffect` line is
   * replaced by a reference to the spawned sub-unit so the reader
   * isn't told "this called useEffect" three times: they're told
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
  /**
   * File of the summary currently being rendered. Effects whose callee
   * resolves to a summary in a *different* file get path-qualified so
   * readers skimming the output know which file-group to scroll to.
   */
  readonly parentFile: string;
  readonly spawnerUsed: Map<string, number>;
}

function perSummary(
  base: RenderCtx,
  parentName: string,
  parentFile: string,
): PerSummaryRenderCtx {
  return { base, parentName, parentFile, spawnerUsed: new Map() };
}

/**
 * Summary names whose identity is generic enough that the path-free
 * header says nothing at all: routing conventions dominated by
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
  // another summary in the file: both cases leave the bare name
  // ambiguous to a reader skimming the output.
  if (!GENERIC_NAMES.has(name) && !ambiguousNames.has(name)) {
    return name;
  }
  const stripped = summary.location.file.replace(/\.[^./]+$/, "");
  return `${stripped}.${name}`;
}

type TreeNode =
  | { kind: "empty" }
  | { kind: "leaf"; leaves: Leaf[] }
  | {
      kind: "branch";
      predicate: Predicate;
      thenBranch: TreeNode;
      elseBranch: TreeNode;
    };

/**
 * Two transitions can land on the same slot: a throw on `condA`, a
 * throw on `!condA`, and an unconditional fallback fill three outcomes
 * into two sides. The slot keeps every distinct arrival rather than
 * whichever got there first, so no recorded outcome disappears (#133).
 */
function leafKey(leaf: Leaf): string {
  // The range spec is part of identity: a "2XX" and a "4XX" response
  // have the same output shape and are different outcomes.
  return JSON.stringify({
    output: leaf.output,
    effects: leaf.effects,
    rangeSpec: leaf.rangeSpec,
  });
}

function appendLeaf(
  node: { kind: "leaf"; leaves: Leaf[] },
  leaf: Leaf,
): TreeNode {
  const key = leafKey(leaf);
  const seen = node.leaves.some((l) => leafKey(l) === key);
  if (seen) {
    return node;
  }
  return { kind: "leaf", leaves: [...node.leaves, leaf] };
}

function predicateEqual(a: Predicate, b: Predicate): boolean {
  // Structural equality via JSON: predicates are plain zod-shaped data and
  // the schemas fix key order, so round-tripping is stable. Good enough for
  // display-time tree building, and nothing else depends on it.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Strip every `negation` wrapper, tracking whether an odd number came
 * off. `!!x` and `x` are the same test, and the assembler produces the
 * doubled form for a fall-through past a guard whose condition is a
 * call: the guard is `!lookup()`, so reaching the code after it is
 * `!!lookup()`.
 *
 * Peeling one layer left the two conditions looking like different
 * predicates, so the fall-through never lined up with its own guard and
 * the tree dropped it. That hid the success path of any handler written
 * as `if (!check()) return error;` followed by a return.
 */
function peelNegations(condition: Predicate): {
  predicate: Predicate;
  positive: boolean;
} {
  let predicate = condition;
  let positive = true;
  while (predicate.type === "negation") {
    positive = !positive;
    predicate = predicate.operand;
  }
  return { predicate, positive };
}

function insertIntoTree(
  node: TreeNode,
  conditions: Predicate[],
  i: number,
  leaf: Leaf,
): TreeNode {
  if (i >= conditions.length) {
    if (node.kind === "empty") {
      return { kind: "leaf", leaves: [leaf] };
    }
    if (node.kind === "leaf") {
      return appendLeaf(node, leaf);
    }
    // Arrived at a branch node when the transition's conditions end mid-way.
    // This happens when the assembler records a fall-through leaf whose
    // condition list is shorter than a sibling's. Attach the leaf to the
    // nearest empty else slot: that's the "if this branch's `if` didn't
    // match" location. Walking down-and-right lets us land on the
    // innermost empty else which corresponds to the fall-through.
    return attachToDeepestEmptyElse(node, leaf);
  }
  const { predicate: pred, positive } = peelNegations(conditions[i]);

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
    // Branch; the leaf keeps whichever side the arrival does not take.
    const branch: TreeNode = {
      kind: "branch",
      predicate: pred,
      thenBranch: positive ? { kind: "empty" } : node,
      elseBranch: positive ? node : { kind: "empty" },
    };
    return insertIntoTree(branch, conditions, i, leaf);
  }
  if (!predicateEqual(node.predicate, pred)) {
    // Predicate shape mismatch at this depth. The transitions don't line up
    // into a clean decision tree: fall back to treating the incoming
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
    return { ...node, elseBranch: { kind: "leaf", leaves: [leaf] } };
  }
  if (node.elseBranch.kind === "leaf") {
    return { ...node, elseBranch: appendLeaf(node.elseBranch, leaf) };
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
      declares: null, // filled by caller wrapper
      rangeSpec: readHttpMetadata(t)?.statusRange?.spec ?? null,
    });
  }
  return root;
}

function renderLeaves(
  leaves: Leaf[],
  indent: string,
  ctx: PerSummaryRenderCtx,
): string[] {
  return leaves.flatMap((leaf) => renderLeaf(leaf, indent, ctx));
}

function renderLeaf(
  leaf: Leaf,
  indent: string,
  ctx: PerSummaryRenderCtx,
): string[] {
  const lines: string[] = [];
  // When a render terminal has a full subtree under it, emit `-> render`
  // on the terminal line and expand the tree below it. Two branches
  // that share a root component but differ in children or attrs stay
  // distinguishable: which the `render <Component />` collapsed form
  // couldn't express.
  if (
    leaf.output.type === "render" &&
    leaf.output.root !== undefined &&
    hasRenderedContent(leaf.output.root)
  ) {
    lines.push(`${indent}-> render`);
    lines.push(...formatRenderNode(leaf.output.root, `${indent}  `));
  } else {
    let line = `${indent}-> ${formatOutput(leaf.output)}`;
    // A response declared by class or as a catch-all has no status
    // literal; say "4XX" or "default" rather than "???".
    if (leaf.output.type === "response" && leaf.output.statusCode === null) {
      const label = leaf.rangeSpec ?? (leaf.isDefault ? "default" : null);
      if (label !== null) {
        const body = formatBodyShape(leaf.output.body);
        line = `${indent}-> ${label}${body ? ` ${body}` : ""}`;
      }
    }
    if (leaf.declares !== null && leaf.output.type === "response") {
      const sc = leaf.output.statusCode;
      if (
        sc !== null &&
        sc.type === "literal" &&
        typeof sc.value === "number" &&
        !leaf.declares(sc.value)
      ) {
        line += "  !! undeclared";
      }
    }
    lines.push(line);
  }
  // Effects, rendered as compact cross-references. Each effect is one
  // line at the same indent as the terminal, prefixed `+ `. When an
  // effect's callee resolves to a summary in the same file, append a
  // `→` marker to signal "this has its own summary nearby: follow
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
 * surface by default: mutation/emission/stateChange are folded in
 * too, but invocation is the dominant case and the one readers care
 * about for "what did this handler call."
 */
function renderEffect(effect: Effect, ctx: PerSummaryRenderCtx): string | null {
  if (effect.type === "invocation") {
    // Normalize the callee text: extractors that capture a raw
    // multi-line source region (`arr\n  .filter(...)\n  .join`) would
    // otherwise emit newlines that break the tree pipe on every
    // continuation. Same treatment as the other source-text render
    // paths (predicates, unresolved refs, dependency names).
    const callee = normalizeSourceText(effect.callee);
    // Check whether this callee spawned a sub-unit for the current
    // parent summary. If so, render the sub-unit reference instead
    // of the raw callee: `+ ComponentName.effect#0 →` is more
    // informative than `+ useEffect` three times in a row when the
    // sub-unit summaries are right below.
    const spawned = consumeSpawnedSubUnit(ctx, callee);
    if (spawned !== null) {
      return `+ ${spawned} →`;
    }
    // Trust the id the extractor already resolved this call to over a
    // name guess: `effect.summary` points at one specific summary, where
    // `callee` text can coincide with any number of them across a run.
    // Falls back to the name match only when no id was recorded, which
    // covers both an artifact predating that resolution and a call the
    // extractor itself couldn't pin down.
    const target =
      effect.summary !== undefined
        ? resolveFollowTargetById(effect.summary, callee, ctx)
        : resolveFollowTargetByName(callee, ctx);
    if (target !== null) {
      return `+ ${target} →`;
    }
    return `+ ${callee}`;
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
 * Resolve a follow reference from the id the extractor already
 * recorded for this call. Absent from `summaryById`, the target
 * wasn't part of this load (a filtered-out kind, a summary from a
 * different run); returns null rather than falling back to a name
 * guess, since a wrong id would defeat the reason to have one. Same
 * display shape as the name-based resolver below: bare for a
 * same-file target, `<relative/path/without-ext>.<name>` across files.
 */
function resolveFollowTargetById(
  id: string,
  callee: string,
  ctx: PerSummaryRenderCtx,
): string | null {
  const target = ctx.base.summaryById.get(id);
  if (target === undefined) {
    return null;
  }
  if (target.file === ctx.parentFile) {
    return callee;
  }
  const stripped = target.file.replace(/\.[^./]+$/, "");
  return `${stripped}.${target.name}`;
}

/**
 * Fallback for an effect the extractor recorded no id for, whether
 * because the artifact predates that resolution or the call itself
 * couldn't be pinned to one summary. If the callee resolves to a
 * known summary, return the display text for a follow reference: the
 * bare name for same-file targets, or `<relative/path/without-ext>.<name>`
 * for cross-file ones so the reader knows which file-group to scroll
 * to. Resolution matches the full callee text first, then the last
 * dotted segment so `utils.formatError` still resolves against a
 * `formatError` summary. Returns null when the callee isn't
 * summarized anywhere. Matches by name alone, across every summary
 * loaded, so it can point at the wrong one when a name recurs; kept
 * only for artifacts an id can't be read from.
 */
function resolveFollowTargetByName(
  callee: string,
  ctx: PerSummaryRenderCtx,
): string | null {
  const byName = ctx.base.fileByName;
  // Prefer a full-callee match (`"Form.onSubmit"` resolves as
  // `Form.onSubmit`) so sub-unit names with dots stay intact. Fall
  // back to the last dotted segment, and when that's what matched,
  // render the resolved name rather than the original callee text,
  // since otherwise a cross-file `utils.formatPayload` resolves
  // against a `formatPayload` summary and renders nonsense like
  // `src/helpers.utils.formatPayload`.
  const ambiguous = ctx.base.ambiguousFollowNames;
  let resolved: string | null = null;
  if (byName.has(callee)) {
    resolved = callee;
  } else {
    const last = callee.split(".").pop();
    if (last !== undefined && last !== callee && byName.has(last)) {
      resolved = last;
    }
  }
  if (resolved === null || ambiguous.has(resolved)) {
    return null;
  }
  const targetFile = byName.get(resolved) ?? ctx.parentFile;
  if (targetFile === ctx.parentFile) {
    return callee;
  }
  const stripped = targetFile.replace(/\.[^./]+$/, "");
  return `${stripped}.${resolved}`;
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
    return renderLeaves(node.leaves, indent, ctx);
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
    lines.push(...renderLeaves(el.leaves, inner, ctx));
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
    return renderLeaves(node.leaves, indent, ctx);
  }
  return renderNode(node, indent, "if", ctx);
}

function renderTransitions(
  transitions: Transition[],
  declares: ((status: number) => boolean) | null,
  ctx: PerSummaryRenderCtx,
): string[] {
  // Propagate the declared-status test onto every leaf so the
  // undeclared-status annotation can be emitted without re-threading
  // the argument through the recursion.
  const tree = buildDecisionTree(transitions);
  stampDeclaredStatuses(tree, declares);
  const baseIndent = "    ";
  if (tree.kind === "leaf") {
    return renderLeaves(tree.leaves, baseIndent, ctx);
  }
  if (tree.kind === "branch") {
    return renderNode(tree, baseIndent, "if", ctx);
  }
  return [];
}

function stampDeclaredStatuses(
  node: TreeNode,
  declares: ((status: number) => boolean) | null,
): void {
  if (node.kind === "leaf") {
    for (const leaf of node.leaves) {
      leaf.declares = declares;
    }
    return;
  }
  if (node.kind === "branch") {
    stampDeclaredStatuses(node.thenBranch, declares);
    stampDeclaredStatuses(node.elseBranch, declares);
  }
}

// ---------------------------------------------------------------------------
// Gap rendering
// ---------------------------------------------------------------------------

function formatGap(g: Gap): string {
  return `    !! ${g.description}`;
}

/**
 * The calls the walk stopped at, printed under their own heading right
 * after what the unit reaches. Read together they say how much of the
 * unit's behaviour the `Reaches:` list is standing for.
 */
function renderUnfollowedCalls(gaps: readonly Gap[]): string[] {
  const stops = gaps.filter((gap) => gap.type === "unfollowedCall");
  if (stops.length === 0) {
    return [];
  }
  return [
    "",
    "  Could not follow:",
    ...stops.map((gap) => `    ${gap.description}`),
  ];
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
   * the file path provides disambiguation context: bare `loader` /
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
  const perCtx = perSummary(ctx, summary.identity.name, summary.location.file);
  const lines: string[] = [];

  // Single header line: `<name> (<recognition> <kind> | line N [| confidence])`.
  // Collapsed from the old two-line form: file path lives in the
  // file-group header one level up, so repeating it here is noise.
  const headerName = summaryHeaderName(summary, ctx, layout);
  const metadata = summaryMetadata(summary);
  lines.push(`${layout.elbow}${headerName}  (${metadata})`);

  const bodyLines: string[] = [];

  const contract = readDeclaredContract(summary);
  let declares: ((status: number) => boolean) | null = null;
  if (contract !== null) {
    const parts = [
      ...contract.responses
        .map((r) => r.statusCode)
        .sort((a, b) => a - b)
        .map(String),
      ...contract.responseRanges.map((r) => r.spec),
      ...(contract.defaultResponse !== null ? ["default"] : []),
    ];
    declares = (status) => contractDeclaresStatus(contract, status);
    bodyLines.push(`  Contract: ${parts.join(", ")}`);
  }

  if (summary.transitions.length > 0) {
    bodyLines.push(...renderTransitions(summary.transitions, declares, perCtx));
  }

  // Effects closure: everything this boundary transitively touches,
  // stamped by the adapter's boundary-effects pass on entry summaries.
  // `(via callees)` marks effects inherited from deeper in the call
  // chain rather than the boundary's own body.
  const effectsClosure = summary.metadata?.effectsClosure as
    | Array<{ kind: string; target: string; transitive: boolean }>
    | undefined;
  if (effectsClosure !== undefined && effectsClosure.length > 0) {
    bodyLines.push("");
    bodyLines.push("  Reaches:");
    for (const effect of effectsClosure) {
      const suffix = effect.transitive ? " (via callees)" : "";
      bodyLines.push(`    ${effect.kind} ${effect.target}${suffix}`);
    }
  }

  bodyLines.push(...renderUnfollowedCalls(summary.gaps));

  const otherGaps = summary.gaps.filter((gap) => gap.type !== "unfollowedCall");
  if (otherGaps.length > 0) {
    bodyLines.push("");
    for (const gap of otherGaps) {
      bodyLines.push(formatGap(gap));
    }
  }

  for (const line of bodyLines) {
    lines.push(`${layout.bodyPrefix}${line}`);
  }

  return lines.join("\n");
}

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
  const bus =
    binding !== null && binding.semantics.name === "message-bus"
      ? binding.semantics
      : null;
  if (rest !== null && (rest.method !== null || rest.path !== null)) {
    // The protocol's own label, so the header and the boundary key
    // agree on the spelling (":id" renders as "{id}" everywhere).
    return displayLabel(binding as NonNullable<typeof binding>);
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
  // A route shows what it serves in the header. A queue subscriber
  // should too: its name says which deployable unit receives, and its
  // channel says what. A queue declared by a template is named after
  // its own channel, where showing both would stutter.
  if (bus !== null && bus.channel !== null) {
    const channel = `${bus.messageBus} ${bus.channel}`;
    if (summary.identity.name === bus.channel) {
      return channel;
    }
    return `${bareName(summary, ctx, layout)} → ${channel}`;
  }

  // Any other protocol that can label itself gets its label shown,
  // instead of falling through to a bare unit name because nobody
  // wrote it a branch here.
  if (binding !== null) {
    const label = boundaryLabel(binding);
    if (label !== null) {
      return label;
    }
  }

  return bareName(summary, ctx, layout);
}

function bareName(
  summary: BehavioralSummary,
  ctx: RenderCtx,
  layout: SummaryLayout,
): string {
  if (layout.inFileGroup) {
    return summary.identity.name;
  }
  return qualifyGenericName(summary, ctx.ambiguousNames);
}

/**
 * The parenthesized right side of the header. React `useEffect`
 * sub-units (`metadata.react.kind === "effect"`) surface as
 * `react useEffect` instead of the bland `react handler`: both are
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
  const react = readReactMetadata(summary);
  if (react?.kind === "effect") {
    return `useEffect${formatEffectDeps(react.deps)}`;
  }
  return summary.kind;
}

/**
 * Render a useEffect's deps suffix. Three cases mean different
 * scheduling meaning and should be distinguishable at a glance:
 *   - `null` (deps argument absent): body runs after every render
 *   - `[]` (empty array): body runs once on mount
 *   - `[x, y, ...]`: body runs when any listed dep changes
 * Source-text entries get whitespace-normalized so a multi-line
 * dep expression doesn't break the tree prefix.
 */
function formatEffectDeps(deps: string[] | null | undefined): string {
  if (deps === undefined) {
    return "";
  }
  if (deps === null) {
    return " (every render)";
  }
  if (deps.length === 0) {
    return " (mount)";
  }
  return ` [${deps.map(normalizeSourceText).join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Inspect command
// ---------------------------------------------------------------------------

export interface InspectOptions {
  file: string;
  /**
   * Spell out the types a summary refers to rather than naming them.
   *
   * Naming is the default because a boundary answering with a `User`
   * is what a reader wants to see, and printing every field of every
   * named type is how one summary came to be a megabyte. Somebody
   * chasing a particular shape asks for it.
   */
  types?: boolean;
}

export interface DirOptions {
  dir: string;
  types?: boolean;
}

export interface DiffOptions {
  before: string;
  after: string;
}

/**
 * A single summary's body can run long: 80+ lines for large branch
 * trees. By the time the reader has scrolled past the initial file
 * header, they no longer know which file the current body belongs to.
 * Every N body lines, re-emit a compact continuation marker under
 * the summary's body prefix so the file name stays within view.
 * Short summaries are unaffected.
 */
const LONG_SUMMARY_THRESHOLD_LINES = 50;

function injectContinuationMarkers(
  rendered: string,
  layout: SummaryLayout,
  file: string,
): string {
  const lines = rendered.split("\n");
  // Threshold is measured on body lines (everything after the elbow
  // header). Short summaries get no continuation markers.
  if (lines.length - 1 <= LONG_SUMMARY_THRESHOLD_LINES) {
    return rendered;
  }
  const out: string[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    out.push(lines[i]);
    const bodyIdx = i;
    if (bodyIdx % LONG_SUMMARY_THRESHOLD_LINES === 0 && i < lines.length - 1) {
      out.push(`${layout.bodyPrefix}↳ ${file} (cont.)`);
    }
  }
  return out.join("\n");
}

export function inspect(options: InspectOptions): void {
  const filePath = path.resolve(options.file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const summaries = spelledOutIfAsked(
    parseSummaryFile(filePath, content),
    options.types,
  );
  const ctx = buildRenderCtx(summaries);

  // Group by file; within each file, order by line number. File insertion
  // order (first time a file is seen in the summary list) is preserved as
  // the between-group order: usually meaningful since extractors walk
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
      const rendered = renderSummary(group[i], ctx, layout);
      process.stdout.write(
        `${injectContinuationMarkers(rendered, layout, file)}\n`,
      );
      // Blank line between siblings. The pipe continues through the
      // spacer so the visual tree stays unbroken; the last summary
      // doesn't get one: the next iteration either starts a new file
      // group (with its own spacing) or ends the output.
      if (!isLast) {
        process.stdout.write("│\n");
      }
    }
  }

  process.stdout.write(
    `\n${plural(summaries.length, "summary", "summaries")}.\n`,
  );
}

function buildRenderCtx(summaries: BehavioralSummary[]): RenderCtx {
  // Every summary name in the file: inspect's `→` follow-reference
  // marker uses this to flag effects whose callee is itself summarized.
  // Includes the full identity name and the last dotted segment so
  // `Form.onSubmit` and `onSubmit` both resolve. Parallel `fileByName`
  // records where each name lives so cross-file refs can be path-
  // qualified in the effect render.
  const fileByName = new Map<string, string>();
  // A name that several files answer to cannot pick one of them, and
  // an invented call-graph edge reads exactly like a found one (#121).
  const filesPerFollowName = new Map<string, Set<string>>();
  const noteFollowName = (name: string, file: string): void => {
    const seen = filesPerFollowName.get(name) ?? new Set<string>();
    seen.add(file);
    filesPerFollowName.set(name, seen);
  };
  for (const s of summaries) {
    // A label is there for the reader; nothing calls it, so a
    // callee matching one is a coincidence and gets no follow marker.
    if (s.identity.nameKind === "label") {
      continue;
    }

    // First write wins on collisions: ambiguous names are already
    // qualified at the header level via `ambiguousNames`, so the
    // `fileByName` lookup on a colliding bare name only needs to
    // succeed often enough to mark it as summarized somewhere.
    if (!fileByName.has(s.identity.name)) {
      fileByName.set(s.identity.name, s.location.file);
    }
    noteFollowName(s.identity.name, s.location.file);
    const last = s.identity.name.split(".").pop();
    if (last !== undefined) {
      if (!fileByName.has(last)) {
        fileByName.set(last, s.location.file);
      }
      noteFollowName(last, s.location.file);
    }
  }

  const ambiguousFollowNames = new Set<string>();
  for (const [name, files] of filesPerFollowName) {
    if (files.size > 1) {
      ambiguousFollowNames.add(name);
    }
  }

  // Precise counterpart to fileByName: keyed by `identity.id` rather
  // than a name, so a call the extractor already resolved follows the
  // summary it actually reaches rather than whichever same-named one
  // happened to load first.
  const summaryById = new Map<string, { name: string; file: string }>();
  for (const s of summaries) {
    if (s.identity.id !== undefined) {
      summaryById.set(s.identity.id, {
        name: s.identity.name,
        file: s.location.file,
      });
    }
  }

  // Identity names that appear on more than one summary: those need
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
  // "effect"` with `component` + `index`); the shape is generic ,
  // any pack that emits sub-units with parent + spawner + index
  // metadata benefits from the same rendering.
  const spawnerIndex = new Map<string, Map<string, string[]>>();
  interface SpawnEntry {
    subUnit: string;
    index: number;
  }
  const gather: Map<string, Map<string, SpawnEntry[]>> = new Map();
  for (const s of summaries) {
    const react = readReactMetadata(s);
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

  return {
    fileByName,
    ambiguousFollowNames,
    summaryById,
    spawnerIndex,
    ambiguousNames,
  };
}

// ---------------------------------------------------------------------------
// Diff command
// ---------------------------------------------------------------------------

function summaryKey(s: BehavioralSummary): string {
  const binding = s.identity.boundaryBinding;
  if (binding !== null) {
    // The boundary's own key, whatever the protocol, so a diff pairs
    // the before and after of a route spelled ":id" and "{id}".
    const key = boundaryKey(binding);
    if (key !== null) {
      return `${s.kind}:${key}`;
    }
    const label = boundaryLabel(binding);
    if (label !== null) {
      return `${s.kind}:${label}`;
    }
  }
  return `${s.kind}::${s.identity.name}`;
}

function bindingLabel(s: BehavioralSummary): string | null {
  const binding = s.identity.boundaryBinding;
  if (binding === null) {
    return null;
  }
  return boundaryLabel(binding);
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
// Dir command: boundary pair overview
// ---------------------------------------------------------------------------

export function readSummariesFromDir(dir: string): BehavioralSummary[] {
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

export function parseSummaryFile(
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
    throw new UsageError(`Invalid summary file ${filePath}:\n${issues}`);
  }
  return result.data;
}

export function inspectDir(options: DirOptions): void {
  const summaries = spelledOutIfAsked(
    readSummariesFromDir(options.dir),
    options.types,
  );
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
  const { providers, consumers, unpairable } = result.unmatched;
  const unmatchedCount =
    providers.length + consumers.length + unpairable.length;

  if (unmatchedCount > 0) {
    if (pairsByKey.size > 0) {
      process.stdout.write("\n");
    }
    process.stdout.write("Not paired:\n");
    for (const p of providers) {
      const key = bindingLabel(p) ?? "no boundary";
      process.stdout.write(`  ${p.identity.name} (${key}) has no client\n`);
    }
    for (const c of consumers) {
      const key = bindingLabel(c) ?? "no boundary";
      process.stdout.write(`  ${c.identity.name} (${key}) has no provider\n`);
    }
    // A boundary with no name is worth its own line: something
    // crosses it, and the reader should know it went unchecked.
    for (const u of unpairable) {
      if (u.reason === "unnamedBoundary") {
        process.stdout.write(
          `  ${u.summary.identity.name} crosses a boundary with no name to pair on\n`,
        );
      }
    }
    const internalCount = unpairable.filter(
      (u) => u.reason !== "unnamedBoundary",
    ).length;
    if (internalCount > 0) {
      // Internal helpers arrive here by the dozen from the closure pass.
      // Naming each one buries the boundaries above it, and a function
      // with no boundary is the normal case, not a problem to report.
      process.stdout.write(
        `  ${internalCount} internal function${internalCount === 1 ? "" : "s"} with no boundary\n`,
      );
    }
  }

  if (pairsByKey.size === 0 && unmatchedCount === 0) {
    process.stdout.write(
      `No summaries in ${options.dir}. Write some there with \`suss extract -o\` first.\n`,
    );
    return;
  }

  const fileCount = fs
    .readdirSync(path.resolve(options.dir))
    .filter((f) => f.endsWith(".json")).length;
  process.stdout.write(
    `\n${plural(summaries.length, "summary", "summaries")} from ${plural(fileCount, "file", "files")}.\n`,
  );
}

/** "1 file" / "3 files", so counted nouns read as written English. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
