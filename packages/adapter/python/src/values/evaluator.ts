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

import { nodeOfKey } from "@suss/resolution";
import { Evaluator, force, literalOf } from "@suss/values";

import { enclosingFunction, field } from "../ast.js";
import {
  resolveCalls,
  writtenValueOf,
  writtenValuesOf,
} from "../facts/resolve.js";
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
const projects = new WeakMap<Database, BoundProject>();
const withoutFacts = new WeakMap<object, Evaluator<PyNode>>();
const modulesByTree = new WeakMap<object, ModuleBinding>();

/** Register the parsed project, so reads through `db` can follow the facts back to nodes. */
export function bindEvaluator(db: Database, nodes: ProjectNodes): void {
  for (const entry of nodes.files) {
    modulesByTree.set(entry.root.tree, entry.module);
  }
  const bound = projectOver(db, nodes);
  projects.set(db, bound);
  evaluators.set(
    db,
    new Evaluator(
      pythonLowering({
        context: bound.context,
        originOf: calleeOrigin,
        rows: pythonRows,
      }),
    ),
  );
}

/**
 * The single expression the rules say a value was written as, as a node
 * in whichever file writes it. Null until a project has been bound, since
 * a key only leads back to a node once the run has said which files it
 * covers.
 */
export function writtenNodeOf(
  node: PyNode,
  db: Database | undefined,
): PyNode | null {
  const bound = db === undefined ? undefined : projects.get(db);
  return bound?.context.writtenTo(node) ?? null;
}

/** The call a value was built by, and where that call's callee came from. */
export interface Construction {
  /** The value key of the call, which is the key a router index keys its constructions by. */
  key: string;
  /** The name the callee's module exports it under, so a caller can tell a router from an app. */
  origin: Origin;
}

/**
 * What the rules say built a value. `severalCalls` is a value written
 * more than one way, which a caller says something about at the site
 * rather than reading as the same nothing as `noCall`.
 */
export type BuiltValue =
  | { type: "oneCall"; construction: Construction }
  | { type: "severalCalls"; constructions: Construction[] }
  | { type: "noCall" };

const NOTHING_BUILT: BuiltValue = { type: "noCall" };

/**
 * The call the rules say a name was written as, so `app` in
 * `app = FastAPI()` comes from `fastapi`. An answer that is not a call,
 * or whose callee came out of nowhere, is left out.
 */
export function constructionBehind(
  node: PyNode,
  db: Database | undefined,
): BuiltValue {
  if (db === undefined) {
    return NOTHING_BUILT;
  }
  const bound = projects.get(db);
  const key = bound?.keyOf(node);
  if (bound === undefined || key === null || key === undefined) {
    return NOTHING_BUILT;
  }

  const built = writtenValuesOf(db, key)
    .map((answer) => constructionAt(answer, bound.roots))
    .filter((candidate): candidate is Construction => candidate !== null);
  if (built.length === 0) {
    return NOTHING_BUILT;
  }
  const only = built[0];
  return built.length === 1 && only !== undefined
    ? { type: "oneCall", construction: only }
    : { type: "severalCalls", constructions: built };
}

/** The construction one answer describes, or null when the answer is not a call out of some module. */
function constructionAt(
  answer: string,
  roots: ReadonlyMap<string, PyNode>,
): Construction | null {
  const written = nodeOfKey(roots, answer);
  if (written === null || written.type !== "call") {
    return null;
  }
  const callee = field(written, "function");
  const origin = callee === null ? null : calleeOrigin(callee);
  return origin === null ? null : { key: answer, origin };
}

/**
 * Ask the rules about all of these at once. The rules run over the whole
 * project's facts, so a reader that then asks one at a time runs them
 * once rather than once per question.
 */
export function askWrittenValues(
  nodes: readonly PyNode[],
  db: Database | undefined,
): void {
  if (db === undefined) {
    return;
  }
  const bound = projects.get(db);
  if (bound === undefined) {
    return;
  }
  const keys = nodes
    .map((node) => bound.keyOf(node))
    .filter((key): key is string => key !== null);
  resolveCalls(db, keys);
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
export function moduleOf(node: PyNode): ModuleBinding {
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

/** The project a database was bound to, so a reader can go from a node to a key and back. */
interface BoundProject {
  /** The key the rules join a read of this expression on, or null for a file the run did not cover. */
  keyOf: (node: PyNode) => string | null;
  roots: ReadonlyMap<string, PyNode>;
  context: EvaluationContext;
}

function projectOver(db: Database, nodes: ProjectNodes): BoundProject {
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

  const context: EvaluationContext = {
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

  return { keyOf, roots: rootsByFile, context };
}
