/**
 * One evaluator per project, over the parsed files and the resolution
 * facts. A reader hands in a node and gets back the abstract value it
 * comes down to; a route path or a prefix is then spelled from that
 * value rather than read off one syntax shape.
 *
 * The facts key a node by file and span, so the evaluator keeps every
 * file's root to find the node a fact refers to. Without facts,
 * which is how a unit test or a single file runs, the evaluator still
 * follows names within the file through the engine's own scope walk.
 */

import { Evaluator, force, literalOf } from "@suss/values";

import { enclosingFunction, field } from "../ast.js";
import { resolveCalls, writtenValueOf } from "../facts/resolve.js";
import { readKey } from "../facts/values.js";
import { bindModule } from "../scope.js";
import { pythonLowering } from "./lowering.js";
import { originOf } from "./origin.js";
import { pythonRows } from "./rows.js";

import type { Database } from "@suss/datalog";
import type { Origin, Value } from "@suss/values";
import type { PyNode } from "../parser.js";
import type { ModuleBinding } from "../scope.js";
import type { EvaluationContext } from "./lowering.js";

export interface EvaluatedFile {
  readonly file: string;
  readonly root: PyNode;
  readonly module: ModuleBinding;
}

export interface ProjectNodes {
  readonly files: readonly EvaluatedFile[];
  /** Every function definition by its node key, for a resolved callee. */
  readonly definitions: ReadonlyMap<string, PyNode>;
}

const evaluators = new WeakMap<Database, Evaluator<PyNode>>();
const withoutFacts = new WeakMap<object, Evaluator<PyNode>>();
const modulesByTree = new WeakMap<object, ModuleBinding>();

/** Register the parsed project, so reads through `db` can follow the facts back to nodes. */
export function bindEvaluator(db: Database, nodes: ProjectNodes): void {
  for (const entry of nodes.files) {
    modulesByTree.set(entry.root.tree, entry.module);
  }
  evaluators.set(
    db,
    new Evaluator(
      pythonLowering({
        context: contextOver(db, nodes),
        originOf: calleeOrigin,
        rows: pythonRows,
      }),
    ),
  );
}

/** The abstract value `node` comes down to, through the facts when `db` was bound. */
export function evaluatedValue(node: PyNode, db?: Database): Value {
  return force(evaluatorFor(node, db).evaluate(node));
}

/** The one string `node` comes down to, or null when it does not settle on one. */
export function stringValueOf(node: PyNode, db?: Database): string | null {
  return literalOf(evaluatedValue(node, db));
}

function evaluatorFor(
  node: PyNode,
  db: Database | undefined,
): Evaluator<PyNode> {
  const bound = db === undefined ? undefined : evaluators.get(db);
  if (bound !== undefined) {
    return bound;
  }
  const tree = node.tree;
  let local = withoutFacts.get(tree);
  if (local === undefined) {
    local = new Evaluator(
      pythonLowering({
        context: null,
        originOf: calleeOrigin,
        rows: pythonRows,
      }),
    );
    withoutFacts.set(tree, local);
  }
  return local;
}

/** The scope binding of the file a node is in, built once per tree when the project did not supply it. */
function moduleOf(node: PyNode): ModuleBinding {
  const tree = node.tree;
  let module = modulesByTree.get(tree);
  if (module === undefined) {
    module = bindModule(tree.rootNode);
    modulesByTree.set(tree, module);
  }
  return module;
}

function calleeOrigin(callee: PyNode): Origin | null {
  return originOf(callee, moduleOf(callee));
}

function contextOver(db: Database, nodes: ProjectNodes): EvaluationContext {
  const filesByRoot = new Map<number, EvaluatedFile>();
  const rootsByFile = new Map<string, PyNode>();
  for (const entry of nodes.files) {
    filesByRoot.set(entry.root.id, entry);
    rootsByFile.set(entry.file, entry.root);
  }

  const keyOf = (node: PyNode): string | null => {
    const entry = filesByRoot.get(node.tree.rootNode.id);
    if (entry === undefined) {
      return null;
    }
    return readKey(entry.file, node, enclosingFunction(node));
  };

  return {
    writtenTo: (node) => {
      const key = keyOf(node);
      if (key === null) {
        return null;
      }
      const answer = writtenValueOf(db, key);
      return answer === null ? null : nodeOfKey(rootsByFile, answer);
    },
    callable: (call) => {
      const callee = field(call, "function");
      const key = callee === null ? null : keyOf(callee);
      if (key === null) {
        return null;
      }
      resolveCalls(db, [key]);
      const resolved = db
        .facts("wantedResolves")
        .filter((row) => String(row[0]) === key)
        .map((row) => String(row[1]));
      const settled = resolved.length === 1 ? resolved[0] : undefined;
      return settled === undefined
        ? null
        : (nodes.definitions.get(settled) ?? null);
    },
  };
}

/**
 * The node a fact key refers to. A key is the file and the span, so
 * the smallest node over the span is found and walked up to the one
 * whose span matches; a key that is not a node, such as a name, has none.
 */
function nodeOfKey(
  rootsByFile: ReadonlyMap<string, PyNode>,
  key: string,
): PyNode | null {
  const span = key.match(/^(.*):(\d+)-(\d+)$/);
  if (span === null) {
    return null;
  }
  const root = rootsByFile.get(span[1] as string);
  const start = Number(span[2]);
  const end = Number(span[3]);
  if (root === undefined || end <= start) {
    return null;
  }
  let current: PyNode | null = root.descendantForIndex(start, end - 1);
  while (current !== null) {
    if (current.startIndex === start && current.endIndex === end) {
      return current;
    }
    if (current.startIndex < start || current.endIndex > end) {
      return null;
    }
    current = current.parent;
  }
  return null;
}
