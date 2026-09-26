/**
 * `suss inspect`, which prints summaries for a person to read.
 *
 * Three commands share this file. `inspect` prints one summaries file as a
 * tree per source file. `inspectDir` lists which boundaries in a folder of
 * summaries paired and which did not. `inspectDiff` reports what changed
 * between two runs, one boundary at a time.
 *
 * Each transition prints its outcome first and its conditions after it,
 * because a reader scanning a handler looks for what it returns before
 * asking when. The text changes between releases, so a program should read
 * the summaries themselves or the diff's JSON form.
 */

import fs from "node:fs";
import path from "node:path";

import {
  BOUNDARY_ROLE,
  boundaryKey,
  boundaryLabel,
  type DispatchTable,
  diffSummaries,
  dispatchByType,
  displayLabel,
  goesThroughRelation,
  leavesTheProcess,
  readHttpMetadata,
  readMountMetadata,
  readReactMetadata,
  readStorageContractMetadata,
  readWrapperMetadata,
  relationsOf,
  safeParseSummaries,
} from "@suss/behavioral-ir";
import {
  contractDeclaresStatus,
  invokersOfUnits,
  pairSummaries,
  readDeclaredContract,
  summaryWithDefinitionsInlined,
} from "@suss/checker";

import { interactionDetail } from "./boundaryReach.js";
import { boundaryReach, entrypointKey, reachChanges } from "./diffReach.js";
import { scopeLines, sharedCauses } from "./sharedCause.js";
import { UsageError } from "./usageError.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
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
  WrapperReference,
} from "@suss/behavioral-ir";
import type { InvokesInRun } from "@suss/checker";
import type { Relation } from "@suss/ir-core";
import type { EntrypointChange, ReachedEffect } from "./diffReach.js";
import type { CausedLine, SharedCause } from "./sharedCause.js";

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

const REF_NAME_WIDTH = 120;

/**
 * When the adapter cannot name a type, the ref's name is the compiler's
 * printed text of the whole type. For an inferred alias that can run to
 * thousands of characters on one line, so the printout cuts it short. The
 * summary still has the full text.
 */
function shortRefName(name: string): string {
  if (name.length <= REF_NAME_WIDTH) {
    return name;
  }
  return `${name.slice(0, REF_NAME_WIDTH - 3).trimEnd()}...`;
}

const SHAPE_FORMATTERS: DispatchTable<TypeShape, string> = {
  record: (s) => {
    const keys = Object.keys(s.properties);
    // A spread brings in fields this run never saw. Printing the spread
    // value keeps a reader from taking the listed keys for the whole
    // shape, and tells them where to look for the rest.
    const spread = (s.spreads ?? []).map((from) => `...${from.sourceText}`);
    const parts = [...spread, ...keys];
    if (parts.length === 0) {
      return "{}";
    }
    if (parts.length <= 5) {
      return `{ ${parts.join(", ")} }`;
    }
    return `{ ${parts.slice(0, 4).join(", ")}, ... }`;
  },
  literal: (s) => JSON.stringify(s.value),
  // Print the name and the file the type is declared in. Printing every
  // field of every named type once made a single summary a megabyte
  // long, and `--types` prints the fields for a reader who needs them.
  ref: (s) => {
    const name = shortRefName(s.name);
    return s.from === undefined ? name : `${name} (${shortPath(s.from)})`;
  },
  array: (s) => `[${formatBodyShape(s.items)}]`,
  dictionary: (s) => `{ [key]: ${formatBodyShape(s.values)} }`,
  // A wide union is cut short like a wide record, after enough variants
  // to show what it is.
  union: (s) => {
    const variants = s.variants.map(formatBodyShape);
    return variants.length <= 5
      ? variants.join(" | ")
      : `${variants.slice(0, 4).join(" | ")} | ...`;
  },
  text: () => "string",
  integer: () => "int",
  number: () => "number",
  boolean: () => "bool",
  null: () => "null",
  undefined: () => "undefined",
  unknown: () => "any",
};

/** A body shape on one line, such as `{ id, name, email }`. */
function formatBodyShape(shape: TypeShape | null | undefined): string {
  if (shape == null) {
    return "";
  }
  return dispatchByType(SHAPE_FORMATTERS, shape);
}

// ---------------------------------------------------------------------------
// Condition rendering
// ---------------------------------------------------------------------------

/**
 * Source text copied from the program, such as an opaque predicate or a
 * call that spans several lines, keeps its newlines. Printed as is, each
 * newline would break the tree's `│` prefix, so every run of whitespace
 * becomes one space.
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
    // Print `!(!x)` as `x`, and fold the negation into a check that
    // already has a negated form.
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

/**
 * A condition as inspect prints it. A drafted intent doc uses it too, so
 * its `when` clauses read the same as the report.
 */
export function formatCondition(p: Predicate): string {
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
    // An index prints as `foo[0]`, so it gets no dot in front.
    const sep = v.derivation.type === "indexAccess" ? "" : ".";
    return `${formatRef(v.from)}${sep}${deriv}`;
  },
  state: (v) => `state.${v.name}`,
  unresolved: (v) => normalizeSourceText(v.sourceText),
};

/**
 * A value as inspect prints it. A drafted intent doc uses it too, so its
 * values read the same as the report.
 */
export function formatRef(v: ValueRef): string {
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
// Transition rendering
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
 * A render node's attributes in JSX form: `<Container fluid id={x}>`. An
 * empty value is a boolean attribute such as `disabled`, so it prints with
 * no value.
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
  // A tag with many attributes would push the rest of the line off the
  // screen. The summary still has every attribute.
  const MAX_ATTR_WIDTH = 60;
  if (joined.length > MAX_ATTR_WIDTH) {
    return ` ${parts.slice(0, 2).join(" ")} ...`;
  }
  return ` ${joined}`;
}

/**
 * Whether the tree has more in it than one bare element. When it does, the
 * one-line `render <Foo />` form would hide what tells two branches apart,
 * so the whole tree prints.
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
 * A render tree as indented JSX, with a conditional's branches indented
 * under its condition.
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

type Leaf = {
  output: Output;
  effects: Effect[];
  isDefault: boolean;
  declares: ((status: number) => boolean) | null;
  /** The range spec ("4XX") for a response declared by class. */
  rangeSpec: string | null;
  /** The wrapper whose body produced this outcome, if a wrapper did. */
  from: WrapperReference | null;
};

/**
 * What the renderer needs to know about the other summaries in the run,
 * so an effect can point at the summary of the function it calls with a
 * `→` marker.
 */
interface RenderCtx {
  /**
   * The file each summary name is in, under both the full name and its
   * last dotted segment, so `Form.onSubmit` and `onSubmit` both match. A
   * `→` reference to another file prints with that file's path in front.
   * When two summaries share a name, the first one read is kept, which is
   * safe because their headers already print with a path.
   */
  fileByName: Map<string, string>;
  /**
   * Names that summaries in several files share. A callee with one of
   * these names could be any of them, so it gets no `→` marker.
   */
  ambiguousFollowNames: ReadonlySet<string>;
  /**
   * Every loaded summary with an `identity.id`, keyed by that id. When an
   * invocation effect has a `summary` id, the extractor already resolved
   * the call, so the lookup goes through this map instead of matching the
   * callee text against `fileByName`.
   */
  summaryById: Map<string, { name: string; file: string }>;
  /**
   * For each parent summary, the sub-units each callee in its body
   * spawned, in source order. A component with three `useEffect` calls
   * maps `useEffect` to its three effect summaries. The parent's
   * `+ useEffect` lines then print as `+ Component.effect#0 →` and so on,
   * pointing at the summaries printed below it.
   */
  spawnerIndex: Map<string, Map<string, string[]>>;
  /**
   * Names that more than one summary has, such as `Index` from several
   * React Router route files. Outside a file group these print with their
   * file path in front so the reader can tell them apart.
   */
  ambiguousNames: Set<string>;
  /**
   * Who invokes each deployed unit in the run, keyed by that unit's
   * boundary key, so a function nothing invokes prints differently from
   * one something does.
   */
  invokes: InvokesInRun;
  /**
   * What a request through each boundary reaches through the calls out of
   * the unit serving it. It comes from the same call facts the diff uses,
   * so summaries in every language get the same block.
   */
  reach: ReadonlyMap<BehavioralSummary, readonly ReachedEffect[]>;
}

/**
 * State for rendering one summary. `spawnerUsed` counts how many calls to
 * each spawning callee have printed so far, so the next call points at
 * the next sub-unit in order.
 */
interface PerSummaryRenderCtx {
  readonly base: RenderCtx;
  readonly parentName: string;
  /** A `→` reference into any other file prints with that file's path. */
  readonly parentFile: string;
  /** The boundary in this unit's header, which its effect lines leave out. */
  readonly ownBoundary: string | null;
  readonly spawnerUsed: Map<string, number>;
}

function perSummary(
  base: RenderCtx,
  summary: BehavioralSummary,
): PerSummaryRenderCtx {
  return {
    base,
    parentName: summary.identity.name,
    parentFile: summary.location.file,
    ownBoundary: boundaryOf(summary),
    spawnerUsed: new Map(),
  };
}

/**
 * Names that routing conventions such as React Router's and Remix's give
 * to many files at once, so the name alone tells a reader nothing. These
 * print with the file path in front, as in `app/routes/_app.loader` and
 * `app/routes/_app.admin/route.loader`.
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
 * Two transitions can land in the same slot of the tree. A throw on
 * `condA`, a throw on `!condA` and an unconditional fallback put three
 * outcomes into two sides. The slot keeps every distinct outcome, so none
 * of them drops out of the printout (#133).
 */
function leafKey(leaf: Leaf): string {
  // A "2XX" and a "4XX" response can have the same output and still be
  // different outcomes.
  return JSON.stringify({
    output: leaf.output,
    effects: leaf.effects,
    rangeSpec: leaf.rangeSpec,
    from: leaf.from,
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
  // Predicates are plain data whose schema fixes the key order, so two
  // equal predicates serialize to the same JSON.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Strips every `negation` wrapper and says whether an odd number came off.
 * `!!x` and `x` are the same test. The assembler writes the doubled form
 * for code after a guard whose condition is a call: the guard is
 * `!lookup()`, so reaching the code after it is `!!lookup()`.
 *
 * Every layer has to come off. With only one removed, the code after the
 * guard does not line up with the guard in the tree and drops out, which
 * hides the success path of any handler written as
 * `if (!check()) return error;` followed by a return.
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
    // A fall-through has fewer conditions than its siblings, so it runs
    // out at a branch. It belongs where none of the tests below matched,
    // which is the innermost empty else.
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
    // The existing leaf moves to whichever side the new one does not take.
    const branch: TreeNode = {
      kind: "branch",
      predicate: pred,
      thenBranch: positive ? { kind: "empty" } : node,
      elseBranch: positive ? node : { kind: "empty" },
    };
    return insertIntoTree(branch, conditions, i, leaf);
  }
  if (!predicateEqual(node.predicate, pred)) {
    // The transitions test different things at this depth, so they do not
    // form one decision tree. The new condition starts a branch of its own
    // on the else side.
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
      declares: null, // set afterwards by stampDeclaredStatuses
      rangeSpec: readHttpMetadata(t)?.statusRange?.spec ?? null,
      from: readWrapperMetadata(t)?.from ?? null,
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
  if (
    leaf.output.type === "render" &&
    leaf.output.root !== undefined &&
    hasRenderedContent(leaf.output.root)
  ) {
    lines.push(`${indent}-> render`);
    lines.push(...formatRenderNode(leaf.output.root, `${indent}  `));
  } else {
    let line = `${indent}-> ${formatOutput(leaf.output)}`;
    // A response declared by class or as a catch-all has no status code,
    // so it prints as "4XX" or "default" instead of "???".
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
    // A wrapper's body produced this outcome, and nothing in this unit
    // shows where it came from.
    if (leaf.from !== null) {
      line += `  (from ${leaf.from.name})`;
    }
    lines.push(line);
  }
  // Each effect prints as one line with no arguments. A `→` means the
  // callee has a summary of its own in this run, where the detail is.
  for (const effect of leaf.effects) {
    const rendered = renderEffect(effect, ctx);
    if (rendered !== null) {
      lines.push(`${indent}  ${rendered}`);
    }
  }
  return lines;
}

/**
 * One effect as a single line, or null for an effect that prints nothing,
 * such as an interaction at the unit's own boundary.
 */
function renderEffect(effect: Effect, ctx: PerSummaryRenderCtx): string | null {
  if (effect.type === "invocation") {
    const callee = normalizeSourceText(effect.callee);
    const spawned = consumeSpawnedSubUnit(ctx, callee);
    if (spawned !== null) {
      return `+ ${spawned} →`;
    }
    // `effect.summary` is the one summary the extractor resolved the call
    // to, while the callee text can match several. Only a call with no
    // recorded id falls back to matching by name.
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
  if (effect.type === "interaction") {
    if (bindingKey(effect.binding) === ctx.ownBoundary) {
      return null;
    }
    const label = effectLabel(effect);
    return label === null ? null : `+ ${label}`;
  }
  return null;
}

/**
 * The next sub-unit this callee spawned in the current summary, or null
 * when it spawned none or all of them have printed.
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
 * The `→` reference for a call the extractor resolved to a summary id: the
 * bare callee in the same file, or `<path without extension>.<name>` in
 * another. Returns null when that summary is not in this run. Guessing by
 * name at that point could point at a different function than the one the
 * id says.
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
 * The `→` reference for a call with no recorded summary id, found by
 * matching the callee's name. The full callee text is tried first, then
 * its last dotted segment, so `utils.formatError` still finds a
 * `formatError` summary. Returns null when no summary has the name, or
 * when summaries in several files do. A name can recur across a run, so
 * this match can be wrong; it is used only when there is no id to go on.
 */
function resolveFollowTargetByName(
  callee: string,
  ctx: PerSummaryRenderCtx,
): string | null {
  const byName = ctx.base.fileByName;
  // When only the last segment matched, a reference into another file
  // uses the matched name. The callee text there would print as
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

/**
 * Each transition lists every condition on its path, so the third branch
 * of an if chain has `[!C0, !C1, C2]`. Printed one by one, every
 * branch would repeat the negations of the branches before it and bury
 * the one test that picked it. Folding the transitions back into a
 * decision tree prints each test once, as nested `if`, `elif` and `else`.
 */
function renderTransitions(
  transitions: Transition[],
  declares: ((status: number) => boolean) | null,
  ctx: PerSummaryRenderCtx,
): string[] {
  // Every leaf gets the declared-status test, so the recursion does not
  // have to pass it down to mark an undeclared status.
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
 * The calls suss could not follow, under their own heading right after
 * `Reaches:`. Together they show how much of the unit the `Reaches:` list
 * covers.
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
 * How a summary is drawn in a file's tree. `elbow` ("├─ " or "└─ ") goes in
 * front of the header line and `bodyPrefix` ("│  " or spaces for the last
 * summary) in front of every line after it.
 */
interface SummaryLayout {
  readonly elbow: string;
  readonly bodyPrefix: string;
  /**
   * Under a file heading a bare `loader` is clear enough. Outside one,
   * generic and repeated names print with their file path in front.
   */
  readonly inFileGroup: boolean;
}

const STANDALONE_LAYOUT: SummaryLayout = {
  elbow: "",
  bodyPrefix: "",
  inFileGroup: false,
};

/**
 * For a deployed function the template declares no trigger for, who
 * invokes it. Without this line a reader cannot tell a function invoked
 * from somewhere else apart from one whose trigger suss failed to read.
 */
function untriggeredLine(summary: BehavioralSummary, ctx: RenderCtx): string[] {
  const lambda = summary.metadata?.awsLambda as
    | { eventTypes?: string[]; recognition?: string }
    | undefined;
  if (lambda?.recognition !== "recognized-not-http") {
    return [];
  }
  if (lambda.eventTypes === undefined || lambda.eventTypes.length > 0) {
    return [];
  }
  const binding = summary.identity.boundaryBinding;
  const key = binding === null ? null : boundaryKey(binding);
  const invokers = key === null ? undefined : ctx.invokes.byUnit.get(key);
  if (invokers !== undefined && invokers.length > 0) {
    const names = invokers.map((s) => s.identity.name).join(", ");
    return [
      `  Nothing in the template routes an event here. It is invoked by ${names}.`,
    ];
  }
  const unsettled = ctx.invokes.unsettled;
  if (unsettled > 0) {
    return [
      "  Nothing in the template routes an event here and no call in this run",
      `  names it, with ${plural(unsettled, "invoke", "invokes")} here working out the target`,
      "  at run time, so one of those could reach it.",
    ];
  }
  return [
    "  Nothing in the template routes an event here and no call in this run",
    "  names it, so whatever invokes it is outside what suss read.",
  ];
}

/**
 * A store's deployed table name and the fields a query may ask for, for a
 * provider that declares them. A reader of a table's summary looks for
 * both, and nothing else in the printout shows them.
 */
function storeLines(summary: BehavioralSummary): string[] {
  const store = readStorageContractMetadata(summary);
  if (store === undefined) {
    return [];
  }
  const lines: string[] = [];
  const identifies = store.identifies;
  const keyed =
    identifies !== undefined && identifies.kind === "keyFields"
      ? `, keyed by ${identifies.fields.join(" and ")}`
      : "";
  if (store.physicalTable !== undefined && store.physicalTable !== null) {
    lines.push(`  Table: ${store.physicalTable}${keyed}`);
  } else if (keyed !== "") {
    lines.push(`  Table${keyed}`);
  }

  const fields = store.fields ?? [];
  if (fields.length > 0) {
    const shown = fields
      .slice(0, STORE_FIELD_LIMIT)
      .map((field) =>
        field.type === undefined ? field.name : `${field.name} (${field.type})`,
      );
    const rest = fields.length - shown.length;
    const all = store.fieldSet === "exhaustive" ? "Serves" : "Serves at least";
    lines.push(
      `  ${all}: ${shown.join(", ")}${rest === 0 ? "" : `, and ${rest} more`}`,
    );
  }
  return lines;
}

/** How many store fields print before the rest are counted. */
const STORE_FIELD_LIMIT = 12;

function renderSummary(
  summary: BehavioralSummary,
  ctx: RenderCtx,
  layout: SummaryLayout = STANDALONE_LAYOUT,
): string {
  const perCtx = perSummary(ctx, summary);
  const lines: string[] = [];

  // `<name>  (<recognition> <kind> | line N | ...)`. The file heading
  // above already shows the path, so the header leaves it out.
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

  bodyLines.push(...untriggeredLine(summary, ctx));
  bodyLines.push(...storeLines(summary));

  if (summary.transitions.length > 0) {
    bodyLines.push(...renderTransitions(summary.transitions, declares, perCtx));
  }

  // The transitions above already show what the unit's own body touches,
  // so this block lists only what it reaches through its calls.
  const reached = (ctx.reach.get(summary) ?? []).filter(
    (effect) => effect.through.length > 0,
  );
  if (reached.length > 0) {
    bodyLines.push("");
    bodyLines.push("  Reaches:");
    for (const effect of reached) {
      bodyLines.push(`    ${reachText(effect, CHAIN_HOPS)}`);
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
    // Use the protocol's own label, so the header spells the route the
    // same way as the boundary key: ":id" prints as "{id}" everywhere.
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
  // A queue subscriber's header shows the unit and the channel it reads,
  // the way a route's shows what it serves. A queue from a template has
  // its channel as its name, so the channel prints once.
  if (bus !== null && bus.channel !== null) {
    const channel = `${bus.messageBus} ${bus.channel}`;
    if (summary.identity.name === bus.channel) {
      return channel;
    }
    return `${bareName(summary, ctx, layout)} → ${channel}`;
  }

  // Any other protocol with a label shows it, so a new protocol does not
  // need a branch here to get more than the bare unit name.
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
 * The part of the header in parentheses. A React effect body and an event
 * handler are both `handler` summaries, so an effect prints as
 * `react useEffect` to tell the two apart.
 */
function summaryMetadata(summary: BehavioralSummary): string {
  const parts: string[] = [];
  const binding = summary.identity.boundaryBinding;
  if (binding !== null) {
    parts.push(`${binding.recognition} ${unitKindLabel(summary)}`);
  }
  parts.push(`line ${summary.location.range.start}`);
  // A declaration served under several mounts has one summary per mount,
  // and each header says which mount it is.
  const mount = readMountMetadata(summary);
  if (mount !== undefined) {
    parts.push(`mount ${mount.prefix} (1 of ${mount.siblings})`);
  }
  // A status this unit's body never produces can come from a wrapper, so
  // the header lists them for the reader to look at.
  const applied = readWrapperMetadata(summary)?.applied ?? [];
  if (applied.length > 0) {
    parts.push(`wrapped by ${wrapperSummary(applied)}`);
  }
  if (summary.confidence.level !== "high") {
    parts.push(`confidence: ${summary.confidence.level}`);
  }
  return parts.join(" | ");
}

/** How many wrappers the header lists before it stops. */
const WRAPPERS_LISTED = 3;

/**
 * The wrappers a unit runs under, each with the file its summary is in.
 * A stack of them has to fit on the header line, so the first few are
 * listed and the rest are counted.
 */
function wrapperSummary(applied: readonly WrapperReference[]): string {
  const listed = applied.slice(0, WRAPPERS_LISTED).map(oneWrapper);
  const rest = applied.length - listed.length;
  return rest > 0 ? `${listed.join(", ")}, +${rest} more` : listed.join(", ");
}

function oneWrapper(wrapper: WrapperReference): string {
  const parts = [`${wrapper.name} (${wrapper.file})`];
  if (wrapper.scope !== undefined) {
    parts.push(`for ${wrapper.scope}`);
  }
  if (wrapper.onThrow === true) {
    parts.push("on a throw");
  }
  return parts.join(" ");
}

function unitKindLabel(summary: BehavioralSummary): string {
  const react = readReactMetadata(summary);
  if (react?.kind === "effect") {
    return `useEffect${formatEffectDeps(react.deps)}`;
  }
  return summary.kind;
}

/**
 * When a `useEffect` body runs, from its dependency list. With no list it
 * runs after every render, with an empty list once on mount, and
 * otherwise whenever a listed value changes.
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
   * Print every field of the types a summary refers to, instead of the
   * type's name. The name is the default: a reader looking at a boundary
   * mostly wants to see that it returns a `User`, and the fields of every
   * named type can make one summary a megabyte long.
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
  /**
   * Write the diff as JSON for a program to read. Plain `inspect` and
   * `inspect --dir` refuse `--json`, because the summaries they read are
   * JSON already. A diff is computed from two files and is in neither, so
   * a program has no other way to get it.
   */
  json?: boolean;
  /**
   * The files the change touched, relative to the project. A unit in one
   * of them prints as a count of what moved, since the reader has that
   * file's diff open. A unit in any other file prints in full. Without
   * the list every file counts as untouched.
   */
  changedFiles?: readonly string[];
  /**
   * The most characters the report may use. Whole files are written until
   * the next one does not fit, and the rest are counted at the end.
   * Without a budget the report prints everything.
   */
  budget?: number;
  /**
   * How many calls to print between a boundary and something it
   * reaches before the middle of the chain collapses into a count.
   * `"full"` prints every hop, `0` prints none.
   */
  chain?: number | "full";
}

/**
 * A summary with a large branch tree can run past 80 lines, and by then
 * the reader has scrolled past the file heading. A summary with more body
 * lines than this repeats the file name after each run of this many.
 */
const LONG_SUMMARY_THRESHOLD_LINES = 50;

function injectContinuationMarkers(
  rendered: string,
  layout: SummaryLayout,
  file: string,
): string {
  const lines = rendered.split("\n");
  // The first line is the header, so only the body lines count.
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

  // Files print in the order the extractor walked them, and the summaries
  // in each file by line number.
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
      // The spacer line between siblings keeps the `│` going, so the
      // tree stays joined up.
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
  const fileByName = new Map<string, string>();
  // A name that summaries in several files share cannot pick one of them,
  // and a guessed `→` looks the same as a resolved one (#121).
  const filesPerFollowName = new Map<string, Set<string>>();
  const noteFollowName = (name: string, file: string): void => {
    const seen = filesPerFollowName.get(name) ?? new Set<string>();
    seen.add(file);
    filesPerFollowName.set(name, seen);
  };
  for (const s of summaries) {
    // Nothing can call a name that is only a label, so a callee that
    // matches one does so by coincidence and gets no `→`.
    if (s.identity.nameKind === "label") {
      continue;
    }

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

  const summaryById = new Map<string, { name: string; file: string }>();
  for (const s of summaries) {
    if (s.identity.id !== undefined) {
      summaryById.set(s.identity.id, {
        name: s.identity.name,
        file: s.location.file,
      });
    }
  }

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

  // Only React effects record a parent and a source index today, so the
  // spawning callee is always `useEffect`.
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
    invokes: invokersOfUnits(summaries),
    reach: new Map(
      boundaryReach(summaries).map(({ summary, effects }) => [
        summary,
        effects,
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Diff command
// ---------------------------------------------------------------------------

/**
 * The boundary a unit serves or calls, as its boundary key when it has
 * one. The key spells a route the same way however the source wrote it,
 * so a route written ":id" before and "{id}" after still pairs in a diff.
 */
function boundaryOf(s: BehavioralSummary): string | null {
  const binding = s.identity.boundaryBinding;
  if (binding === null) {
    return null;
  }
  return bindingKey(binding);
}

function bindingKey(binding: BoundaryBinding): string {
  return boundaryKey(binding) ?? displayLabel(binding);
}

function summaryKey(s: BehavioralSummary): string {
  const boundary = boundaryOf(s);
  return boundary === null
    ? `${s.kind}::${s.identity.name}`
    : `${s.kind}:${boundary}`;
}

interface DiffPairing {
  added: Array<{ key: string; summary: BehavioralSummary }>;
  removed: Array<{ key: string; summary: BehavioralSummary }>;
  paired: Array<{
    key: string;
    before: BehavioralSummary;
    after: BehavioralSummary;
  }>;
}

function groupByKey(
  summaries: readonly BehavioralSummary[],
): Map<string, BehavioralSummary[]> {
  const groups = new Map<string, BehavioralSummary[]>();
  for (const s of summaries) {
    const key = summaryKey(s);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [s]);
    } else {
      group.push(s);
    }
  }
  return groups;
}

function namesRepeatedOnASide(
  before: readonly BehavioralSummary[],
  after: readonly BehavioralSummary[],
): Set<string> {
  const repeated = new Set<string>();
  for (const side of [before, after]) {
    const seen = new Set<string>();
    for (const s of side) {
      if (seen.has(s.identity.name)) {
        repeated.add(s.identity.name);
      }
      seen.add(s.identity.name);
    }
  }
  return repeated;
}

function unitLabel(s: BehavioralSummary, repeated: Set<string>): string {
  return repeated.has(s.identity.name)
    ? `${s.location.file}::${s.identity.name}`
    : s.identity.name;
}

/**
 * Whether the units under one key pair by their own name and file
 * instead of by the key alone. A consumer always does, because many
 * callers share one route and each has its own name. A provider pairs by
 * its boundary, the only stable identity most handlers have, unless
 * several providers serve it. A unit with no boundary is keyed by name
 * already, so it splits only when two files share the name, as three
 * repository classes with a `list` method do.
 */
function pairsByUnit(
  before: readonly BehavioralSummary[],
  after: readonly BehavioralSummary[],
): boolean {
  if (before.length > 1 || after.length > 1) {
    return true;
  }
  const first = before[0] ?? after[0];
  return (
    first !== undefined &&
    boundaryOf(first) !== null &&
    BOUNDARY_ROLE[first.kind] === "consumer"
  );
}

/**
 * The key one unit gets once its group splits. The group key of a unit
 * keyed by name already has the name in it, so the label replaces the
 * name there instead of repeating it.
 */
function unitKey(
  groupKey: string,
  s: BehavioralSummary,
  repeated: Set<string>,
): string {
  if (boundaryOf(s) === null) {
    return `${s.kind}::${unitLabel(s, repeated)}`;
  }
  return `${groupKey}::${unitLabel(s, repeated)}`;
}

function pairOneUnit(
  pairing: DiffPairing,
  key: string,
  before: BehavioralSummary | undefined,
  after: BehavioralSummary | undefined,
): void {
  if (before !== undefined && after !== undefined) {
    pairing.paired.push({ key, before, after });
  } else if (after !== undefined) {
    pairing.added.push({ key, summary: after });
  } else if (before !== undefined) {
    pairing.removed.push({ key, summary: before });
  }
}

/** Which summary on each side of a diff is the same unit. */
function pairForDiff(
  beforeSummaries: readonly BehavioralSummary[],
  afterSummaries: readonly BehavioralSummary[],
): DiffPairing {
  const beforeGroups = groupByKey(beforeSummaries);
  const afterGroups = groupByKey(afterSummaries);
  const pairing: DiffPairing = { added: [], removed: [], paired: [] };
  const keys = new Set([...beforeGroups.keys(), ...afterGroups.keys()]);

  for (const key of keys) {
    const before = beforeGroups.get(key) ?? [];
    const after = afterGroups.get(key) ?? [];

    if (!pairsByUnit(before, after)) {
      pairOneUnit(pairing, key, before[0], after[0]);
      continue;
    }

    const repeated = namesRepeatedOnASide(before, after);
    const beforeByUnit = new Map(
      before.map((s) => [unitLabel(s, repeated), s]),
    );
    const afterByUnit = new Map(after.map((s) => [unitLabel(s, repeated), s]));
    for (const [unit, afterOne] of afterByUnit) {
      pairOneUnit(
        pairing,
        unitKey(key, afterOne, repeated),
        beforeByUnit.get(unit),
        afterOne,
      );
    }
    for (const [unit, beforeOne] of beforeByUnit) {
      if (!afterByUnit.has(unit)) {
        pairOneUnit(
          pairing,
          unitKey(key, beforeOne, repeated),
          beforeOne,
          undefined,
        );
      }
    }
  }

  return pairing;
}

function bindingLabel(s: BehavioralSummary): string | null {
  const binding = s.identity.boundaryBinding;
  if (binding === null) {
    return null;
  }
  return boundaryLabel(binding);
}

/**
 * Which fields of a transition differ, for a pair whose short lines read
 * the same. The short line shows only the output and the conditions, so a
 * change to anything else would print as the same line twice, and a
 * reader gating a review on the diff could not tell what moved.
 */
function fieldsThatMoved(before: Transition, after: Transition): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  // Effects have their own lines in the report, so the raw array would
  // repeat them.
  const said = new Set(["id", "location", "effects"]);
  return [...keys]
    .filter((key) => !said.has(key))
    .filter(
      (key) =>
        JSON.stringify(before[key as keyof Transition]) !==
        JSON.stringify(after[key as keyof Transition]),
    )
    .sort();
}

const FIELD_VALUE_WIDTH = 90;

function fieldValue(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length <= FIELD_VALUE_WIDTH
    ? text
    : `${text.slice(0, FIELD_VALUE_WIDTH - 3)}...`;
}

/**
 * Each field the short line does not show, with its old and new values.
 * The field name alone would not tell the reader what changed.
 */
function fieldChanges(before: Transition, after: Transition): string[] {
  return fieldsThatMoved(before, after).map((key) => {
    const was = fieldValue(before[key as keyof Transition]);
    const now = fieldValue(after[key as keyof Transition]);
    return `${key}: ${was} -> ${now}`;
  });
}

function renderGuard(t: Transition): string {
  return t.conditions.map((c) => formatCondition(c)).join(" && ");
}

/**
 * `spellDefault` prints a fall-through's own conditions in place of the
 * word `otherwise`. A diff of two fall-throughs that differ only in their
 * guard would print the same line twice without it. `alone` marks the
 * only transition of its unit.
 */
function renderTransitionShort(
  t: Transition,
  spellDefault = false,
  alone = false,
): string {
  // A bare `401` means nothing to someone who has never read a summary,
  // and a diff is usually the first thing such a reader sees.
  const output =
    t.output.type === "response"
      ? `responds ${formatOutput(t.output)}`
      : formatOutput(t.output);
  return withGuard(t, output, spellDefault, alone);
}

/** One outcome and the test that leads to it. */
function withGuard(
  t: Transition,
  output: string,
  spellDefault: boolean,
  alone: boolean,
): string {
  const conditions = renderGuard(t);
  if (t.isDefault && !spellDefault) {
    // A default is the path taken when no test above it matched. A unit
    // with one path has no tests, so its line gets no "otherwise".
    return alone ? output : `${output}  otherwise`;
  }
  return conditions ? `${output}  when  ${conditions}` : output;
}

/** `responds 200`, for a line that renders the body itself. */
function statusWord(t: Transition): string | null {
  if (t.output.type !== "response") {
    return null;
  }
  const status =
    t.output.statusCode !== null ? formatRef(t.output.statusCode) : "???";
  return `responds ${status}`;
}

function defaultGuardMoved(before: Transition, after: Transition): boolean {
  return (
    before.isDefault &&
    after.isDefault &&
    renderGuard(before) !== renderGuard(after)
  );
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

/** One unit that moved, with what the report needs to say about it. */
interface MovedUnit {
  /** What the unit pairs by across the two runs. */
  readonly key: string;
  readonly change: "added" | "removed" | "changed";
  readonly file: string;
  readonly name: string;
  readonly kind: BehavioralSummary["kind"];
  readonly recognition: string | null;
  readonly boundary: string | null;
  /** Whether crossing the boundary it is on leaves the process. */
  readonly leavesTheProcess: boolean;
  /**
   * The outcomes that moved, or every outcome of a unit that came or went
   * whole. The printed report lists only the first few of those.
   */
  readonly outcomes: readonly OutcomeLine[];
  /** What it started or stopped doing at a boundary of its own. */
  readonly effects: readonly EffectLine[];
  readonly counts: ChangeCounts;
  readonly diff: SummaryDiff | null;
}

/** One outcome that moved, in the words the report uses. */
interface OutcomeLine {
  readonly change: MovedUnit["change"];
  /** The outcome and the test that leads to it. A changed one reads as it does now. */
  readonly outcome: string;
  /** How a changed outcome read before, when the report prints both. */
  readonly was?: string;
  /** Fields the outcome leaves out, each with its old and new value. */
  readonly fields?: readonly string[];
  /** The wrapper whose body produced this outcome, if one did. */
  readonly wrapper: WrapperReference | undefined;
}

/** Something a boundary started or stopped doing, in the words the report uses. */
interface EffectLine {
  readonly change: "added" | "removed";
  /** `writes postgresql:audit_log`, as the report prints it. */
  readonly effect: string;
  /** The relation and the boundary, for an effect at a boundary. */
  readonly relation?: Relation;
  readonly boundary?: string;
  /** The variable a config read takes, which the boundary label leaves out. */
  readonly detail?: string;
  /** The calls from the unit to the one that does it, empty for its own effect. */
  readonly through: readonly string[];
}

/** An effect before the report says whether it came or went. */
type EffectWords = Omit<EffectLine, "change" | "through">;

/**
 * How many outcomes and how many effects moved. A reader wants to know
 * what a unit returns now and what it does on the way, and a count of
 * transitions shows neither.
 */
interface ChangeCounts {
  readonly outcomes: number;
  readonly effects: number;
}

/** How many responses of an added or removed unit print before a count. */
const OUTPUTS_LISTED = 6;

const NO_CHANGES: ChangeCounts = { outcomes: 0, effects: 0 };

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a transition changed what it returns or what leads to it. */
function outcomeMoved(before: Transition, after: Transition): boolean {
  return (
    !sameJson(before.output, after.output) ||
    !sameJson(before.conditions, after.conditions) ||
    before.isDefault !== after.isDefault
  );
}

/**
 * A transition that came or went is a new outcome, and a new effect as
 * well when it does anything on its way.
 */
function countsOf(diff: SummaryDiff): ChangeCounts {
  let outcomes = diff.addedTransitions.length + diff.removedTransitions.length;
  let effects = [...diff.addedTransitions, ...diff.removedTransitions].filter(
    (transition) => transition.effects.length > 0,
  ).length;

  for (const { before, after } of diff.changedTransitions) {
    if (outcomeMoved(before, after)) {
      outcomes += 1;
    }
    if (!sameJson(before.effects, after.effects)) {
      effects += 1;
    }
  }

  return { outcomes, effects };
}

function countsOfWholeUnit(summary: BehavioralSummary): ChangeCounts {
  return {
    outcomes: summary.transitions.length,
    effects: summary.transitions.filter(
      (transition) => transition.effects.length > 0,
    ).length,
  };
}

function counted(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** `2 outcomes, 1 effect`, and nothing at all when neither moved. */
function countLine(counts: ChangeCounts): string {
  const parts: string[] = [];
  if (counts.outcomes > 0) {
    parts.push(counted(counts.outcomes, "outcome"));
  }
  if (counts.effects > 0) {
    parts.push(counted(counts.effects, "effect"));
  }
  return parts.join(", ");
}

function movedUnit(
  key: string,
  change: MovedUnit["change"],
  summary: BehavioralSummary,
  diff: SummaryDiff | null,
): MovedUnit {
  const binding = summary.identity.boundaryBinding;
  const alone = summary.transitions.length === 1;
  return {
    key,
    change,
    file: summary.location.file,
    name: summary.identity.name,
    kind: summary.kind,
    recognition: binding === null ? null : binding.recognition,
    boundary: bindingLabel(summary),
    leavesTheProcess: binding !== null && leavesTheProcess(binding),
    outcomes:
      diff === null
        ? wholeUnitOutcomes(change, summary)
        : transitionLines(diff, alone),
    effects:
      diff === null ? wholeUnitEffects(change, summary) : effectChanges(diff),
    counts: diff === null ? countsOfWholeUnit(summary) : countsOf(diff),
    diff,
  };
}

/** Every outcome of a unit that came or went whole. */
function wholeUnitOutcomes(
  change: MovedUnit["change"],
  summary: BehavioralSummary,
): OutcomeLine[] {
  const alone = summary.transitions.length === 1;
  return summary.transitions.map((transition) => ({
    change,
    outcome: renderTransitionShort(transition, false, alone),
    wrapper: undefined,
  }));
}

/** Everything a unit that came or went whole does at a boundary. */
function wholeUnitEffects(
  change: MovedUnit["change"],
  summary: BehavioralSummary,
): EffectLine[] {
  const came = change === "added" ? "added" : "removed";
  return [...effectWords(summary.transitions).values()]
    .sort(byEffect)
    .map((words) => ({ change: came, ...words, through: [] }));
}

function changeCount(diff: SummaryDiff): number {
  return (
    diff.addedTransitions.length +
    diff.removedTransitions.length +
    diff.changedTransitions.length
  );
}

/** Every unit that moved, in no particular order. */
function unitsThatMoved(pairing: DiffPairing): MovedUnit[] {
  const moved: MovedUnit[] = [];

  for (const { key, summary } of pairing.added) {
    moved.push(movedUnit(key, "added", summary, null));
  }

  for (const { key, summary } of pairing.removed) {
    moved.push(movedUnit(key, "removed", summary, null));
  }

  for (const { key, before, after } of pairing.paired) {
    const diff = diffSummaries(before, after);
    if (changeCount(diff) === 0) {
      continue;
    }
    moved.push(movedUnit(key, "changed", after, diff));
  }

  return moved;
}

function transitionWord(count: number): string {
  return `${count} transition${count === 1 ? "" : "s"}`;
}

/**
 * An effect at a boundary. The detail goes after the boundary label
 * because the label of a config read says only which recognizer read it.
 */
function atBoundary(
  relation: Relation,
  boundary: string,
  detail: string | undefined,
): EffectWords {
  const label = detail === undefined ? boundary : `${boundary} ${detail}`;
  return {
    effect: `${relation} ${label}`,
    relation,
    boundary,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** One effect as the diff report words it, or null to leave it out. */
const EFFECT_WORDS: DispatchTable<Effect, EffectWords | null> = {
  interaction: (effect) => {
    const [relation] = goesThroughRelation(effect.interaction)
      ? []
      : relationsOf(effect.interaction);
    if (relation === undefined) {
      return null;
    }
    return atBoundary(
      relation,
      displayLabel(effect.binding),
      interactionDetail(effect.interaction),
    );
  },
  mutation: (effect) => ({ effect: `${effect.operation}s ${effect.target}` }),
  emission: (effect) => ({ effect: `emits ${effect.event}` }),
  stateChange: (effect) => ({ effect: `sets ${effect.variable}` }),
  // The source diff already shows a call to another function in the
  // project, and what that function does is reported under its own name.
  invocation: () => null,
};

function effectLabel(effect: Effect): string | null {
  return dispatchByType(EFFECT_WORDS, effect)?.effect ?? null;
}

/** The effects of these transitions, once each, by the words they print as. */
function effectWords(
  transitions: readonly Transition[],
): Map<string, EffectWords> {
  const words = new Map<string, EffectWords>();
  for (const transition of transitions) {
    for (const effect of transition.effects) {
      const said = dispatchByType(EFFECT_WORDS, effect);
      if (said !== null) {
        words.set(said.effect, said);
      }
    }
  }
  return words;
}

/** The order the effects under one heading print in, by code unit. */
function byEffect(a: EffectWords, b: EffectWords): number {
  if (a.effect === b.effect) {
    return 0;
  }
  return a.effect < b.effect ? -1 : 1;
}

/** The effects in `from` that `against` does not have. */
function effectsOnlyIn(
  from: ReadonlyMap<string, EffectWords>,
  against: ReadonlyMap<string, EffectWords>,
  change: EffectLine["change"],
): EffectLine[] {
  return [...from.values()]
    .filter((words) => !against.has(words.effect))
    .sort(byEffect)
    .map((words) => ({ change, ...words, through: [] }));
}

/** What the unit itself started or stopped doing, once per effect. */
function effectChanges(diff: SummaryDiff): EffectLine[] {
  const before = effectWords([
    ...diff.removedTransitions,
    ...diff.changedTransitions.map((pair) => pair.before),
  ]);
  const after = effectWords([
    ...diff.addedTransitions,
    ...diff.changedTransitions.map((pair) => pair.after),
  ]);

  return [
    ...effectsOnlyIn(after, before, "added"),
    ...effectsOnlyIn(before, after, "removed"),
  ];
}

/** The fields of a body, for one written out as a record. */
function bodyFields(output: Output): Record<string, TypeShape> | null {
  if (output.type !== "response" || output.body?.type !== "record") {
    return null;
  }
  return (output.body.spreads ?? []).length > 0 ? null : output.body.properties;
}

/**
 * The body with a marker on each field that moved: `{ id, name, -email }`.
 * Null when either side is not a plain record or no field moved, in which
 * case both lines print in full.
 */
function markedBody(before: Transition, after: Transition): string | null {
  const was = bodyFields(before.output);
  const now = bodyFields(after.output);
  if (was === null || now === null) {
    return null;
  }

  const marked = Object.entries(now).map(([field, shape]) =>
    markedField(field, was[field], shape),
  );
  for (const field of Object.keys(was)) {
    if (now[field] === undefined) {
      marked.push(`-${field}`);
    }
  }

  return marked.some((field) => /^[-+~]/.test(field))
    ? `{ ${trimmed(marked).join(", ")} }`
    : null;
}

/** A field of the body, marked when it came, went or changed type. */
function markedField(
  field: string,
  was: TypeShape | undefined,
  now: TypeShape,
): string {
  if (was === undefined) {
    return `+${field}: ${formatBodyShape(now)}`;
  }
  return sameJson(was, now)
    ? field
    : `~${field}: ${formatBodyShape(was)} -> ${formatBodyShape(now)}`;
}

/**
 * Every field that moved, and enough of the others for the reader to
 * recognise the body.
 */
function trimmed(fields: readonly string[]): string[] {
  const moved = fields.filter((field) => /^[-+~]/.test(field));
  if (fields.length <= FIELDS_LISTED + moved.length) {
    return [...fields];
  }
  const held = fields.filter((field) => !/^[-+~]/.test(field));
  return [...held.slice(0, FIELDS_LISTED), "...", ...moved];
}

/** How many unchanged fields print beside the ones that moved. */
const FIELDS_LISTED = 4;

/** The wrapper whose body produced this outcome, if a wrapper did. */
function wrapperOf(transition: Transition): WrapperReference | undefined {
  return readWrapperMetadata(transition)?.from;
}

function transitionLines(diff: SummaryDiff, alone: boolean): OutcomeLine[] {
  const lines: OutcomeLine[] = [];

  for (const t of diff.addedTransitions) {
    lines.push({
      change: "added",
      outcome: renderTransitionShort(t, false, alone),
      wrapper: wrapperOf(t),
    });
  }

  for (const t of diff.removedTransitions) {
    lines.push({
      change: "removed",
      outcome: renderTransitionShort(t, false, alone),
      wrapper: wrapperOf(t),
    });
  }

  for (const { before: b, after: a } of diff.changedTransitions) {
    const spellDefault = defaultGuardMoved(b, a);
    const beforeLine = renderTransitionShort(b, spellDefault, alone);
    const afterLine = renderTransitionShort(a, spellDefault, alone);
    const marked = markedBody(b, a);
    const status = statusWord(a);
    // When only the body's fields changed, one line with the fields
    // marked is easier to read than two whole shapes side by side.
    if (
      marked !== null &&
      status !== null &&
      renderGuard(b) === renderGuard(a)
    ) {
      const outcome = withGuard(a, `${status} ${marked}`, spellDefault, alone);
      lines.push({ change: "changed", outcome, wrapper: undefined });
      continue;
    }
    // A pair with the same line and no other field changed differs only
    // in its effects, and the unit's effect lines already show those.
    const fields = beforeLine === afterLine ? fieldChanges(b, a) : [];
    if (beforeLine === afterLine && fields.length === 0) {
      continue;
    }
    lines.push({
      change: "changed",
      outcome: afterLine,
      was: beforeLine,
      ...(fields.length === 0 ? {} : { fields }),
      wrapper: undefined,
    });
  }

  return lines;
}

/**
 * The printed lines of one outcome. A changed outcome that needs its old
 * line prints both together, since neither makes sense without the other.
 */
function outcomeTexts(line: OutcomeLine): string[] {
  if (line.was === undefined) {
    return [`${NAME_MARKERS[line.change]} ${line.outcome}`];
  }
  return [
    `~ was  ${line.was}`,
    `  now  ${line.outcome}`,
    ...(line.fields ?? []).map((field) => `  ${field}`),
  ];
}

/**
 * What one boundary now does: the responses that moved, and what the
 * request reaches on its way through the project.
 */
interface BoundaryBlock {
  readonly change: MovedUnit["change"];
  readonly does: "serves" | "calls";
  readonly boundary: string;
  readonly unit: string;
  readonly file: string;
  /** What it returns, and under what test. */
  outcomes: OutcomeLine[];
  /** What a request touches on its way through, and where. */
  readonly effects: EffectLine[];
  /** How many outcomes moved, which is fewer than the lines printed. */
  outcomeChanges: number;
}

/** How many calls a chain prints before the middle of it collapses. */
const CHAIN_HOPS = 3;

/**
 * The calls between a boundary and something it reaches. The reader
 * mostly cares about the effect at the end, so a long chain prints its
 * first and last call and counts the ones between.
 */
function chainLine(through: readonly string[], hops: number | "full"): string {
  if (through.length === 0 || hops === 0) {
    return "";
  }
  if (hops === "full" || through.length <= Math.max(hops, 2)) {
    return `  through ${through.join(" -> ")}`;
  }
  const skipped = through.length - 2;
  const middle = `(${skipped} intermediate unit${skipped === 1 ? "" : "s"} collapsed)`;
  return `  through ${through[0]} -> ${middle} -> ${through[through.length - 1]}`;
}

function reachText(effect: ReachedEffect, hops: number | "full"): string {
  return `${effect.relation} ${effect.label}${chainLine(effect.through, hops)}`;
}

function effectText(line: EffectLine, hops: number | "full"): string {
  return `${NAME_MARKERS[line.change]} ${line.effect}${chainLine(line.through, hops)}`;
}

/** Something a boundary reaches through a call, as a line of its block. */
function reachLine(
  effect: ReachedEffect,
  change: EffectLine["change"],
): EffectLine {
  return {
    change,
    ...atBoundary(effect.relation, effect.boundary, effect.detail),
    through: effect.through,
  };
}

/**
 * What a unit that came or went whole responds with. Its heading already
 * says which, so the lines get no marker, and a long list is cut short.
 */
function wholeUnitTexts(outcomes: readonly OutcomeLine[]): string[] {
  const listed = outcomes.slice(0, OUTPUTS_LISTED).map((line) => line.outcome);
  const rest = outcomes.length - listed.length;
  return rest > 0 ? [...listed, `${transitionWord(rest)} more`] : listed;
}

/** The outcome lines of a unit or a block, as the report prints them. */
function responseTexts(
  change: MovedUnit["change"],
  outcomes: readonly OutcomeLine[],
): string[] {
  return change === "changed"
    ? outcomes.flatMap(outcomeTexts)
    : wholeUnitTexts(outcomes);
}

/**
 * Whether this unit is on one side of a boundary that leaves the process.
 * A call from one function in the project to another is also a boundary,
 * but the pull request's own diff already shows those.
 */
function atABoundary(unit: MovedUnit): boolean {
  return unit.boundary !== null && unit.leavesTheProcess;
}

/** Which side of the boundary the unit is on, in a word. */
function boundaryVerb(unit: MovedUnit): "serves" | "calls" {
  return BOUNDARY_ROLE[unit.kind] === "provider" ? "serves" : "calls";
}

function countsOfBlock(block: BoundaryBlock): ChangeCounts {
  return { outcomes: block.outcomeChanges, effects: block.effects.length };
}

function blockHeading(block: BoundaryBlock): string {
  const counts = countLine(countsOfBlock(block));
  const heading = `${NAME_MARKERS[block.change]} ${block.does} ${block.boundary}  ${block.file}::${block.unit}`;
  return counts === "" ? heading : `${heading}  (${counts})`;
}

/** The block's outcomes and effects, each group under its own heading. */
function blockLines(block: BoundaryBlock, hops: number | "full"): string[] {
  const lines: string[] = [];
  for (const [group, under] of [
    ["outcomes", responseTexts(block.change, block.outcomes)],
    ["effects", block.effects.map((effect) => effectText(effect, hops))],
  ] as const) {
    if (under.length === 0) {
      continue;
    }
    lines.push(`  ${group}`);
    lines.push(...under.map((line) => `    ${line}`));
  }
  return lines;
}

/**
 * One block per boundary that moved: what it returns, then what the
 * request goes on to reach. A unit deeper in the project gets no block,
 * because the blocks of the boundaries that reach it already show what
 * changed.
 */
function boundaryBlocks(
  moved: readonly MovedUnit[],
  reach: readonly EntrypointChange[],
): BoundaryBlock[] {
  const blocks = new Map<string, BoundaryBlock>();

  for (const unit of moved) {
    if (!atABoundary(unit)) {
      continue;
    }
    const boundary = unit.boundary ?? unit.name;
    blocks.set(entrypointKey(unit.file, unit.name, boundary), {
      change: unit.change,
      does: boundaryVerb(unit),
      boundary,
      unit: unit.name,
      file: unit.file,
      outcomes: [...unit.outcomes],
      effects: [...unit.effects],
      outcomeChanges: unit.counts.outcomes,
    });
  }

  for (const change of reach) {
    const already = blocks.get(change.key);
    // A changed unit's block already lists its own effects, so only what
    // it reaches through a call is added.
    const wanted = (effect: ReachedEffect): boolean =>
      already === undefined || effect.through.length > 0;
    const effects = [
      ...change.gained
        .filter(wanted)
        .map((effect) => reachLine(effect, "added")),
      ...change.lost
        .filter(wanted)
        .map((effect) => reachLine(effect, "removed")),
    ];
    if (already === undefined) {
      blocks.set(change.key, {
        change: change.change,
        does: "serves",
        boundary: change.boundary,
        unit: change.unit,
        file: change.file,
        outcomes: [],
        effects,
        outcomeChanges: 0,
      });
      continue;
    }
    already.effects.push(...effects);
  }

  return [...blocks.values()]
    .filter(
      (block) =>
        block.change !== "changed" ||
        block.outcomes.length + block.effects.length > 0,
    )
    .sort(
      (a, b) =>
        a.boundary.localeCompare(b.boundary) || a.unit.localeCompare(b.unit),
    );
}

/** The boundaries each wrapper runs on, by the labels the report prints. */
function wrappersApplied(
  summaries: readonly BehavioralSummary[],
): Map<string, string[]> {
  const runsOn = new Map<string, string[]>();
  for (const summary of summaries) {
    const label = bindingLabel(summary);
    if (label === null) {
      continue;
    }
    for (const wrapper of readWrapperMetadata(summary)?.applied ?? []) {
      const key = `${wrapper.file}::${wrapper.name}`;
      runsOn.set(key, [...(runsOn.get(key) ?? []), label]);
    }
  }
  return runsOn;
}

/**
 * What each boundary responds with after the change, for the scope lines
 * under a shared cause.
 */
function outcomesAt(
  summaries: readonly BehavioralSummary[],
): Map<string, Set<string>> {
  const at = new Map<string, Set<string>>();
  for (const summary of summaries) {
    const label = bindingLabel(summary);
    if (label === null) {
      continue;
    }
    const lines = at.get(label) ?? new Set<string>();
    for (const transition of summary.transitions) {
      lines.add(
        renderTransitionShort(
          transition,
          false,
          summary.transitions.length === 1,
        ),
      );
    }
    at.set(label, lines);
  }
  return at;
}

/**
 * Finds an outcome that one wrapper added at several boundaries, so the
 * report can print it once under the wrapper. Removes those lines from
 * the boundary blocks.
 */
function liftSharedCauses(
  blocks: readonly BoundaryBlock[],
  runsOn: ReadonlyMap<string, string[]>,
  outcomes: ReadonlyMap<string, Set<string>>,
): SharedCause[] {
  const candidates: CausedLine[] = blocks.flatMap((block) =>
    block.outcomes.flatMap((line) => causedLine(block, line)),
  );

  const causes = sharedCauses(
    candidates,
    (wrapper) => runsOn.get(`${wrapper.file}::${wrapper.name}`) ?? [],
    (boundary, outcome) => outcomes.get(boundary)?.has(outcome) === true,
  );

  for (const cause of causes) {
    for (const block of blocks) {
      if (!cause.keys.has(`${block.file}::${block.unit}`)) {
        continue;
      }
      block.outcomes = block.outcomes.filter(
        (line) =>
          line.change !== cause.change || line.outcome !== cause.outcome,
      );
    }
  }

  return causes;
}

/**
 * An outcome that came or went, as a line a wrapper may have produced at
 * other boundaries too. A changed outcome never records its wrapper, so
 * it is never lifted.
 */
function causedLine(block: BoundaryBlock, line: OutcomeLine): CausedLine[] {
  if (line.change === "changed") {
    return [];
  }
  return [
    {
      key: `${block.file}::${block.unit}`,
      boundary: block.boundary,
      change: line.change,
      outcome: line.outcome,
      wrapper: line.wrapper,
    },
  ];
}

function causeText(cause: SharedCause): string {
  return `${NAME_MARKERS[cause.change]} ${cause.outcome}`;
}

/** One heading per wrapper, with every line it brought under it. */
function causeBlocks(causes: readonly SharedCause[]): string[][] {
  const byWrapper = new Map<string, SharedCause[]>();
  for (const cause of causes) {
    const key = `${cause.wrapper.name}  ${cause.wrapper.file}`;
    byWrapper.set(key, [...(byWrapper.get(key) ?? []), cause]);
  }

  return [...byWrapper.entries()].map(([wrapper, under]) => [
    `From ${wrapper}`,
    ...under.flatMap((cause) => [
      `  ${causeText(cause)}`,
      ...scopeLines(cause).map((line) => `    ${line}`),
    ]),
    "",
  ]);
}

/** The report's first line, with the size of the change. */
function headlineOf(
  blocks: readonly BoundaryBlock[],
  moved: readonly MovedUnit[],
): string {
  const atOne = new Set(blocks.map((block) => `${block.file}::${block.unit}`));
  const elsewhere = moved.filter(
    (unit) => !atOne.has(`${unit.file}::${unit.name}`),
  ).length;
  const rest =
    elsewhere === 0
      ? ""
      : ` ${elsewhere} unit${elsewhere === 1 ? "" : "s"} inside the project also changed.`;

  if (blocks.length === 0) {
    return `${NOTHING_AT_A_BOUNDARY}${rest}`;
  }

  const counts = countLine(
    blocks.reduce((total, block) => {
      const own = countsOfBlock(block);
      return {
        outcomes: total.outcomes + own.outcomes,
        effects: total.effects + own.effects,
      };
    }, NO_CHANGES),
  );
  const boundaries = `${blocks.length} boundar${blocks.length === 1 ? "y" : "ies"} changed`;
  return counts === ""
    ? `${boundaries}.${rest}`
    : `${boundaries}: ${counts}.${rest}`;
}

interface FileSection {
  readonly file: string;
  readonly touched: boolean;
  readonly units: MovedUnit[];
}

/**
 * The units that moved, grouped by file. Files the change did not touch
 * come first, and a file where a unit changed comes before one where
 * units were only added or removed.
 */
function sectionsByFile(
  moved: readonly MovedUnit[],
  changedFiles: ReadonlySet<string>,
): FileSection[] {
  const byFile = new Map<string, MovedUnit[]>();
  for (const unit of moved) {
    const units = byFile.get(unit.file);
    if (units === undefined) {
      byFile.set(unit.file, [unit]);
      continue;
    }
    units.push(unit);
  }

  const sections = [...byFile.entries()].map(([file, units]) => ({
    file,
    touched: changedFiles.has(file),
    units: units.sort(byBoundaryThenName),
  }));

  return sections.sort((a, b) => {
    if (a.touched !== b.touched) {
      return a.touched ? 1 : -1;
    }
    const movedA = a.units.some((unit) => unit.change === "changed");
    const movedB = b.units.some((unit) => unit.change === "changed");
    if (movedA !== movedB) {
      return movedA ? -1 : 1;
    }
    return a.file.localeCompare(b.file);
  });
}

function byBoundaryThenName(a: MovedUnit, b: MovedUnit): number {
  if ((a.boundary === null) !== (b.boundary === null)) {
    return a.boundary === null ? 1 : -1;
  }
  return a.name.localeCompare(b.name);
}

function fileHeading(section: FileSection): string {
  return section.touched
    ? `${section.file}  (changed in this pull request)`
    : section.file;
}

const NAME_MARKERS: Record<MovedUnit["change"], string> = {
  added: "+",
  removed: "-",
  changed: "~",
};

/** Up to this many lines under a unit are printed instead of counted. */
const WRITTEN_OUT = 4;

/** Lines already printed under a shared cause, by the unit they came from. */
type LiftedLines = Map<string, { texts: Set<string>; wrappers: Set<string> }>;

function liftedByUnit(causes: readonly SharedCause[]): LiftedLines {
  const lifted: LiftedLines = new Map();
  for (const cause of causes) {
    for (const key of cause.keys) {
      const already = lifted.get(key) ?? {
        texts: new Set<string>(),
        wrappers: new Set<string>(),
      };
      already.texts.add(causeText(cause));
      already.wrappers.add(cause.wrapper.name);
      lifted.set(key, already);
    }
  }
  return lifted;
}

/**
 * The units that moved in one file. A unit with a few changed lines has
 * them written out, and one with more gets counts. In a file the pull
 * request edited, every unit gets counts, since the reader has that
 * file's diff open.
 */
function fileBlock(
  section: FileSection,
  lifted: LiftedLines,
  inABlock: ReadonlySet<string>,
  hops: number | "full",
): string[] {
  const lines = section.units.flatMap((unit) => {
    const key = `${unit.file}::${unit.name}`;
    const name = `  ${NAME_MARKERS[unit.change]} ${unit.name}`;
    if (inABlock.has(key)) {
      return [name];
    }
    const said = lifted.get(key);
    const moved = [
      ...responseTexts(unit.change, unit.outcomes),
      ...unit.effects.map((effect) => effectText(effect, hops)),
    ].filter((line) => said?.texts.has(line) !== true);

    if (moved.length === 0 && said !== undefined) {
      return [`${name}  from ${[...said.wrappers].join(", ")}`];
    }
    if (!section.touched && moved.length > 0 && moved.length <= WRITTEN_OUT) {
      return [name, ...moved.map((line) => `      ${line}`)];
    }
    const counts = countLine(unit.counts);
    return [counts === "" ? name : `${name}  ${counts}`];
  });
  return [fileHeading(section), ...lines, ""];
}

/**
 * What the budget cut, so a shortened report cannot be mistaken for the
 * whole change.
 */
function omissionLine(
  boundaries: number,
  units: number,
  files: number,
): string {
  const parts: string[] = [];
  if (boundaries > 0) {
    parts.push(
      boundaries === 1 ? "1 more boundary" : `${boundaries} more boundaries`,
    );
  }
  if (files > 0) {
    const filePart = files === 1 ? "1 more file" : `${files} more files`;
    const unitPart = units === 1 ? "1 more unit" : `${units} more units`;
    parts.push(`${unitPart} in ${filePart}`);
  }
  return `... ${parts.join(", and ")}. The whole diff is what \`suss inspect --diff\` prints without a budget.`;
}

/** The line a report opens with when no boundary moved. */
const NOTHING_AT_A_BOUNDARY =
  "Nothing a client of this project can see changed.";

/**
 * What moved between two runs, worked out once. The printed report and
 * the JSON both render this, so they list the same boundaries and lift
 * the same lines under a wrapper.
 */
interface DiffReport {
  readonly moved: readonly MovedUnit[];
  /** Every boundary that moved, including one whose lines all went to a cause. */
  readonly blocks: readonly BoundaryBlock[];
  readonly causes: readonly SharedCause[];
}

function diffReport(
  pairing: DiffPairing,
  before: readonly BehavioralSummary[],
  after: readonly BehavioralSummary[],
): DiffReport {
  const moved = unitsThatMoved(pairing);
  const blocks = boundaryBlocks(moved, reachChanges(before, after));
  const causes = liftSharedCauses(
    blocks,
    wrappersApplied(after),
    outcomesAt(after),
  );
  return { moved, blocks, causes };
}

/**
 * The blocks with something left to list. A block whose lines all moved
 * under a shared cause is left out, since the cause lists its boundary.
 */
function blocksWithLines(blocks: readonly BoundaryBlock[]): BoundaryBlock[] {
  return blocks.filter(
    (block) =>
      block.change !== "changed" ||
      block.outcomes.length + block.effects.length > 0,
  );
}

/**
 * The report: what moved at each boundary, then each file with the units
 * in it that moved. `budget` caps its length in characters, and whatever
 * does not fit is counted at the end.
 */
function renderReport(
  report: DiffReport,
  changedFiles: ReadonlySet<string>,
  options: { budget: number | null; hops: number | "full" },
): string {
  const { moved, blocks, causes } = report;
  const printed = blocksWithLines(blocks);
  const sections = sectionsByFile(moved, changedFiles);
  const lifted = liftedByUnit(causes);
  // A unit with its own block above appears in the file list by name
  // only, since the block already shows what it did.
  const inABlock = new Set(
    printed.map((block) => `${block.file}::${block.unit}`),
  );
  const lines: string[] = [];
  const left = { boundaries: 0, units: 0, files: 0 };
  const budget = options.budget;
  let written = 0;

  const fits = (block: readonly string[]): boolean => {
    const length = block.join("\n").length + 1;
    if (budget !== null && written + length > budget && lines.length > 0) {
      return false;
    }
    written += length;
    lines.push(...block);
    return true;
  };

  fits([headlineOf(blocks, moved), ""]);

  for (const block of causeBlocks(causes)) {
    fits(block);
  }

  for (const block of printed) {
    if (!fits([blockHeading(block), ...blockLines(block, options.hops), ""])) {
      left.boundaries += 1;
    }
  }

  // The heading is written with the first file that fits, so a report cut
  // short never ends on a heading with nothing under it.
  let headed = false;
  for (const section of sections) {
    const units = fileBlock(section, lifted, inABlock, options.hops);
    const block = headed ? units : ["Changes by file", "", ...units];
    if (!fits(block)) {
      left.files += 1;
      left.units += section.units.length;
      continue;
    }
    headed = true;
  }

  if (left.boundaries > 0 || left.files > 0) {
    lines.push(omissionLine(left.boundaries, left.units, left.files));
  }

  return lines.join("\n");
}

/** One summary that moved, as `inspect --diff --json` writes it. */
interface DiffedSummary {
  readonly key: string;
  readonly change: "added" | "removed" | "changed";
  readonly kind: string;
  readonly file: string | null;
  readonly addedTransitions?: unknown[];
  readonly removedTransitions?: unknown[];
  readonly changedTransitions?: unknown[];
}

/** An outcome at a boundary, as `inspect --diff --json` writes it. */
type DiffedOutcome = Omit<OutcomeLine, "wrapper"> & {
  readonly from?: WrapperReference;
};

/** One boundary that moved, as `inspect --diff --json` writes it. */
interface DiffedBoundary {
  readonly change: MovedUnit["change"];
  readonly does: BoundaryBlock["does"];
  readonly boundary: string;
  readonly unit: string;
  readonly file: string;
  readonly outcomes: readonly DiffedOutcome[];
  readonly effects: readonly EffectLine[];
}

/** An outcome one wrapper produced at several boundaries, as the JSON writes it. */
interface DiffedCause {
  readonly from: WrapperReference;
  readonly change: SharedCause["change"];
  readonly outcome: string;
  readonly at: readonly string[];
  readonly notAt: readonly string[];
  readonly covered: number;
}

function diffedSummary(unit: MovedUnit): DiffedSummary {
  const entry = {
    key: unit.key,
    change: unit.change,
    kind: unit.kind,
    file: unit.file,
  };
  if (unit.diff === null) {
    return entry;
  }
  return {
    ...entry,
    addedTransitions: unit.diff.addedTransitions,
    removedTransitions: unit.diff.removedTransitions,
    changedTransitions: unit.diff.changedTransitions,
  };
}

function diffedOutcome({ wrapper, ...line }: OutcomeLine): DiffedOutcome {
  return wrapper === undefined ? line : { ...line, from: wrapper };
}

function diffedBoundary(block: BoundaryBlock): DiffedBoundary {
  return {
    change: block.change,
    does: block.does,
    boundary: block.boundary,
    unit: block.unit,
    file: block.file,
    outcomes: block.outcomes.map(diffedOutcome),
    effects: block.effects,
  };
}

function diffedCause(cause: SharedCause): DiffedCause {
  return {
    from: cause.wrapper,
    change: cause.change,
    outcome: cause.outcome,
    at: cause.boundaries,
    notAt: cause.exceptions,
    covered: cause.covered,
  };
}

/**
 * The diff as JSON, from the same report the printed form renders. A
 * summary that did not change is left out, because listing every
 * unchanged boundary would bury the ones that did.
 */
function writeDiffJson(report: DiffReport): void {
  const json = {
    version: 1,
    changed: report.moved.length,
    summaries: report.moved.map(diffedSummary),
    boundaries: blocksWithLines(report.blocks).map(diffedBoundary),
    causes: report.causes.map(diffedCause),
  };
  process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
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

  const report = diffReport(
    pairForDiff(beforeSummaries, afterSummaries),
    beforeSummaries,
    afterSummaries,
  );

  if (options.json === true) {
    writeDiffJson(report);
    return;
  }

  if (report.moved.length === 0 && report.blocks.length === 0) {
    process.stdout.write("No behavioral changes.\n");
    return;
  }

  const changedFiles = new Set(options.changedFiles ?? []);
  process.stdout.write(
    `${renderReport(report, changedFiles, {
      budget: options.budget ?? null,
      hops: options.chain ?? CHAIN_HOPS,
    })}\n`,
  );
}

// ---------------------------------------------------------------------------
// Dir command: boundary pair overview
// ---------------------------------------------------------------------------

export function readSummariesFromDir(dir: string): BehavioralSummary[] {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new UsageError(
      `No directory at ${resolved}. Pass the folder holding the summary files you wrote with \`suss extract -o\`.`,
    );
  }

  const files = fs.readdirSync(resolved).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new UsageError(
      `No JSON files in ${resolved}. Write summaries there first with \`suss extract -o ${path.join(dir, "summaries.json")}\`.`,
    );
  }

  const all: BehavioralSummary[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const filePath = path.join(resolved, file);
    const content = fs.readFileSync(filePath, "utf-8");
    try {
      all.push(...parseSummaryFile(filePath, content));
    } catch (error) {
      // A folder of summaries can pick up other JSON, most often a report
      // written back into it. The file is listed as skipped and the rest
      // are still read.
      skipped.push(`${file}: ${messageOf(error)}`);
    }
  }

  if (skipped.length === files.length) {
    throw new UsageError(
      `Nothing in ${resolved} is a summaries file:\n${skipped.map((line) => `  - ${line}`).join("\n")}`,
    );
  }

  if (skipped.length > 0) {
    process.stderr.write(
      `Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} in ${resolved} that ${skipped.length === 1 ? "is not summaries" : "are not summaries"}:\n${skipped.map((line) => `  - ${line}`).join("\n")}\n`,
    );
  }
  return all;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

export function parseSummaryFile(
  filePath: string,
  content: string,
): BehavioralSummary[] {
  let json: unknown;
  try {
    json = JSON.parse(content) as unknown;
  } catch (error) {
    throw new UsageError(
      `${filePath} is not JSON suss can read: ${messageOf(error)}`,
    );
  }
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
  const invokes = invokersOfUnits(summaries);

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

  // An invoke is an effect inside a caller and has no summary of its own,
  // so the pairing above never sees it. The function it invokes still has
  // a client, and pairs with its callers here.
  const invoked = new Set<BehavioralSummary>();
  for (const provider of result.unmatched.providers) {
    const binding = provider.identity.boundaryBinding;
    const key = binding === null ? null : boundaryKey(binding);
    const callers = key === null ? undefined : invokes.byUnit.get(key);
    if (key === null || callers === undefined || callers.length === 0) {
      continue;
    }
    invoked.add(provider);
    pairsByKey.set(key, { providers: [provider], consumers: [...callers] });
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

  const { consumers, unpairable } = result.unmatched;
  const providers = result.unmatched.providers.filter((p) => !invoked.has(p));
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
    // Each boundary with no name gets its own line. Something crosses it,
    // and the reader should know nothing checked it.
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
      // A project has dozens of internal helpers, and most functions have
      // no boundary. Listing each one would bury the lines above, so they
      // are counted.
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

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
