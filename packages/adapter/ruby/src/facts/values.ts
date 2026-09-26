/**
 * Emits the value facts that the rules in `@suss/resolution` join, for a
 * Ruby file. The relations and their columns are defined by that package.
 * The package DESIGN.md describes where Ruby differs from the other
 * adapters: names keyed on their scope, a bare name that runs a method,
 * mixins recorded as `extends`, and instance variables as class properties.
 */

import { startsAtName, valueLeftByWrites } from "@suss/resolution";

import {
  bareCallArgumentGroups,
  bodyStatementsRun,
  field,
  INCLUDE_CALL,
  LAMBDA_TYPE,
  METHOD_TYPES,
  NESTING_TYPES,
  NO_BODY_BLOCKS,
  OWN_BODY_TYPES,
  PREPEND_CALL,
  readCallArgs,
} from "../ast.js";
import { spellsAName } from "../paths/bareCalls.js";
import {
  collectWrites,
  instanceWritesRunInOrder,
  isLocalName,
  ownerOfName,
  parametersOf,
  paramNameOf,
  RUBY_NAME_TYPES,
  WHOLE_VALUE_OPERATORS,
} from "./locals.js";

import type { Database } from "@suss/datalog";
import type { ChainReads, NameWrite } from "@suss/resolution";
import type { BodyBlocks } from "../ast.js";
import type { RbNode } from "../parser.js";
import type { LocalWrite, NameWrites } from "./locals.js";

/**
 * A node's key across the whole run. It includes the end offset because a
 * call and its receiver start at the same offset.
 */
export function nodeId(filePath: string, node: RbNode): string {
  return `${filePath}:${node.startIndex}-${node.endIndex}`;
}

function nameId(filePath: string, name: string): string {
  return `${filePath}#${name}`;
}

/**
 * Parentheses do not change a value, so every key looks through a pair
 * of parentheses around one expression. Parentheses around several
 * statements act like a `begin` block and evaluate to the last one, so
 * they keep their own key.
 */
function readThrough(node: RbNode): RbNode {
  if (node.type !== "parenthesized_statements") {
    return node;
  }
  const inner = node.namedChildren.filter((child) => child !== null);
  return inner.length === 1 ? readThrough(inner[0] as RbNode) : node;
}

/**
 * A bare name is keyed on the scope that owns it, so `query` in one method
 * and `query` in the next are different names. `enclosing` is the method
 * the name is written in, or null outside one.
 */
function nameKey(
  filePath: string,
  node: RbNode,
  enclosing: RbNode | null,
): string {
  const owner = ownerOfName(node, node.text, enclosing);
  return owner === null
    ? nameId(filePath, node.text)
    : `${nodeId(filePath, owner)}#${node.text}`;
}

/**
 * The key to ask the rules about when reading this expression. `enclosing`
 * is the method the expression is written in, or null outside one.
 *
 * Two kinds of name are keyed on their node instead of on the name. The
 * tree has no node for the `receiver.method` part of a call, so the
 * callee is keyed on the method name's node. A bare name that Ruby runs
 * as a method is the call itself.
 */
export function readKey(
  filePath: string,
  written: RbNode,
  enclosing: RbNode | null,
): string {
  const node = readThrough(written);
  if (node.type !== "identifier" && node.type !== "constant") {
    return nodeId(filePath, node);
  }
  if (isMethodOfReceiver(node) || isBareCall(node, enclosing)) {
    return nodeId(filePath, node);
  }
  return nameKey(filePath, node, enclosing);
}

/** Whether this name is the method of a `receiver.method` call. */
function isMethodOfReceiver(node: RbNode): boolean {
  const parent = node.parent;
  return (
    parent !== null &&
    parent.type === "call" &&
    field(parent, "method")?.id === node.id &&
    field(parent, "receiver") !== null
  );
}

/** Whether this name is the receiver of a `name.method` call. */
function isReceiverOfCall(node: RbNode): boolean {
  const parent = node.parent;
  return (
    parent !== null &&
    parent.type === "call" &&
    field(parent, "receiver")?.id === node.id
  );
}

/**
 * Whether Ruby runs this name as a method on `self`, because no local in
 * scope binds it. A receiver counts too: in `connection.get(url)`, where
 * `connection` is a method, the receiver is a call.
 */
function isBareCall(node: RbNode, enclosing: RbNode | null): boolean {
  if (node.type !== "identifier") {
    return false;
  }
  if (spellsAName(node) && !isReceiverOfCall(node)) {
    return false;
  }
  return !isLocalName(node, node.text, enclosing);
}

const WRITTEN_VALUE_TYPES = new Set([
  "string",
  "integer",
  "float",
  "true",
  "false",
  "nil",
  "simple_symbol",
  "hash_key_symbol",
  "bare_string",
  "bare_symbol",
  // Built from other expressions. A chain stops here, and the evaluator
  // reads the expression in the scope it is written in. `a || b` is the
  // exception, stated as the branches it picks between.
  "chained_string",
  "binary",
  "unary",
  "conditional",
  "element_reference",
  "parenthesized_statements",
]);

/** `%w[a b]` and `%i[a b]` are arrays whose elements are bare words. */
const ARRAY_TYPES = new Set(["array", "string_array", "symbol_array"]);

/** tree-sitter types a named child as nullable, so the nulls are dropped once here. */
function children(node: RbNode): RbNode[] {
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

interface Emitter {
  db: Database;
  filePath: string;
  /**
   * The method whose body is being walked. Its parameters and locals are
   * keyed under it, because two methods in one file can each assign a
   * `loader` with a different value.
   */
  enclosing: RbNode | null;
  /** The key of the class or module `self` refers to here, or null outside one. */
  selfKey: string | null;
  /** Whether the body being walked runs with a receiver, so a call in it has one too. */
  insideMethod: boolean;
  /**
   * Every value the body being walked assigns to each instance variable.
   * Each method gets its own map, so the facts say which method stored
   * which value, and a class body's own statements get one more.
   */
  instanceWrites: Map<string, InstanceWrite[]> | null;
  /** The calls whose block the run's packs declare runs as part of the surrounding body. */
  bodyBlocks: BodyBlocks;
}

function add(emitter: Emitter, relation: string, ...tuple: string[]): void {
  emitter.db.add(relation, tuple);
}

function valueKey(emitter: Emitter, written: RbNode): string {
  return readKey(emitter.filePath, written, emitter.enclosing);
}

/** A pair's key as text when it is written as a symbol or a string, or null otherwise. */
function pairKeyText(key: RbNode): string | null {
  if (key.type === "hash_key_symbol") {
    return key.text;
  }
  if (key.type === "simple_symbol") {
    return key.text.slice(1);
  }
  if (key.type === "string") {
    return key.text.slice(1, -1);
  }
  return null;
}

/**
 * The key of the method an expression runs, or null when it runs none.
 * For `receiver.method` the key is on the method name's node. A bare name
 * that Ruby runs is keyed as a name in its scope.
 */
export function calleeKeyOf(
  filePath: string,
  node: RbNode,
  enclosing: RbNode | null,
): string | null {
  if (isBareCall(node, enclosing)) {
    return nameKey(filePath, node, enclosing);
  }
  const method = node.type === "call" ? field(node, "method") : null;
  if (method === null) {
    return null;
  }
  // A bare callee is keyed as a name so it resolves to the method in
  // scope. Keyed on its node, it would find a top-level method instead.
  return field(node, "receiver") === null
    ? nameKey(filePath, method, enclosing)
    : nodeId(filePath, method);
}

/**
 * The key of the value a call invokes directly, as in `f.call(x)` or
 * `f.(x)`, or null for an ordinary method call. Ask about this key as
 * well as `calleeKeyOf`, since either one can turn out to be the function.
 */
export function invokedKeyOf(
  filePath: string,
  node: RbNode,
  enclosing: RbNode | null,
): string | null {
  const invoked = invokedValueOf(node);
  return invoked === null ? null : readKey(filePath, invoked, enclosing);
}

/**
 * Every key `call` gives this call's callee: the value `f.call(x)` runs
 * and the method the call sends. `bodyCalls` states the same keys, since
 * the rules take the two for the same value.
 */
function calleeKeysOf(
  filePath: string,
  call: RbNode,
  enclosing: RbNode | null,
): string[] {
  return [
    invokedKeyOf(filePath, call, enclosing),
    calleeKeyOf(filePath, call, enclosing),
  ].filter((key): key is string => key !== null);
}

function emitCall(emitter: Emitter, call: RbNode): void {
  const callKey = nodeId(emitter.filePath, call);
  // A name bound to a call stops its chain at the call, and `isWrittenAs`
  // reads the call's source back.
  add(emitter, "writtenValue", callKey);

  const invoked = invokedValueOf(call);
  if (invoked !== null) {
    // `f.call(x)` and `f.(x)` run whatever the receiver evaluates to, so
    // the callee is that value, not a method named `call`.
    add(emitter, "call", callKey, valueKey(emitter, invoked));
  }
  if (!emitMessageSent(emitter, call, callKey) && invoked === null) {
    return;
  }
  emitCallArguments(emitter, call, callKey);
}

/**
 * Emits the callee of a method call and the receiver it is looked up on.
 * Returns false for a call with no method name, which is `f.(x)`.
 */
function emitMessageSent(
  emitter: Emitter,
  call: RbNode,
  callKey: string,
): boolean {
  // For a bare name Ruby runs, the identifier is both the call and its method name.
  const method = call.type === "identifier" ? call : field(call, "method");
  const calleeKey = calleeKeyOf(emitter.filePath, call, emitter.enclosing);
  if (method === null || calleeKey === null) {
    return false;
  }
  add(emitter, "call", callKey, calleeKey);
  if (!emitter.insideMethod) {
    add(emitter, "callOutsideMethod", callKey);
  }

  const receiver = field(call, "receiver");
  if (receiver !== null) {
    add(
      emitter,
      "readsProperty",
      calleeKey,
      valueKey(emitter, receiver),
      method.text,
    );
  } else if (emitter.selfKey !== null) {
    // Ruby looks up a call with no receiver on `self`, so inside a class
    // it finds a method that class declares.
    add(emitter, "readsProperty", calleeKey, emitter.selfKey, method.text);
  }
  return true;
}

/** The method that runs a proc, `f.call(x)`. */
const INVOKE_METHOD = "call";

/**
 * The receiver of `f.(x)` or `f.call(x)`, both of which run the receiver
 * itself, or null for any other call.
 */
function invokedValueOf(call: RbNode): RbNode | null {
  if (call.type !== "call") {
    return null;
  }
  const receiver = field(call, "receiver");
  if (receiver === null) {
    return null;
  }
  const method = field(call, "method");
  return method === null || method.text === INVOKE_METHOD ? receiver : null;
}

function emitCallArguments(
  emitter: Emitter,
  call: RbNode,
  callKey: string,
): void {
  const args = field(call, "arguments");
  let position = 0;
  for (const argument of args === null ? [] : children(args)) {
    if (argument.type === "pair") {
      const key = field(argument, "key");
      const value = field(argument, "value");
      const keyText = key === null ? null : pairKeyText(key);
      if (keyText !== null && value !== null) {
        add(
          emitter,
          "callKeywordArg",
          callKey,
          keyText,
          valueKey(emitter, value),
        );
      }
      continue;
    }
    add(
      emitter,
      "callArg",
      callKey,
      String(position),
      valueKey(emitter, argument),
    );
    position += 1;
  }
}

/** Records an array's elements under their positions, as the other adapters do. */
function emitArray(emitter: Emitter, array: RbNode): void {
  const objectKey = nodeId(emitter.filePath, array);
  add(emitter, "objectValue", objectKey);
  let position = 0;
  for (const element of children(array)) {
    add(
      emitter,
      "holdsProperty",
      objectKey,
      String(position),
      valueKey(emitter, element),
    );
    position += 1;
  }
}

/** Records a hash's values under their keys, when a key is written as a symbol or string. */
function emitHash(emitter: Emitter, hash: RbNode): void {
  const objectKey = nodeId(emitter.filePath, hash);
  add(emitter, "objectValue", objectKey);
  for (const pair of children(hash)) {
    if (pair.type !== "pair") {
      continue;
    }
    const key = field(pair, "key");
    const value = field(pair, "value");
    const keyText = key === null ? null : pairKeyText(key);
    if (keyText === null || value === null) {
      continue;
    }
    add(emitter, "holdsProperty", objectKey, keyText, valueKey(emitter, value));
  }
}

/** The two ways to write a block, `{ }` and `do ... end`. */
const BLOCK_TYPES = new Set(["block", "do_block"]);

/**
 * Iteration methods whose block runs once per element, with the element
 * bound to the first parameter and, for `each_with_index`, the position
 * bound to the second. They come from `Enumerable`, so the adapter
 * recognizes them without a pack, as it does `ENV`.
 */
const LOOP_METHODS = new Set(["each", "each_with_index", "map"]);

/** Ruby's call for defining a method at run time. Its first argument is the method's name. */
const DEFINE_METHOD_CALL = "define_method";

/** The names one iteration of a loop block binds, and the collection it iterates over. */
interface LoopTurn {
  readonly element: string;
  /** The name bound to the position, or the empty string for a block with one parameter. */
  readonly index: string;
  readonly overKey: string;
}

/** What a loop block binds on each iteration, or null when the block does not belong to a loop call. */
function loopTurnAt(emitter: Emitter, block: RbNode): LoopTurn | null {
  const call = block.parent;
  if (call?.type !== "call") {
    return null;
  }
  const receiver = field(call, "receiver");
  const method = field(call, "method");
  if (receiver === null || method === null || !LOOP_METHODS.has(method.text)) {
    return null;
  }
  const parameters = field(block, "parameters");
  const names =
    parameters === null ? [] : children(parameters).map((p) => p.text);
  const element = names[0];
  if (element === undefined) {
    return null;
  }
  // Keyed on the receiver's node so the evaluator settles what the loop
  // iterates over, from these same facts.
  return {
    element,
    index: names[1] ?? "",
    overKey: nodeId(emitter.filePath, receiver),
  };
}

/**
 * Records a `define_method` call in a class body. The method's name is
 * whatever the argument evaluates to. The value evaluator works that out
 * later from these same facts, so this does not read the argument.
 */
function emitDynamicDefinition(
  emitter: Emitter,
  call: RbNode,
  turns: readonly LoopTurn[],
): void {
  if (
    emitter.selfKey === null ||
    // A call inside a method runs when the method runs, not when the class loads.
    emitter.enclosing !== null ||
    call.type !== "call" ||
    field(call, "receiver") !== null ||
    field(call, "method")?.text !== DEFINE_METHOD_CALL
  ) {
    return;
  }
  const args = field(call, "arguments");
  const first = args === null ? undefined : children(args)[0];
  // With no argument, the call's own key is used as the name, which settles on nothing.
  const nameKey = nodeId(emitter.filePath, first ?? call);
  add(emitter, "definesMethodFrom", emitter.selfKey, nameKey);
  for (const turn of turns) {
    add(
      emitter,
      "nameTurnsOn",
      nameKey,
      turn.element,
      turn.index,
      turn.overKey,
    );
  }
}

/** Visits every expression under a node, stopping at nested definitions. `turns` lists the loop blocks around the expression, outermost first. */
function walkExpressions(
  node: RbNode,
  emitter: Emitter,
  visit: (child: RbNode, turns: readonly LoopTurn[]) => void,
  turns: readonly LoopTurn[] = [],
): void {
  for (const child of children(node)) {
    if (OWN_BODY_TYPES.has(child.type)) {
      continue;
    }
    visit(child, turns);
    const opened = BLOCK_TYPES.has(child.type)
      ? loopTurnAt(emitter, child)
      : null;
    walkExpressions(
      child,
      emitter,
      visit,
      opened === null ? turns : [...turns, opened],
    );
  }
}

/** Keys written as literals. A read with one of these is a property read, which `readsProperty` covers. */
const WRITTEN_KEY_TYPES = new Set([
  "string",
  "integer",
  "simple_symbol",
  "bare_string",
  "bare_symbol",
]);

/**
 * Records `settings[name]` and `settings.fetch(name)` as a read of the
 * container under a computed key. This records every container. The
 * rules decide which containers are the environment.
 */
function emitKeyedRead(
  emitter: Emitter,
  site: RbNode,
  container: RbNode,
  key: RbNode,
): void {
  if (WRITTEN_KEY_TYPES.has(key.type)) {
    return;
  }
  add(
    emitter,
    "readsKeyed",
    nodeId(emitter.filePath, site),
    valueKey(emitter, container),
    valueKey(emitter, key),
  );
}

function emitKeyedElement(emitter: Emitter, node: RbNode): void {
  const object = field(node, "object");
  if (object === null || isWriteTarget(node)) {
    return;
  }
  const index = node.namedChildren.find(
    (child): child is RbNode => child !== null && child.id !== object.id,
  );
  if (index !== undefined) {
    emitKeyedRead(emitter, node, object, index);
  }
}

function emitKeyedFetch(emitter: Emitter, call: RbNode): void {
  const receiver = field(call, "receiver");
  if (receiver === null || field(call, "method")?.text !== "fetch") {
    return;
  }
  const { positional } = readCallArgs(field(call, "arguments"));
  const key = positional[0];
  if (key !== undefined) {
    emitKeyedRead(emitter, call, receiver, key);
  }
}

/** The operators whose value is whichever side they pick. */
const FALLBACK_OPERATORS = new Set(["||", "or"]);

/**
 * The two sides of `a || b` or `a or b`, whose value is one of them, or
 * null for any other expression. `x ||= y` needs nothing here, since the
 * write it makes is already recorded as a write of `y`.
 */
function fallbackBranchesOf(node: RbNode): RbNode[] | null {
  if (
    node.type !== "binary" ||
    !FALLBACK_OPERATORS.has(field(node, "operator")?.text ?? "")
  ) {
    return null;
  }
  const left = field(node, "left");
  const right = field(node, "right");
  /* v8 ignore start */
  if (left === null || right === null) {
    return null;
  }
  /* v8 ignore stop */
  return [left, right];
}

function emitExpressionFacts(emitter: Emitter, node: RbNode): void {
  // The walk below starts at the children, so a statement that is itself
  // a `define_method` call is checked here.
  emitDynamicDefinition(emitter, node, []);
  walkExpressions(node, emitter, (child, turns) => {
    emitDynamicDefinition(emitter, child, turns);
    if (child.type === "call" || isBareCall(child, emitter.enclosing)) {
      emitCall(emitter, child);
      emitKeyedFetch(emitter, child);
    }
    if (child.type === "element_reference") {
      emitKeyedElement(emitter, child);
    }
    if (ARRAY_TYPES.has(child.type)) {
      emitArray(emitter, child);
    }
    if (child.type === "hash") {
      emitHash(emitter, child);
    }
    const branches = fallbackBranchesOf(child);
    if (branches !== null) {
      for (const branch of branches) {
        add(
          emitter,
          "fallbackBranch",
          nodeId(emitter.filePath, child),
          valueKey(emitter, branch),
        );
      }
    } else if (WRITTEN_VALUE_TYPES.has(child.type)) {
      add(emitter, "writtenValue", nodeId(emitter.filePath, child));
    }
    if (child.type === "nil") {
      add(emitter, "placeholderValue", nodeId(emitter.filePath, child));
    }
    // A builder method that returns `self` returns an instance of its own
    // class, so the next call in a chain runs a method that class declares.
    if (child.type === "self" && emitter.selfKey !== null) {
      add(emitter, "binds", nodeId(emitter.filePath, child), emitter.selfKey);
    }
    if (child.type === "instance_variable") {
      emitInstanceRead(emitter, child);
    }
    if (ASSIGNMENT_TYPES.has(child.type)) {
      collectInstanceWrite(emitter, child);
    }
  });
}

const ASSIGNMENT_TYPES = new Set(["assignment", "operator_assignment"]);

/** Whether this node is the left side of an assignment. */
function isWriteTarget(node: RbNode): boolean {
  const parent = node.parent;
  return (
    parent !== null &&
    ASSIGNMENT_TYPES.has(parent.type) &&
    field(parent, "left")?.id === node.id
  );
}

/**
 * An instance variable belongs to the object, so a read of one is
 * recorded as a property read off the class. `contains` already walks
 * `extends`, so a write in a base class reaches a read in a subclass.
 */
function emitInstanceRead(emitter: Emitter, node: RbNode): void {
  if (emitter.selfKey === null || isWriteTarget(node)) {
    return;
  }
  add(
    emitter,
    "readsProperty",
    nodeId(emitter.filePath, node),
    emitter.selfKey,
    node.text,
  );
}

/** One write to `@name`, with the target node used to order it against the others. */
interface InstanceWrite {
  write: NameWrite;
  target: RbNode;
}

function collectInstanceWrite(emitter: Emitter, node: RbNode): void {
  const left = field(node, "left");
  const right = field(node, "right");
  const collector = emitter.instanceWrites;
  if (left === null || right === null || collector === null) {
    return;
  }
  if (left.type !== "instance_variable") {
    return;
  }
  // `count += 1` writes a value the source never states, so the write
  // has no value key.
  const operator = field(node, "operator")?.text;
  const value =
    node.type === "assignment" || WHOLE_VALUE_OPERATORS.has(operator ?? "")
      ? right
      : null;
  const written = collector.get(left.text) ?? [];
  written.push({
    write: describeWrite(emitter, {
      name: left.text,
      target: left,
      value,
      at: node,
      fromParameter: false,
    }),
    target: left,
  });
  collector.set(left.text, written);
}

/**
 * The values one instance variable can end up with. When the writes run
 * in order, the last one wins. When a branch or a loop decides which write
 * runs, every write's value is kept, so a reader that needs one answer
 * sees more than one source.
 */
function settledWrites(
  writes: readonly InstanceWrite[],
  ordered: boolean,
): string[] {
  const described = writes.map((written) => written.write);
  const settled = valueLeftByWrites(described, ordered);
  if (settled !== null) {
    return [settled];
  }
  const left: string[] = [];
  for (const write of described) {
    if (write.value !== null && !write.narrowsName) {
      left.push(write.value);
    }
  }
  return left;
}

/** Records the instance variables that a class body's own statements assign, outside any method. */
function emitInstanceWrites(
  emitter: Emitter,
  classKey: string,
  collected: ReadonlyMap<string, InstanceWrite[]>,
): void {
  for (const [name, writes] of collected) {
    for (const value of settledWrites(writes, false)) {
      add(emitter, "holdsProperty", classKey, name, value);
    }
  }
}

/**
 * Records what one method's body stores in each instance variable. The
 * rules then attach it to the class. A write like
 * `@thing = @thing.where(a: 1)` is skipped, because its result depends on
 * a value another method assigned.
 */
function emitInstanceStores(
  emitter: Emitter,
  funcKey: string,
  body: RbNode,
  collected: ReadonlyMap<string, InstanceWrite[]>,
): void {
  for (const [name, writes] of collected) {
    const deciding = writes.filter((written) => !written.write.narrowsName);
    if (deciding.length === 0) {
      continue;
    }
    const ordered = instanceWritesRunInOrder(
      body,
      name,
      deciding.map((written) => written.target),
    );
    for (const value of settledWrites(deciding, ordered)) {
      add(emitter, "storesProperty", funcKey, name, value);
    }
  }
}

/** The last expression of a body, which Ruby returns when the body ends without a `return`. */
function implicitReturn(body: RbNode): RbNode | null {
  const statements = children(body).filter(
    (child) => child.type !== "rescue" && child.type !== "ensure",
  );
  const last = statements[statements.length - 1];
  if (last === undefined || last.type === "return") {
    return null;
  }
  return assignedValueOf(last) ?? last;
}

/**
 * The right side of an assignment, since an assignment evaluates to the
 * value it wrote. A method whose last line is `@filters ||= %i[...]`
 * returns that list.
 */
function assignedValueOf(node: RbNode): RbNode | null {
  if (!ASSIGNMENT_TYPES.has(node.type)) {
    return null;
  }
  const operator = field(node, "operator")?.text;
  if (
    node.type !== "assignment" &&
    !WHOLE_VALUE_OPERATORS.has(operator ?? "")
  ) {
    return null;
  }
  return field(node, "right");
}

/**
 * A lambda can be assigned to a name and called later, so it gets the
 * same facts as a method. Emitting a lambda walks its body, so this walk
 * stops at each definition.
 */
function emitLambdasIn(emitter: Emitter, body: RbNode): void {
  for (const child of children(body)) {
    if (child.type === LAMBDA_TYPE) {
      emitMethodFacts(emitter, child);
      continue;
    }
    if (OWN_BODY_TYPES.has(child.type)) {
      continue;
    }
    emitLambdasIn(emitter, child);
  }
}

/** A lambda's statements are inside a block, one level deeper than a method's. */
function definitionBody(definition: RbNode): RbNode | null {
  const body = field(definition, "body");
  if (body === null || definition.type !== LAMBDA_TYPE) {
    return body;
  }
  return field(body, "body");
}

/**
 * Emits a method's own facts and returns its key. The caller binds the
 * method's name, because a method in a class belongs to the class and a
 * method at the top of a file belongs to the file.
 */
function emitMethodFacts(emitter: Emitter, method: RbNode): string {
  const funcKey = nodeId(emitter.filePath, method);
  add(emitter, "func", funcKey);

  let position = 0;
  for (const param of parametersOf(method)) {
    const paramName = paramNameOf(param);
    if (paramName !== null) {
      const paramKey = `${funcKey}#${paramName.text}`;
      add(emitter, "paramOf", funcKey, String(position), paramKey);
      add(emitter, "paramNamed", funcKey, paramName.text, paramKey);
    }
    position += 1;
  }

  const inside: Emitter = { ...emitter, enclosing: method };

  const body = definitionBody(method);
  if (body === null) {
    return funcKey;
  }

  const recordNested = (node: RbNode): void => {
    for (const child of children(node)) {
      if (OWN_BODY_TYPES.has(child.type)) {
        add(emitter, "containsFn", funcKey, nodeId(emitter.filePath, child));
        continue;
      }
      recordNested(child);
    }
  };
  recordNested(body);

  walkExpressions(body, inside, (child) => {
    if (child.type === "return") {
      // tree-sitter wraps the value of `return x` in an argument list.
      const first = children(child)[0];
      const returned =
        first?.type === "argument_list" ? children(first)[0] : first;
      if (returned !== undefined) {
        add(inside, "returnsValue", funcKey, valueKey(inside, returned));
      }
    }
    if (child.type === "call" || isBareCall(child, method)) {
      for (const callee of calleeKeysOf(inside.filePath, child, method)) {
        add(inside, "bodyCalls", funcKey, callee);
      }
      add(inside, "makesCall", funcKey, nodeId(inside.filePath, child));
    }
  });

  const implicit = implicitReturn(body);
  if (implicit !== null) {
    add(inside, "returnsValue", funcKey, valueKey(inside, implicit));
  }

  emitExpressionFacts(inside, body);
  emitScopeWrites(inside, method, body);
  emitLambdasIn(inside, body);

  return funcKey;
}

/** A call, or an array or hash literal: a value built where it is written. */
function isConstruction(value: RbNode): boolean {
  return (
    value.type === "call" ||
    ARRAY_TYPES.has(value.type) ||
    value.type === "hash"
  );
}

/** Source text with whitespace collapsed, so two constructions that differ only in formatting compare equal. */
function sourceOf(node: RbNode): string {
  return node.text.replace(/\s+/g, " ").trim();
}

/**
 * An attribute read in Ruby is also a call, so `query = query.limit` and
 * `query = query.limit(1)` both narrow `query`. The rules work out what
 * either call returns from its value key.
 */
function readFirst(node: RbNode): RbNode | null {
  const inner = readThrough(node);
  if (inner !== node) {
    return inner;
  }
  return node.type === "call" ? field(node, "receiver") : null;
}

/** The Ruby details the shared chain walk needs. Ruby has two node types for a name. */
const CHAIN_READS: ChainReads<RbNode> = {
  nameTypes: RUBY_NAME_TYPES,
  readFirst,
};

function describeWrite(emitter: Emitter, write: LocalWrite): NameWrite {
  const value = write.value === null ? null : readThrough(write.value);
  return {
    value: value === null ? null : valueKey(emitter, value),
    placeholder: value?.type === "nil",
    construction:
      value !== null && isConstruction(value) ? sourceOf(value) : null,
    narrowsName:
      value !== null &&
      value.type === "call" &&
      startsAtName(value, write.name, CHAIN_READS),
  };
}

/**
 * The value a name ends up with, or null when its writes do not settle on
 * one. A name written once has that write's value. A parameter that is
 * never reassigned returns null here, because `paramNamed` covers it.
 */
function settledValue(emitter: Emitter, group: NameWrites): string | null {
  const only = group.writes.length === 1 ? group.writes[0] : undefined;
  if (only !== undefined) {
    return only.fromParameter || only.value === null
      ? null
      : valueKey(emitter, only.value);
  }
  return valueLeftByWrites(
    group.writes.map((write) => describeWrite(emitter, write)),
    group.ordered,
  );
}

/**
 * Records the value of each name a scope writes. A name written once gets
 * `binds`. A reassigned name gets `endsHolding` when its writes settle on
 * one value, and one candidate per write when control flow decides which
 * write a reader sees.
 */
function emitScopeWrites(
  emitter: Emitter,
  method: RbNode | null,
  body: RbNode,
): void {
  for (const group of collectWrites(method, body)) {
    const settled = settledValue(emitter, group);
    const key =
      group.owner === null
        ? nameId(emitter.filePath, group.name)
        : `${nodeId(emitter.filePath, group.owner)}#${group.name}`;
    if (settled === null) {
      emitCandidates(emitter, key, group);
      continue;
    }
    add(
      emitter,
      group.writes.length === 1 ? "binds" : "endsHolding",
      key,
      settled,
    );
    // Another file can read only a name written at the top of a file.
    if (group.owner === null) {
      add(emitter, "exportsAs", emitter.filePath, group.name, settled);
    }
  }
}

/**
 * Records each value a write gives a name whose writes did not settle on
 * one, as `mayHold`. A write that narrows the name is left out. A write
 * with no stated value, such as a `for` target or a block parameter, adds
 * `writesUnstated`. A method parameter adds neither, since `paramNamed`
 * covers it. `writesAllStated` means every write to the name was read.
 */
function emitCandidates(
  emitter: Emitter,
  key: string,
  group: NameWrites,
): void {
  let unstated = false;
  let stated = 0;
  for (const write of group.writes) {
    if (write.value === null) {
      add(emitter, "writesUnstated", key);
      unstated = true;
      continue;
    }
    // The caller supplies a parameter's value, and nothing here says a
    // later write always replaces it, so the writes read are not all of them.
    if (write.fromParameter) {
      unstated = true;
      continue;
    }
    if (!describeWrite(emitter, write).narrowsName) {
      add(emitter, "mayHold", key, valueKey(emitter, write.value));
      stated += 1;
    }
  }
  if (!unstated && stated > 0) {
    add(emitter, "writesAllStated", key);
  }
}

/** The method Ruby runs on a new instance. */
const INITIALIZE_METHOD = "initialize";

/**
 * The key `self` has inside a method. In an instance method `self` is an
 * instance of the class, with a key of its own so that a walk from one
 * construction reads that construction's fields. In `def self.x`, `self`
 * is the class itself.
 */
function receiverKeyOf(
  filePath: string,
  method: RbNode,
  classKey: string,
): string {
  return method.type === "singleton_method"
    ? classKey
    : `${nodeId(filePath, method)}#self`;
}

/** A mixin argument written any other way has no name a rule can join on. */
const CONSTANT_REF_TYPES = new Set(["constant", "scope_resolution"]);

/**
 * The modules passed to one kind of mixin call, in the order Ruby's
 * `ancestors` lists them. Each call puts its modules in front of the
 * earlier calls' modules, and `include A, B` puts A in front of B, so
 * both the calls and each call's arguments are reversed.
 */
function mixedInConstants(body: RbNode, callName: string): RbNode[] {
  return bareCallArgumentGroups(body, callName)
    .flatMap((group) => [...group].reverse())
    .reverse()
    .map(readThrough)
    .filter((argument) => CONSTANT_REF_TYPES.has(argument.type));
}

/**
 * A module mixed in with `include` or `prepend` is an ancestor in Ruby's
 * method lookup. An included module comes after the class, so it is
 * recorded as `extends`, like a superclass. A prepended module comes
 * before the class, so its methods win over the class's own, and it is
 * recorded as `prepends` so the rules can tell the two apart.
 *
 * Neither is recorded in `extendsNamed`, which gives the library base a
 * class ends up at. A module is never that base, and listing one there
 * would give a pack a second base to match.
 */
function emitMixinFacts(
  emitter: Emitter,
  classKey: string,
  body: RbNode,
  callName: string,
  relation: "extends" | "prepends",
): void {
  for (const mixin of mixedInConstants(body, callName)) {
    add(emitter, relation, classKey, valueKey(emitter, mixin));
  }
}

/**
 * A class or module is recorded as an object whose properties are its
 * methods, the same way an array or hash is recorded. A method called on
 * an instance then resolves to the method the class declares, and a bare
 * call inside a module resolves to a method the module declares.
 */
function emitClassFacts(emitter: Emitter, cls: RbNode): string {
  const classKey = nodeId(emitter.filePath, cls);
  add(emitter, "objectValue", classKey);

  const body = field(cls, "body");
  // Ruby looks a method up in prepended modules, then the class itself,
  // then included modules, then the superclass chain.
  if (body !== null) {
    emitMixinFacts(emitter, classKey, body, PREPEND_CALL, "prepends");
    emitMixinFacts(emitter, classKey, body, INCLUDE_CALL, "extends");
  }

  const superclass = field(cls, "superclass");
  const base = superclass === null ? null : (children(superclass)[0] ?? null);
  if (base !== null) {
    add(emitter, "extends", classKey, valueKey(emitter, base));
    // A base class the project does not declare, such as `ActiveRecord::Base`,
    // has no node to bind to, so a pack matches it by the name as written.
    add(emitter, "extendsNamed", classKey, base.text);
  }

  const collected = new Map<string, InstanceWrite[]>();
  const within: Emitter = {
    ...emitter,
    selfKey: classKey,
    insideMethod: false,
    instanceWrites: collected,
  };
  const statements =
    body === null
      ? []
      : bodyStatementsRun(body, cls.type === "module", emitter.bodyBlocks);
  for (const statement of statements) {
    if (statement.type === "assignment") {
      const left = field(statement, "left");
      const right = field(statement, "right");
      if (left !== null && right !== null && left.type === "constant") {
        add(
          emitter,
          "holdsProperty",
          classKey,
          left.text,
          valueKey(emitter, right),
        );
        // The right side runs in the class body, so a bare call in it is
        // looked up on the class.
        emitExpressionFacts(within, statement);
      }
      continue;
    }
    if (NESTING_TYPES.has(statement.type)) {
      // A nested class or module gets its own object, keyed on the node
      // that collectFileConstants binds a qualified name like A::B to.
      emitClassFacts(emitter, statement);
      continue;
    }
    if (!METHOD_TYPES.has(statement.type)) {
      // Ruby runs a class body, so a statement there such as
      // `Settings.filters.each do ... end` gets the same facts as in a method.
      emitExpressionFacts(within, statement);
      continue;
    }
    const stored = new Map<string, InstanceWrite[]>();
    const receiverKey = receiverKeyOf(emitter.filePath, statement, classKey);
    if (receiverKey !== classKey) {
      add(emitter, "instanceOf", receiverKey, classKey);
    }
    const funcKey = emitMethodFacts(
      {
        ...within,
        selfKey: receiverKey,
        insideMethod: receiverKey !== classKey,
        instanceWrites: stored,
      },
      statement,
    );
    const name = field(statement, "name");
    if (name !== null) {
      add(emitter, "holdsProperty", classKey, name.text, funcKey);
      if (name.text === INITIALIZE_METHOD) {
        add(emitter, "initializes", classKey, funcKey);
      }
    }
    const methodBody = field(statement, "body");
    if (methodBody !== null) {
      emitInstanceStores(within, funcKey, methodBody, stored);
    }
  }
  emitInstanceWrites(within, classKey, collected);
  if (body !== null) {
    emitLambdasIn(within, body);
  }

  return classKey;
}

/**
 * Walks a file and emits its value facts. Each method is walked on its
 * own, so the returns and calls in a body are recorded against the method
 * they are written in.
 */
export function emitValueFacts(
  db: Database,
  filePath: string,
  root: RbNode,
  bodyBlocks: BodyBlocks = NO_BODY_BLOCKS,
): void {
  const emitter: Emitter = {
    db,
    filePath,
    enclosing: null,
    selfKey: null,
    insideMethod: false,
    instanceWrites: null,
    bodyBlocks,
  };

  const declaresName = (child: RbNode, key: string): void => {
    const name = field(child, "name");
    if (name === null) {
      return;
    }
    add(emitter, "binds", nameId(filePath, name.text), key);
    // Another file can refer to a top-level declaration by name.
    add(emitter, "exportsAs", filePath, name.text, key);
  };

  const walk = (node: RbNode): void => {
    for (const child of children(node)) {
      if (NESTING_TYPES.has(child.type)) {
        declaresName(child, emitClassFacts(emitter, child));
        // The class's methods belong to the class, so the walk does not
        // descend and record them as the file's.
        continue;
      }
      if (METHOD_TYPES.has(child.type)) {
        declaresName(child, emitMethodFacts(emitter, child));
      }
      walk(child);
    }
  };

  walk(root);
  emitExpressionFacts(emitter, root);
  emitScopeWrites(emitter, null, root);
  emitLambdasIn(emitter, root);
}
