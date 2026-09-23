/**
 * One evaluator per project, over the parsed files and the resolution
 * facts. A reader passes in a node and gets back the abstract value it
 * evaluates to, so a route path or a prefix is read from that value and
 * any way of writing it reads the same.
 *
 * The facts key a node by file and span, so the evaluator keeps every
 * file's root to find the node a fact refers to. A unit test or a single
 * file runs without facts, and the evaluator then follows names within
 * the file through the engine's own scope walk.
 */

import { nodeOfKey } from "@suss/resolution";
import { Evaluator, force, literalOf } from "@suss/values";

import { enclosingFunction, field } from "../ast.js";
import {
  constructionSites,
  resolveCalls,
  settleWrittenValues,
  writtenValueOf,
  writtenValuesOf,
  writtenValueUnder,
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
 * in whichever file writes it. Null until a project has been bound,
 * because a key leads back to a node only once the run's files are known.
 */
export function writtenNodeOf(
  node: PyNode,
  db: Database | undefined,
): PyNode | null {
  const bound = db === undefined ? undefined : projects.get(db);
  return bound?.context.writtenTo(node) ?? null;
}

/**
 * The key the rules join a read of this expression on, for a caller that
 * has a node and no file path. Null until a project has been bound, and
 * for a node in a file the run did not cover.
 */
export function resolutionKeyOf(
  node: PyNode,
  db: Database | undefined,
): string | null {
  const bound = db === undefined ? undefined : projects.get(db);
  return bound?.keyOf(node) ?? null;
}

/** The call a value was built by, and where that call's callee came from. */
export interface Construction {
  /** The value key of the call. A router index keys its constructions the same way. */
  key: string;
  /** The name the callee's module exports it under, so a caller can tell a router from an app. */
  origin: Origin;
}

/**
 * What the rules say built a value. `severalCalls` is a value written
 * more than one way. It is kept apart from `noCall` so a caller can report
 * the conflict at the site.
 */
export type BuiltValue =
  | { type: "oneCall"; construction: Construction }
  | { type: "severalCalls"; constructions: Construction[] }
  | { type: "noCall" };

const NOTHING_BUILT: BuiltValue = { type: "noCall" };

/**
 * The call the rules say a name was written as, so `app` in
 * `app = FastAPI()` comes from `fastapi`. An answer that is not a call,
 * or whose callee has no known origin, is left out.
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
 * Settles all of these against the rules at once, along with what each
 * was written as, since a reader follows that hop next. Each round of the
 * rules runs over the whole project's facts, so a reader that then asks
 * one node at a time pays for one round instead of one per question.
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
  settleWrittenValues(db, resolutionKeysOf(nodes, bound));
}

/** The keys these nodes are asked about under, without repeats and without the ones no file in the run covers. */
function resolutionKeysOf(
  nodes: readonly PyNode[],
  bound: BoundProject,
): string[] {
  const keys = new Set<string>();
  for (const node of nodes) {
    const key = bound.keyOf(node);
    if (key !== null) {
      keys.add(key);
    }
  }
  return [...keys];
}

/**
 * The abstract value `node` evaluates to, through the facts when `db` was
 * bound. With a site, the value when its receiver is the instance built
 * at that site. An evaluation under a site is not memoized.
 */
export function evaluatedValue(
  node: PyNode,
  db?: Database,
  site?: string,
): Value {
  const evaluator = evaluatorFor(node, db);
  return force(
    site === undefined
      ? evaluator.evaluate(node)
      : evaluator.evaluate(node, { site }),
  );
}

/** The one string `node` evaluates to, or null when it does not settle on one. */
export function stringValueOf(node: PyNode, db?: Database): string | null {
  return literalOf(evaluatedValue(node, db));
}

/**
 * Every construction of the class this node is written inside, as the
 * keys to read a value under. Empty for a node outside a class, or for
 * one whose class nothing in the run constructs.
 */
export function constructionSitesOf(
  node: PyNode,
  db: Database | undefined,
): string[] {
  const cls = enclosingClass(node);
  const bound = db === undefined ? undefined : projects.get(db);
  if (cls === null || db === undefined || bound === undefined) {
    return [];
  }
  const key = bound.keyOf(cls);
  return key === null ? [] : constructionSites(db, key);
}

function enclosingClass(node: PyNode): PyNode | null {
  let current = node.parent;
  while (current !== null) {
    if (current.type === "class_definition") {
      return current;
    }
    current = current.parent;
  }
  return null;
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
    writtenTo: (node, site) => {
      const key = keyOf(node);
      if (key === null) {
        return null;
      }
      const answer =
        site === undefined
          ? writtenValueOf(db, key)
          : writtenValueUnder(db, key, site);
      return answer === null ? null : nodeOfKey(rootsByFile, answer);
    },
    callable: (call) => {
      const callee = field(call, "function");
      const key = callee === null ? null : keyOf(callee);
      if (key === null) {
        return null;
      }
      resolveCalls(db, [key]);
      const resolved = db.lookup("wantedResolves", 0, key);
      const settled =
        resolved.length === 1 ? String(resolved[0]?.[1]) : undefined;
      return settled === undefined
        ? null
        : (nodes.definitions.get(settled) ?? null);
    },
  };

  return { keyOf, roots: rootsByFile, context };
}
