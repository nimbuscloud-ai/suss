/**
 * Which scope a Ruby name belongs to, and every write each scope makes
 * to it.
 *
 * Ruby has no local declarations. Assigning a name anywhere in a method
 * body makes it a local of that method, inside a branch, a loop or a
 * block too, so `query` in two methods is two different names and the
 * facts key them apart. A block parameter belongs to its block.
 *
 * When a name is written more than once, `valueLeftByWrites` in the
 * shared rules decides which value a reader sees. This module supplies
 * the writes in source order and whether the scope's own statements put
 * them in order.
 */

import { writesRunInOrder } from "@suss/resolution";

import {
  bodyStatements,
  enclosingDefinition,
  field,
  LAMBDA_TYPE,
  NodeMap,
  OWN_BODY_TYPES,
} from "../ast.js";

import type { NameReads, OrderedWrite } from "@suss/resolution";
import type { RbNode, RbTree } from "../parser.js";

/** A call's block, which owns the names it declares as parameters. */
const BLOCK_TYPES = new Set(["block", "do_block"]);

/** A block and a definition both open a body that runs later than the statements around it. */
const LATER_BODY_TYPES = new Set([...OWN_BODY_TYPES, ...BLOCK_TYPES]);

/** Ruby spells a name two ways: bare for a local, `@name` for one on the object. */
export const RUBY_NAME_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "instance_variable",
]);

/** The left sides of a multiple assignment that contain more targets. */
const TARGET_LIST_TYPES = new Set([
  "left_assignment_list",
  "destructured_left_assignment",
  "rest_assignment",
]);

/**
 * An operator assignment whose right side is the whole value it writes.
 * `x ||= build` and `x &&= build` write `build` when they run at all;
 * `x += 1` combines the right side with what is already there, and that
 * result is written nowhere.
 */
export const WHOLE_VALUE_OPERATORS: ReadonlySet<string> = new Set([
  "||=",
  "&&=",
]);

/** One write to a name, at the node it happens. */
export interface LocalWrite {
  name: string;
  /** The identifier written to. */
  target: RbNode;
  /** The expression written, or null when the write states no value of its own. */
  value: RbNode | null;
  /** The statement or parameter the write happens at. */
  at: RbNode;
  /** A parameter's value arrives before the body runs, so no statement of the body orders it. */
  fromParameter: boolean;
}

/** Every write to one name in one scope, and whether the scope's own statements order them. */
export interface NameWrites {
  /** The node the name belongs to: a method, a block, or null for the file. */
  owner: RbNode | null;
  name: string;
  writes: LocalWrite[];
  ordered: boolean;
}

/** The identifier a parameter is declared with, `loader:` in `loader: ApplicationLoader` included. */
export function paramNameOf(param: RbNode): RbNode | null {
  return param.type === "identifier" ? param : (field(param, "name") ?? null);
}

export function parametersOf(owner: RbNode): RbNode[] {
  const params = field(owner, "parameters");
  return params === null ? [] : bodyStatements(params);
}

/** The names a method or a block declares as parameters. */
function parameterNames(owner: RbNode): ReadonlySet<string> {
  const names = new Set<string>();
  for (const param of parametersOf(owner)) {
    const name = paramNameOf(param);
    if (name !== null) {
      names.add(name.text);
    }
  }
  return names;
}

/** Every name an assignment's left side writes to. `a, (b, c) = pair` writes three. */
function targetsOf(left: RbNode): RbNode[] {
  if (left.type === "identifier" || left.type === "constant") {
    return [left];
  }
  if (TARGET_LIST_TYPES.has(left.type)) {
    return bodyStatements(left).flatMap(targetsOf);
  }
  return [];
}

function writeOf(
  target: RbNode,
  value: RbNode | null,
  at: RbNode,
  fromParameter: boolean,
): LocalWrite {
  return { name: target.text, target, value, at, fromParameter };
}

type WriteReader = (node: RbNode) => LocalWrite[];

function readAssignment(node: RbNode): LocalWrite[] {
  const left = field(node, "left");
  const right = field(node, "right");
  if (left === null || right === null) {
    return [];
  }
  // `a, b = pair` gives each target a piece of the right side, and the source writes no expression for that piece.
  const value = left.type === "left_assignment_list" ? null : right;
  return targetsOf(left).map((target) => writeOf(target, value, node, false));
}

function readOperatorAssignment(node: RbNode): LocalWrite[] {
  const left = field(node, "left");
  const right = field(node, "right");
  const operator = field(node, "operator");
  if (left === null || right === null || left.type !== "identifier") {
    return [];
  }
  const whole = operator !== null && WHOLE_VALUE_OPERATORS.has(operator.text);
  return [writeOf(left, whole ? right : null, node, false)];
}

/** `for i in list` writes `i` on every pass, and the name outlives the loop. */
function readForVariable(node: RbNode): LocalWrite[] {
  const pattern = field(node, "pattern");
  if (pattern === null) {
    return [];
  }
  return targetsOf(pattern).map((target) => writeOf(target, null, node, false));
}

/** `rescue => e` puts the exception in a name, which outlives the rescue body. */
function readRescueVariable(node: RbNode): LocalWrite[] {
  const variable = field(node, "variable");
  if (variable === null) {
    return [];
  }
  return bodyStatements(variable)
    .flatMap(targetsOf)
    .map((target) => writeOf(target, null, node, false));
}

function readBlockParameters(node: RbNode): LocalWrite[] {
  const found: LocalWrite[] = [];
  for (const param of parametersOf(node)) {
    const name = paramNameOf(param);
    if (name !== null) {
      found.push(writeOf(name, null, param, true));
    }
  }
  return found;
}

const WRITE_READERS: Record<string, WriteReader> = {
  assignment: readAssignment,
  operator_assignment: readOperatorAssignment,
  for: readForVariable,
  rescue: readRescueVariable,
  block: readBlockParameters,
  do_block: readBlockParameters,
};

/** Every write under a body, stopping where a nested definition starts a scope of its own. */
function writesUnder(body: RbNode): LocalWrite[] {
  const found: LocalWrite[] = [];
  const visit = (node: RbNode): void => {
    for (const child of bodyStatements(node)) {
      if (OWN_BODY_TYPES.has(child.type)) {
        continue;
      }
      found.push(...(WRITE_READERS[child.type]?.(child) ?? []));
      visit(child);
    }
  };
  visit(body);
  return found;
}

/** The names one scope has, computed once because every key needs them. */
interface ScopeNames {
  /** Its parameters and every name its body writes to. */
  locals: ReadonlySet<string>;
  /** Every name a block inside it declares as a parameter. */
  blockParams: ReadonlySet<string>;
}

interface TreeCache {
  file: ScopeNames | null;
  byMethod: NodeMap<ScopeNames>;
}

const namesByTree = new WeakMap<RbTree, TreeCache>();

function cacheFor(tree: RbTree): TreeCache {
  const known = namesByTree.get(tree);
  if (known !== undefined) {
    return known;
  }
  const fresh: TreeCache = { file: null, byMethod: new NodeMap<ScopeNames>() };
  namesByTree.set(tree, fresh);
  return fresh;
}

function scopeNames(
  parameters: ReadonlySet<string>,
  body: RbNode | null,
): ScopeNames {
  const locals = new Set<string>(parameters);
  const blockParams = new Set<string>();
  for (const write of body === null ? [] : writesUnder(body)) {
    if (write.fromParameter) {
      blockParams.add(write.name);
      continue;
    }
    locals.add(write.name);
  }
  return { locals, blockParams };
}

/**
 * The names a method owns. A block parameter is kept apart, because the block
 * owns it and Ruby does not let it outlive the block.
 */
function namesOfMethod(method: RbNode): ScopeNames {
  const cache = cacheFor(method.tree);
  const remembered = cache.byMethod.get(method);
  if (remembered !== undefined) {
    return remembered;
  }
  const names = scopeNames(parameterNames(method), field(method, "body"));
  cache.byMethod.set(method, names);
  return names;
}

/** The names a file has outside any definition, which is a scope with no parameters. */
function namesOfFile(tree: RbTree): ScopeNames {
  const cache = cacheFor(tree);
  cache.file ??= scopeNames(new Set(), tree.rootNode);
  return cache.file;
}

/**
 * Every scope a name read here could be a local of, innermost first. A
 * lambda runs inside the scope it is written in and keeps that scope's
 * locals alive, so a name it never declared itself can still be one.
 * Anything else owns its names outright, and the file closes the list.
 */
function scopesAround(enclosing: RbNode | null): (RbNode | null)[] {
  const chain: (RbNode | null)[] = [];
  let current = enclosing;
  while (current !== null && current.type === LAMBDA_TYPE) {
    chain.push(current);
    current = enclosingDefinition(current);
  }
  chain.push(current);
  return chain;
}

const namesOfScope = (scope: RbNode | null, node: RbNode): ScopeNames =>
  scope === null ? namesOfFile(node.tree) : namesOfMethod(scope);

/**
 * The node a name written or read at this point belongs to: the nearest block
 * that declares it as a parameter, else the method whose local it is, else
 * null for the file.
 */
export function ownerOfName(
  node: RbNode,
  name: string,
  enclosing: RbNode | null,
): RbNode | null {
  // Ruby refuses a constant assignment inside a method, so a constant is never a local.
  if (node.type === "constant") {
    return null;
  }
  for (const scope of scopesAround(enclosing)) {
    const names = namesOfScope(scope, node);
    // Walking up the parents allocates a wrapper per step, so the scope's
    // own names rule out every name no block declares before that walk.
    if (names.blockParams.has(name)) {
      const block = blockDeclaring(node, name);
      if (block !== null) {
        return block;
      }
    }
    if (scope !== null && names.locals.has(name)) {
      return scope;
    }
  }
  return null;
}

/**
 * Whether a bare name here is a local. Ruby writes a local read and a
 * call of a method on `self` the same way, so a name that no surrounding
 * scope wrote to is a call.
 */
export function isLocalName(
  node: RbNode,
  name: string,
  enclosing: RbNode | null,
): boolean {
  for (const scope of scopesAround(enclosing)) {
    const names = namesOfScope(scope, node);
    if (names.blockParams.has(name) && blockDeclaring(node, name) !== null) {
      return true;
    }
    if (names.locals.has(name)) {
      return true;
    }
  }
  return false;
}

/** The nearest block around a node that declares the name as a parameter. */
function blockDeclaring(node: RbNode, name: string): RbNode | null {
  let current = node.parent;
  while (current !== null) {
    if (BLOCK_TYPES.has(current.type) && parameterNames(current).has(name)) {
      return current;
    }
    if (OWN_BODY_TYPES.has(current.type)) {
      return null;
    }
    current = current.parent;
  }
  return null;
}

function parameterWrites(method: RbNode | null): LocalWrite[] {
  const found: LocalWrite[] = [];
  for (const param of method === null ? [] : parametersOf(method)) {
    const name = paramNameOf(param);
    if (name !== null) {
      found.push(writeOf(name, name, param, true));
    }
  }
  return found;
}

/**
 * Every name one scope writes, grouped. `method` is the method being walked,
 * or null for the file, and `body` is the statements it runs. A write inside
 * a block the body contains is grouped here too, since the name it writes
 * belongs to the enclosing scope unless the block declares it as a parameter.
 */
export function collectWrites(
  method: RbNode | null,
  body: RbNode,
): NameWrites[] {
  const writes = [...parameterWrites(method), ...writesUnder(body)].sort(
    (left, right) => left.target.startIndex - right.target.startIndex,
  );
  const targetIds = new Set(writes.map((write) => write.target.id));

  const groups = new Map<string, NameWrites>();
  for (const write of writes) {
    const owner = ownerOfName(write.target, write.name, method);
    const key = `${owner === null ? "" : owner.id} ${write.name}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        owner,
        name: write.name,
        writes: [write],
        ordered: false,
      });
      continue;
    }
    group.writes.push(write);
  }

  const rules = nameReads(targetIds);
  for (const group of groups.values()) {
    const scope = group.owner === null ? body : field(group.owner, "body");
    if (scope === null) {
      continue;
    }
    group.ordered = writesRunInOrder(
      scope,
      group.name,
      group.writes.map((write) => orderedWrite(write, scope)),
      rules,
    );
  }
  return [...groups.values()];
}

/**
 * Whether one body's writes to an instance variable run once each, in the
 * order they are written. The writes come from the expression walk instead
 * of from `collectWrites`, so each arrives as the target node it writes to.
 */
export function instanceWritesRunInOrder(
  body: RbNode,
  name: string,
  targets: readonly RbNode[],
): boolean {
  return writesRunInOrder(
    body,
    name,
    targets.map((target) => targetWrite(body, target)),
    nameReads(new Set(targets.map((target) => target.id))),
  );
}

/**
 * The same for one body's writes to a property through a name,
 * `job.retries = 3`, whose reads are calls written the same way.
 */
export function propertyWritesRunInOrder(
  body: RbNode,
  spelling: string,
  targets: readonly RbNode[],
): boolean {
  return writesRunInOrder(
    body,
    spelling,
    targets.map((target) => targetWrite(body, target)),
    {
      ...nameReads(new Set(targets.map((target) => target.id))),
      nameTypes: CALL_TYPES,
    },
  );
}

const CALL_TYPES: ReadonlySet<string> = new Set(["call"]);

/** A write is a statement of the body's own list when its assignment is. */
function targetWrite(body: RbNode, target: RbNode): OrderedWrite<RbNode> {
  return { at: target, direct: target.parent?.parent?.id === body.id };
}

/**
 * A write is a statement of the scope's own list when the scope is its
 * parent. A parameter arrives before the body runs, so no statement of the
 * body orders it.
 */
function orderedWrite(write: LocalWrite, scope: RbNode): OrderedWrite<RbNode> {
  return {
    at: write.at,
    direct: !write.fromParameter && write.at.parent?.id === scope.id,
  };
}

/**
 * What the shared read walk needs to know about Ruby. The targets it has
 * to leave out are the ones this scope writes, so each reading of a scope
 * builds its own.
 */
function nameReads(targetIds: ReadonlySet<number>): NameReads<RbNode> {
  return {
    nameTypes: RUBY_NAME_TYPES,
    laterBodies: LATER_BODY_TYPES,
    childrenOf: bodyStatements,
    isRead: (node) => isNameRead(node, targetIds),
  };
}

function isNameRead(node: RbNode, targetIds: ReadonlySet<number>): boolean {
  if (targetIds.has(node.id)) {
    return false;
  }
  // In `query.where`, `where` is a method called on the receiver, even when a local has that name.
  const parent = node.parent;
  return !(
    parent !== null &&
    parent.type === "call" &&
    field(parent, "method")?.id === node.id &&
    field(parent, "receiver") !== null
  );
}
