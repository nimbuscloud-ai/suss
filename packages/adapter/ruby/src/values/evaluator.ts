/**
 * One evaluator per project, over the parsed files and the resolution
 * facts. A reader hands in a node and gets back the abstract value it
 * comes down to; a route path or a prefix is then spelled from that
 * value rather than read off one syntax shape.
 *
 * The facts key a node by file and span, so the evaluator keeps every
 * file's root to find the node a fact refers to. Without facts,
 * which is how a unit test or a routes file on its own runs, the
 * evaluator still follows names within the file through the engine's
 * own scope walk.
 */

import { nodeOfKey, writtenValuesByKey } from "@suss/resolution";
import { Evaluator, force, literalOf, text } from "@suss/values";

import { enclosingDefinition, field, METHOD_TYPES } from "../ast.js";
import {
  constructionSites,
  resolvedFunctions,
  resolveValues,
  writtenValueOf,
  writtenValueUnder,
} from "../facts/resolve.js";
import { nodeId, readKey } from "../facts/values.js";
import { rubyLowering } from "./lowering.js";
import { rubyRows } from "./rows.js";

import type { Database } from "@suss/datalog";
import type { Value } from "@suss/values";
import type { RbNode } from "../parser.js";
import type { EvaluationContext } from "./lowering.js";

export interface EvaluatedFile {
  readonly file: string;
  readonly root: RbNode;
}

export interface ProjectNodes {
  readonly files: readonly EvaluatedFile[];
  /** Every method definition by its node key, for a resolved callee. */
  readonly definitions: ReadonlyMap<string, RbNode>;
}

const evaluators = new WeakMap<Database, Evaluator<RbNode>>();
const contexts = new WeakMap<Database, EvaluationContext>();
const withoutFacts = new WeakMap<object, Evaluator<RbNode>>();
/** The file a parsed tree came from, for a reader that has only a node. */
const filesByTree = new WeakMap<object, string>();

/** Register the parsed project, so reads through `db` can follow the facts back to nodes. */
export function bindEvaluator(db: Database, nodes: ProjectNodes): void {
  for (const entry of nodes.files) {
    filesByTree.set(entry.root.tree, entry.file);
  }
  const context = contextOver(db, nodes);
  contexts.set(db, context);
  evaluators.set(db, new Evaluator(rubyLowering({ context, rows: rubyRows })));
}

/**
 * The one expression `node` was written as, as the node itself, for a
 * reader that needs the arguments of the call behind a name rather than
 * the value the name comes down to. It takes the step the evaluator
 * takes to follow a name, so a database with no project bound to it
 * gives back null. With a site, the expression it was written as when
 * the receiver behind it is the instance that site made.
 */
export function writtenNodeOf(
  node: RbNode,
  db: Database | undefined,
  site?: string,
): RbNode | null {
  const context = db === undefined ? undefined : contexts.get(db);
  return context === undefined ? null : context.writtenTo(node, site);
}

/**
 * Settle what each of these nodes was written as, in one question.
 *
 * The rules run over the whole project's facts either way, so one
 * question about a thousand keys costs about what one question about a
 * single key costs. A reader with many nodes in hand asks here first,
 * and every later read of one of them finds its answer already there.
 */
export function askWrittenValues(
  nodes: readonly RbNode[],
  db: Database | undefined,
): void {
  if (db === undefined || !contexts.has(db)) {
    return;
  }
  const keys = new Set<string>();
  for (const node of nodes) {
    const file = filesByTree.get(node.tree);
    if (file !== undefined) {
      keys.add(readKey(file, node, enclosingDefinition(node)));
    }
  }
  if (keys.size === 0) {
    return;
  }
  const asked = [...keys];
  resolveValues(db, asked);
  // A key the rules settle on a call has to be asked about again, and
  // doing that for the whole batch keeps the second round to one
  // question as well.
  writtenValuesByKey(db, asked, (more) => resolveValues(db, more));
}

/** Strings to read for the parameters of the block or method `node` is written in, the way a caller would supply them. */
export type ParameterBindings = ReadonlyMap<string, string>;

/**
 * The abstract value `node` comes down to, through the facts when `db`
 * was bound. With a site, what it comes down to when the receiver
 * behind it is the instance that site made; that run is not memoized.
 */
export function evaluatedValue(
  node: RbNode,
  db?: Database,
  bindings?: ParameterBindings,
  site?: string,
): Value {
  const evaluator = evaluatorFor(node, db);
  if (bindings === undefined) {
    return force(
      site === undefined
        ? evaluator.evaluate(node)
        : evaluator.evaluate(node, { site }),
    );
  }
  const supplied = new Map(
    [...bindings].map(([name, value]) => [name, text(value)]),
  );
  return force(
    evaluator.evaluate(node, {
      bindings: supplied,
      ...(site === undefined ? {} : { site }),
    }),
  );
}

/**
 * Every construction of the class this node is written inside, as the
 * keys to read a value under. Empty for a node outside a class, or for
 * one whose class nothing in the run constructs.
 */
export function constructionSitesOf(
  node: RbNode,
  db: Database | undefined,
): string[] {
  const cls = enclosingClass(node);
  const file = cls === null ? undefined : filesByTree.get(cls.tree);
  if (db === undefined || cls === null || file === undefined) {
    return [];
  }
  return constructionSites(db, nodeId(file, cls));
}

function enclosingClass(node: RbNode): RbNode | null {
  let current = node.parent;
  while (current !== null) {
    if (current.type === "class") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** The one string `node` comes down to, or null when it does not settle on one. */
export function stringValueOf(
  node: RbNode,
  db?: Database,
  bindings?: ParameterBindings,
): string | null {
  return literalOf(evaluatedValue(node, db, bindings));
}

/** Every method a file defines, keyed the way the facts key it, for `bindEvaluator`. */
export function methodDefinitionsIn(
  file: string,
  root: RbNode,
): Map<string, RbNode> {
  const found = new Map<string, RbNode>();
  const visit = (node: RbNode): void => {
    if (METHOD_TYPES.has(node.type)) {
      found.set(nodeId(file, node), node);
    }
    for (const child of node.namedChildren) {
      if (child !== null) {
        visit(child);
      }
    }
  };
  visit(root);
  return found;
}

function evaluatorFor(
  node: RbNode,
  db: Database | undefined,
): Evaluator<RbNode> {
  const bound = db === undefined ? undefined : evaluators.get(db);
  if (bound !== undefined) {
    return bound;
  }
  const tree = node.tree;
  let local = withoutFacts.get(tree);
  if (local === undefined) {
    local = new Evaluator(rubyLowering({ context: null, rows: rubyRows }));
    withoutFacts.set(tree, local);
  }
  return local;
}

function contextOver(db: Database, nodes: ProjectNodes): EvaluationContext {
  const filesByRoot = new Map<number, EvaluatedFile>();
  const rootsByFile = new Map<string, RbNode>();
  for (const entry of nodes.files) {
    filesByRoot.set(entry.root.id, entry);
    rootsByFile.set(entry.file, entry.root);
  }

  const fileOf = (node: RbNode): string | null =>
    filesByRoot.get(node.tree.rootNode.id)?.file ?? null;

  return {
    writtenTo: (node, site) => {
      const file = fileOf(node);
      if (file === null) {
        return null;
      }
      const key = readKey(file, node, enclosingDefinition(node));
      const answer =
        site === undefined
          ? writtenValueOf(db, key)
          : writtenValueUnder(db, key, site);
      return answer === null ? null : nodeOfKey(rootsByFile, answer);
    },
    callable: (call) => {
      const file = fileOf(call);
      const method = field(call, "method");
      if (file === null || method === null) {
        return null;
      }
      // The facts key a receiverless call by its name and a method call by the method node.
      const key =
        field(call, "receiver") === null
          ? readKey(file, method, enclosingDefinition(call))
          : nodeId(file, method);
      resolveValues(db, [key]);
      const resolved = resolvedFunctions(db, key);
      const settled = resolved.length === 1 ? resolved[0] : undefined;
      return settled === undefined
        ? null
        : (nodes.definitions.get(settled) ?? null);
    },
  };
}
