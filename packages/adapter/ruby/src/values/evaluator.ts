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

import { nodeOfKey } from "@suss/resolution";
import { Evaluator, force, literalOf } from "@suss/values";

import { field } from "../ast.js";
import {
  resolvedFunctions,
  resolveValues,
  writtenValueOf,
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
const withoutFacts = new WeakMap<object, Evaluator<RbNode>>();

const METHOD_TYPES = new Set(["method", "singleton_method"]);

/** Register the parsed project, so reads through `db` can follow the facts back to nodes. */
export function bindEvaluator(db: Database, nodes: ProjectNodes): void {
  evaluators.set(
    db,
    new Evaluator(
      rubyLowering({ context: contextOver(db, nodes), rows: rubyRows }),
    ),
  );
}

/** The abstract value `node` comes down to, through the facts when `db` was bound. */
export function evaluatedValue(node: RbNode, db?: Database): Value {
  return force(evaluatorFor(node, db).evaluate(node));
}

/** The one string `node` comes down to, or null when it does not settle on one. */
export function stringValueOf(node: RbNode, db?: Database): string | null {
  return literalOf(evaluatedValue(node, db));
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

/** The method a node is written inside, which is what a parameter read is keyed under. */
function enclosingMethod(node: RbNode): RbNode | null {
  let current = node.parent;
  while (current !== null) {
    if (METHOD_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
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
    writtenTo: (node) => {
      const file = fileOf(node);
      if (file === null) {
        return null;
      }
      const answer = writtenValueOf(
        db,
        readKey(file, node, enclosingMethod(node)),
      );
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
          ? readKey(file, method, enclosingMethod(call))
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
