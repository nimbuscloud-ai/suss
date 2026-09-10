/**
 * locals.ts: which scope a Ruby name belongs to, and every write each
 * scope makes to it.
 *
 * Ruby declares no local. Assigning a name anywhere in a method body
 * makes it a local of that method, a branch, a loop and a block
 * included, so `query` in two methods is two different names and the
 * facts have to key them apart. A block parameter is the one name a
 * block owns rather than the method around it.
 *
 * A name written more than once is a question about control flow, and
 * `valueLeftByWrites` decides it. What this supplies is the writes in
 * source order and whether the scope's own statements order them.
 */

import { bodyStatements, field, NodeMap, OWN_BODY_TYPES } from "../ast.js";

import type { RbNode, RbTree } from "../parser.js";

/** A call's block, which owns the names it declares as parameters. */
const BLOCK_TYPES = new Set(["block", "do_block"]);

/** The left sides of a multiple assignment that hold further targets. */
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
const WHOLE_VALUE_OPERATORS = new Set(["||=", "&&="]);

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
export function parameterNames(owner: RbNode): ReadonlySet<string> {
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

const localsByTree = new WeakMap<RbTree, NodeMap<ReadonlySet<string>>>();

function localsCacheFor(tree: RbTree): NodeMap<ReadonlySet<string>> {
  const known = localsByTree.get(tree);
  if (known !== undefined) {
    return known;
  }
  const fresh = new NodeMap<ReadonlySet<string>>();
  localsByTree.set(tree, fresh);
  return fresh;
}

/**
 * The names a method owns: its parameters, and every name its body writes to.
 * A block parameter is left out, because the block owns it and Ruby does not
 * let it outlive the block.
 */
export function localNamesOf(method: RbNode): ReadonlySet<string> {
  const cache = localsCacheFor(method.tree);
  const remembered = cache.get(method);
  if (remembered !== undefined) {
    return remembered;
  }
  const names = new Set<string>(parameterNames(method));
  const body = field(method, "body");
  for (const write of body === null ? [] : writesUnder(body)) {
    if (!write.fromParameter) {
      names.add(write.name);
    }
  }
  cache.set(method, names);
  return names;
}

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
  let current = node.parent;
  while (current !== null) {
    if (BLOCK_TYPES.has(current.type) && parameterNames(current).has(name)) {
      return current;
    }
    if (OWN_BODY_TYPES.has(current.type)) {
      break;
    }
    current = current.parent;
  }
  if (enclosing !== null && localNamesOf(enclosing).has(name)) {
    return enclosing;
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

  for (const group of groups.values()) {
    const scope = group.owner === null ? body : field(group.owner, "body");
    group.ordered = scope !== null && writesRunInOrder(group, scope, targetIds);
  }
  return [...groups.values()];
}

/**
 * Whether the writes run once each, in the order they are written.
 *
 * They do when every one of them is a statement of the scope's own list. That
 * list runs through once, top to bottom: nothing repeats and nothing is
 * skipped. A write inside a branch, a loop, a `begin` or a block runs when
 * something reaches it, and how many times is not a question this reads.
 *
 * The last write also has to be the one every read sees, so a read before it
 * makes the answer depend on where the reader is, which the rules cannot
 * express.
 */
function writesRunInOrder(
  group: NameWrites,
  scope: RbNode,
  targetIds: ReadonlySet<number>,
): boolean {
  const direct = group.writes.every(
    (write) => !write.fromParameter && write.at.parent?.id === scope.id,
  );
  const last = group.writes[group.writes.length - 1];
  if (!direct || last === undefined) {
    return false;
  }
  return !readsBefore(scope, group.name, last.at.startIndex, targetIds);
}

/**
 * Whether anything before `position` reads the name. A read inside a block or
 * a nested definition is not one yet: that body runs when something calls or
 * enters it, which is after the statements around it have finished.
 */
function readsBefore(
  scope: RbNode,
  name: string,
  position: number,
  targetIds: ReadonlySet<number>,
): boolean {
  let found = false;
  const visit = (node: RbNode): void => {
    for (const child of bodyStatements(node)) {
      if (found || child.startIndex >= position) {
        return;
      }
      if (OWN_BODY_TYPES.has(child.type) || BLOCK_TYPES.has(child.type)) {
        continue;
      }
      if (isNameRead(child, name, targetIds)) {
        found = true;
        return;
      }
      visit(child);
    }
  };
  visit(scope);
  return found;
}

function isNameRead(
  node: RbNode,
  name: string,
  targetIds: ReadonlySet<number>,
): boolean {
  if (
    node.type !== "identifier" ||
    node.text !== name ||
    targetIds.has(node.id)
  ) {
    return false;
  }
  // In `query.where`, `where` is a method on the receiver, not the local spelled the same.
  const parent = node.parent;
  return !(
    parent !== null &&
    parent.type === "call" &&
    field(parent, "method")?.id === node.id &&
    field(parent, "receiver") !== null
  );
}
