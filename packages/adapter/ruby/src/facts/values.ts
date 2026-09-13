// values.ts: the facts @suss/resolution already joins, emitted for Ruby.
// The relation names and shapes come from that package's own header, and the
// README says which Ruby constructs differ from the other adapters.

import { startsAtName, valueLeftByWrites } from "@suss/resolution";

import {
  bareCallArgumentGroups,
  bodyStatementsRun,
  field,
  INCLUDE_CALL,
  NESTING_TYPES,
  NO_BODY_BLOCKS,
  OWN_BODY_TYPES,
  PREPEND_CALL,
} from "../ast.js";
import { spellsAName } from "../paths/bareCalls.js";
import {
  collectWrites,
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
 * A node's identity across the whole run. The end is part of it because a
 * call and its receiver start at the same offset.
 */
export function nodeId(filePath: string, node: RbNode): string {
  return `${filePath}:${node.startIndex}-${node.endIndex}`;
}

/** A name in a file, which is what a binding joins on. */
function nameId(filePath: string, name: string): string {
  return `${filePath}#${name}`;
}

/**
 * Parentheses say nothing about a value, so every key reads through a pair
 * holding one expression. A pair holding several is a `begin` block whose
 * value is its last statement, which is a different question.
 */
function readThrough(node: RbNode): RbNode {
  if (node.type !== "parenthesized_statements") {
    return node;
  }
  const inner = node.namedChildren.filter((child) => child !== null);
  return inner.length === 1 ? readThrough(inner[0] as RbNode) : node;
}

/**
 * The key a bare name joins on: its own scope's, so `query` in one method is
 * apart from `query` in the next. `enclosing` is the method the name is
 * written in, or null outside one.
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
 * The key a read of this expression joins on, for a caller that has an
 * expression in hand and wants to ask the rules about it. `enclosing` is
 * the method the expression is written in, or null outside one.
 *
 * Two Ruby spellings are keyed on a node rather than on a name. Ruby
 * gives `receiver.method` no node of its own, so the method name is
 * where the callee is keyed, and a name Ruby runs as a method is the
 * call itself.
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

/** Whether this name is the method of a `receiver.method` call, which is that call's callee. */
function isMethodOfReceiver(node: RbNode): boolean {
  const parent = node.parent;
  return (
    parent !== null &&
    parent.type === "call" &&
    field(parent, "method")?.id === node.id &&
    field(parent, "receiver") !== null
  );
}

/**
 * Whether Ruby runs this name rather than reading it: no local in
 * scope declares it, so it is a call of a method on `self`.
 */
function isBareCall(node: RbNode, enclosing: RbNode | null): boolean {
  if (node.type !== "identifier" || spellsAName(node)) {
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
  // Composed from other expressions, so a chain ends here and the
  // evaluator reads the expression back in the scope it is written in.
  "chained_string",
  "binary",
  "unary",
  "conditional",
  "element_reference",
  "parenthesized_statements",
]);

/** `%w[a b]` and `%i[a b]` are arrays whose elements are bare words. */
const ARRAY_TYPES = new Set(["array", "string_array", "symbol_array"]);

/** tree-sitter types a named child as nullable; dropping them once keeps every walk below flat. */
function children(node: RbNode): RbNode[] {
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

interface Emitter {
  db: Database;
  filePath: string;
  /**
   * The method whose body is being walked. Its parameters and locals are
   * keyed under it, because two methods in one file can both write a
   * `loader` and they are not the same value.
   */
  enclosing: RbNode | null;
  /** The class or module `self` means here, or null outside one. */
  selfKey: string | null;
  /**
   * Every value the class being walked writes to each of its instance
   * variables. They are collected across the whole class because the
   * method that writes one and the method that reads it are two
   * different bodies, and nothing here orders them.
   */
  instanceWrites: Map<string, NameWrite[]> | null;
  /** The calls the run's packs say run their block as part of the body around it. */
  bodyBlocks: BodyBlocks;
}

function add(emitter: Emitter, relation: string, ...tuple: string[]): void {
  emitter.db.add(relation, tuple);
}

/** The key a value joins on, which is the key a reader asks the rules about. */
function valueKey(emitter: Emitter, written: RbNode): string {
  return readKey(emitter.filePath, written, emitter.enclosing);
}

/** A pair's key when it is written as a symbol or a string, which is what a property joins on. */
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
 * Ruby gives `receiver.method` no node of its own, so the method name
 * is the callee, and a bare name Ruby runs is its own method name.
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
  // Keying a bare callee on its node would find a method of that name at
  // the top of the file instead of the one in scope.
  return field(node, "receiver") === null
    ? nameKey(filePath, method, enclosing)
    : nodeId(filePath, method);
}

function emitCall(emitter: Emitter, call: RbNode): void {
  // A call is written out in the source, so a name bound to one ends its
  // chain there and `isWrittenAs` reads it back.
  add(emitter, "writtenValue", nodeId(emitter.filePath, call));

  // A bare name Ruby runs is the whole call and its own method name.
  const method = call.type === "identifier" ? call : field(call, "method");
  const calleeKey = calleeKeyOf(emitter.filePath, call, emitter.enclosing);
  if (method === null || calleeKey === null) {
    return;
  }

  const receiver = field(call, "receiver");
  const callKey = nodeId(emitter.filePath, call);
  add(emitter, "call", callKey, calleeKey);
  if (receiver !== null) {
    add(
      emitter,
      "readsProperty",
      calleeKey,
      valueKey(emitter, receiver),
      method.text,
    );
  }

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

/** An array records its elements under their positions, the way the other adapters do. */
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

/** A hash records its values under their written keys. */
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

/** The two spellings of a block, `{ }` and `do ... end`. */
const BLOCK_TYPES = new Set(["block", "do_block"]);

/**
 * Ruby's own iteration methods, whose block runs once per element with
 * the element bound to its first parameter and, for `each_with_index`,
 * the position bound to its second. They are `Enumerable`'s, so they
 * are the language core the way `ENV` is rather than a library's.
 */
const LOOP_METHODS = new Set(["each", "each_with_index", "map"]);

/** Ruby's own dynamic definition, whose argument is the name the method gets. */
const DEFINE_METHOD_CALL = "define_method";

/** What one turn of a loop block binds, and the value its elements come from. */
interface LoopTurn {
  readonly element: string;
  /** The name the position is bound to, or the empty string for a block that takes one parameter. */
  readonly index: string;
  readonly overKey: string;
}

/** What a block binds per turn when a loop call opened it, or null for every other block. */
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
  // The expression's own key, not the name's: what it comes down to is
  // the evaluator's question, and it reads these same facts to answer it.
  return {
    element,
    index: names[1] ?? "",
    overKey: nodeId(emitter.filePath, receiver),
  };
}

/**
 * A method the class gets under a name the source computes. The name is
 * whatever the argument comes down to, which the value evaluator settles
 * from these same facts, so nothing here reads the argument itself.
 */
function emitDynamicDefinition(
  emitter: Emitter,
  call: RbNode,
  turns: readonly LoopTurn[],
): void {
  if (
    emitter.selfKey === null ||
    // A call inside a method runs when that method does, not at load time.
    emitter.enclosing !== null ||
    call.type !== "call" ||
    field(call, "receiver") !== null ||
    field(call, "method")?.text !== DEFINE_METHOD_CALL
  ) {
    return;
  }
  const args = field(call, "arguments");
  const first = args === null ? undefined : children(args)[0];
  // A call handed no name at all points at itself, which settles on nothing.
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

/** Every expression under a node, without crossing into a nested declaration. `turns` is the loop blocks the expression is written inside, outermost first. */
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

function emitExpressionFacts(emitter: Emitter, node: RbNode): void {
  // The walk below starts at the children, so a statement that is itself
  // a definition would go unseen.
  emitDynamicDefinition(emitter, node, []);
  walkExpressions(node, emitter, (child, turns) => {
    emitDynamicDefinition(emitter, child, turns);
    if (child.type === "call" || isBareCall(child, emitter.enclosing)) {
      emitCall(emitter, child);
    }
    if (ARRAY_TYPES.has(child.type)) {
      emitArray(emitter, child);
    }
    if (child.type === "hash") {
      emitHash(emitter, child);
    }
    if (WRITTEN_VALUE_TYPES.has(child.type)) {
      add(emitter, "writtenValue", nodeId(emitter.filePath, child));
    }
    if (child.type === "nil") {
      add(emitter, "placeholderValue", nodeId(emitter.filePath, child));
    }
    // A builder method returning `self` hands back one of the class it is
    // written in, so the next method in a chain is one that class declares.
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

/** Whether this is the name an assignment writes to rather than a value being read. */
function isWriteTarget(node: RbNode): boolean {
  const parent = node.parent;
  return (
    parent !== null &&
    ASSIGNMENT_TYPES.has(parent.type) &&
    field(parent, "left")?.id === node.id
  );
}

/**
 * An instance variable is a name on the object, so reading one is
 * reading a property of the class. That is what lets a write in a base
 * class reach a read in a subclass: `contains` already walks `extends`,
 * so the ancestry is joined without a step of its own.
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
  // `count += 1` combines the right side with what is already there, and
  // that result is written nowhere this can name.
  const operator = field(node, "operator")?.text;
  const value =
    node.type === "assignment" || WHOLE_VALUE_OPERATORS.has(operator ?? "")
      ? right
      : null;
  const written = collector.get(left.text) ?? [];
  written.push(
    describeWrite(emitter, {
      name: left.text,
      target: left,
      value,
      at: node,
      fromParameter: false,
    }),
  );
  collector.set(left.text, written);
}

/**
 * The value each instance variable the class writes ends up with.
 * Nothing orders two methods, so the writes settle on a value only when
 * they agree; otherwise each write is a value the name may end up with,
 * and a reader that needs one answer sees more than one source.
 */
function emitInstanceWrites(
  emitter: Emitter,
  classKey: string,
  collected: ReadonlyMap<string, NameWrite[]>,
): void {
  for (const [name, writes] of collected) {
    const settled = valueLeftByWrites(writes, false);
    if (settled !== null) {
      add(emitter, "holdsProperty", classKey, name, settled);
      continue;
    }
    for (const write of writes) {
      if (write.value !== null && !write.narrowsName) {
        add(emitter, "holdsProperty", classKey, name, write.value);
      }
    }
  }
}

/** A method returns its last expression when it writes no return, which Python has no equivalent of. */
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
 * The value an assignment is worth, since Ruby hands back what it
 * wrote. `@filters ||= %i[...]` as a method's last line is the
 * memoised list, and a reader that stopped at the assignment would
 * have nothing to read.
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
 * Where a method's name goes is the caller's to say, because a method inside a
 * class belongs to that class and one at the top of a file belongs to the file.
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

  const body = field(method, "body");
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
      // `return x` wraps the value in an argument list, the same shape a
      // call's arguments take.
      const first = children(child)[0];
      const returned =
        first?.type === "argument_list" ? children(first)[0] : first;
      if (returned !== undefined) {
        add(inside, "returnsValue", funcKey, valueKey(inside, returned));
      }
    }
    if (child.type === "call" || isBareCall(child, method)) {
      add(inside, "bodyCalls", funcKey, nodeId(inside.filePath, child));
    }
  });

  const implicit = implicitReturn(body);
  if (implicit !== null) {
    add(inside, "returnsValue", funcKey, valueKey(inside, implicit));
  }

  emitExpressionFacts(inside, body);
  emitScopeWrites(inside, method, body);

  return funcKey;
}

/** A call, or an array or a hash literal: a value built where it is written. */
function isConstruction(value: RbNode): boolean {
  return (
    value.type === "call" ||
    ARRAY_TYPES.has(value.type) ||
    value.type === "hash"
  );
}

/** Source text with whitespace runs collapsed, so formatting alone never tells two constructions apart. */
function sourceOf(node: RbNode): string {
  return node.text.replace(/\s+/g, " ").trim();
}

/**
 * Ruby writes an attribute read as a call too, so `query = query.limit`
 * reads the same way as `query = query.limit(1)` and both narrow the
 * name. What either call gives back is left to the rules, which have the
 * value key for it.
 */
function readFirst(node: RbNode): RbNode | null {
  const inner = readThrough(node);
  if (inner !== node) {
    return inner;
  }
  return node.type === "call" ? field(node, "receiver") : null;
}

/** What the shared chain walk needs to know about Ruby, which spells a name two ways. */
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
 * The value a name comes down to, or null when the writes settle on none.
 * A name written once is that write, the way every `const` is in a language
 * that has one; a parameter written once is already covered by `paramNamed`.
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
 * What each name a scope writes comes down to. A name written once is bound
 * to that value; a reassigned name comes down to whatever the writes leave
 * behind, and to nothing when control flow decides which write a reader sees.
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
    // Only a name written at the top of a file is something another file can read.
    if (group.owner === null) {
      add(emitter, "exportsAs", emitter.filePath, group.name, settled);
    }
  }
}

/**
 * Each value a write put in a name the writes left undecided. A write that
 * narrows the name is left out, and a write with no value of its own, a
 * `for` target or a block parameter, is what `writesUnstated` says. A
 * method parameter is left out of both: `paramNamed` already says the
 * value is whatever the caller passed.
 */
function emitCandidates(
  emitter: Emitter,
  key: string,
  group: NameWrites,
): void {
  for (const write of group.writes) {
    if (write.value === null) {
      add(emitter, "writesUnstated", key);
      continue;
    }
    if (write.fromParameter) {
      continue;
    }
    if (!describeWrite(emitter, write).narrowsName) {
      add(emitter, "mayHold", key, valueKey(emitter, write.value));
    }
  }
}

const METHOD_TYPES = new Set(["method", "singleton_method"]);

/** A name a rule can join on. A mixin written any other way has none. */
const CONSTANT_REF_TYPES = new Set(["constant", "scope_resolution"]);

/**
 * The modules given to one kind of mixin call, in the order Ruby's own
 * ancestors list has them. Each call goes in front of the ones before
 * it, and `include A, B` puts A in front of B, which is why the
 * arguments of one call and the calls themselves are each reversed.
 */
function mixedInConstants(body: RbNode, callName: string): RbNode[] {
  return bareCallArgumentGroups(body, callName)
    .flatMap((group) => [...group].reverse())
    .reverse()
    .map(readThrough)
    .filter((argument) => CONSTANT_REF_TYPES.has(argument.type));
}

/**
 * A module mixed in with `include` or `prepend` is an ancestor in
 * Ruby's own lookup, so `extends` is the fact for it and every rule
 * that already walks an ancestry reaches what the module declares.
 *
 * `extendsNamed` is left alone. It says which library base a class
 * arrives at, and a module is never one, so naming a mixin there would
 * give a class a second base for a pack to match on.
 */
function emitMixinFacts(
  emitter: Emitter,
  classKey: string,
  body: RbNode,
  callName: string,
): void {
  for (const mixin of mixedInConstants(body, callName)) {
    add(emitter, "extends", classKey, valueKey(emitter, mixin));
  }
}

/**
 * A class or a module is an object containing its methods, which is the
 * treatment an array and a hash already get. That is what lets a method
 * read off an instance resolve to the method the class declares, and a
 * bare call on a module resolve to a method it declares.
 */
function emitClassFacts(emitter: Emitter, cls: RbNode): string {
  const classKey = nodeId(emitter.filePath, cls);
  add(emitter, "objectValue", classKey);

  const body = field(cls, "body");
  // Ruby looks a method up through what is prepended, then the class
  // itself, then what is included, then the superclass chain.
  if (body !== null) {
    emitMixinFacts(emitter, classKey, body, PREPEND_CALL);
    emitMixinFacts(emitter, classKey, body, INCLUDE_CALL);
  }

  const superclass = field(cls, "superclass");
  const base = superclass === null ? null : (children(superclass)[0] ?? null);
  if (base !== null) {
    add(emitter, "extends", classKey, valueKey(emitter, base));
    // A base class the project does not declare, `ActiveRecord::Base`, has no
    // node to bind to, so the name it is written as is what a pack can match.
    add(emitter, "extendsNamed", classKey, base.text);
  }

  const collected = new Map<string, NameWrite[]>();
  const within: Emitter = {
    ...emitter,
    selfKey: classKey,
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
        emitExpressionFacts(emitter, statement);
      }
      continue;
    }
    if (NESTING_TYPES.has(statement.type)) {
      // A nested class or module is an object of its own. Its key is the
      // node collectFileConstants binds a qualified name like A::B to.
      emitClassFacts(emitter, statement);
      continue;
    }
    if (!METHOD_TYPES.has(statement.type)) {
      // Ruby runs a class body, so `Settings.filters.each do ... end`
      // written there reads a value the same way a method body would.
      emitExpressionFacts(within, statement);
      continue;
    }
    const funcKey = emitMethodFacts(within, statement);
    const name = field(statement, "name");
    if (name !== null) {
      add(emitter, "holdsProperty", classKey, name.text, funcKey);
    }
  }
  emitInstanceWrites(within, classKey, collected);

  return classKey;
}

/**
 * Walk a file and emit the value facts. A method is walked in its own right,
 * so a body's returns and calls belong to the method that wrote them.
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
    instanceWrites: null,
    bodyBlocks,
  };

  const declaresName = (child: RbNode, key: string): void => {
    const name = field(child, "name");
    if (name === null) {
      return;
    }
    add(emitter, "binds", nameId(filePath, name.text), key);
    // A declaration at the top of a file is what another file gets by name.
    add(emitter, "exportsAs", filePath, name.text, key);
  };

  const walk = (node: RbNode): void => {
    for (const child of children(node)) {
      if (NESTING_TYPES.has(child.type)) {
        declaresName(child, emitClassFacts(emitter, child));
        // Its methods are its own; descending would make them the file's.
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
}
