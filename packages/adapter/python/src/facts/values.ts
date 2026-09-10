/**
 * values.ts: the facts @suss/resolution already joins, emitted for Python.
 * The relation names and shapes come from that package's own header, so a
 * Python value follows the same rules a TypeScript one does.
 *
 * A name is keyed by the scope that binds it. A function's own names take
 * the function's key, so two handlers that both write `query` stay apart,
 * and a module's names take the file's key, which is what another file
 * imports back out. Every write to a name in one scope is collected in
 * source order and `valueLeftByWrites` says what the name comes down to,
 * so a reassigned name states one value or none rather than two.
 */

import { valueLeftByWrites } from "@suss/resolution";

import {
  children,
  enclosingFunction,
  field,
  fields,
  isFunction,
} from "../ast.js";

import type { Database } from "@suss/datalog";
import type { NameWrite } from "@suss/resolution";
import type { Parameter } from "@suss/values";
import type { PyNode } from "../parser.js";

/**
 * A node's identity across the whole run. The end is part of it because a
 * call and its callee start at the same offset.
 */
export function nodeId(filePath: string, node: PyNode): string {
  return `${filePath}:${node.startIndex}-${node.endIndex}`;
}

/** A module-level name in a file, which is what a binding joins on. */
function nameId(filePath: string, name: string): string {
  return `${filePath}#${name}`;
}

/**
 * The key a read of this expression joins on, for a caller that has an
 * expression in hand and wants to ask the rules about it. `enclosing` is
 * the function the expression is written in, or null at module level.
 */
export function readKey(
  filePath: string,
  node: PyNode,
  enclosing: PyNode | null,
): string {
  if (node.type !== "identifier") {
    return nodeId(filePath, node);
  }
  return nameKeyIn(filePath, enclosing, node.text);
}

/**
 * The key a name joins on, for a caller holding the name as text and the
 * function it is written in.
 */
export function nameKeyIn(
  filePath: string,
  enclosing: PyNode | null,
  name: string,
): string {
  return nameKey(filePath, scopeChainOf(filePath, enclosing), name);
}

/** Written out in the source rather than a name for something written elsewhere. */
const WRITTEN_VALUE_TYPES = new Set([
  "string",
  "integer",
  "float",
  "true",
  "false",
  "none",
  "concatenated_string",
  // Composed from other expressions, so a chain ends here and the
  // evaluator reads the expression back in the scope it is written in.
  "binary_operator",
  "boolean_operator",
  "comparison_operator",
  "not_operator",
  "unary_operator",
  "conditional_expression",
  "subscript",
  "parenthesized_expression",
  "await",
  "list_comprehension",
  "dictionary_comprehension",
  "set_comprehension",
  "generator_expression",
]);

/** A sequence keeps its elements under their positions, the way TypeScript's arrays do, so one property rule covers `items[0]`. */
const SEQUENCE_TYPES = new Set(["list", "tuple", "set"]);

/** `*args` and `**kwargs` collect what is left rather than taking one value. */
const SPLAT_TYPES = new Set(["list_splat_pattern", "dictionary_splat_pattern"]);

/**
 * What a parameter is called. `loader: ApplicationLoader` is a
 * `typed_parameter`, which the grammar gives no name field, so the name is the
 * identifier it starts with.
 */
function parameterName(param: PyNode): PyNode | null {
  if (param.type === "identifier") {
    return param;
  }
  const named = field(param, "name");
  if (named !== null) {
    return named;
  }
  return children(param).find((child) => child.type === "identifier") ?? null;
}

/** What a function calls its parameters, in order. `*args` and `**kwargs` are left out. */
export function parameterList(fn: PyNode): string[] {
  return parameterShapes(fn).map((parameter) => parameter.name);
}

/** Each parameter with the expression it defaults to, in order. `*args` and `**kwargs` are left out. */
export function parameterShapes(fn: PyNode): Parameter<PyNode>[] {
  const params = field(fn, "parameters");
  const declared: Parameter<PyNode>[] = [];
  for (const param of params === null ? [] : children(params)) {
    if (SPLAT_TYPES.has(param.type)) {
      continue;
    }
    const name = parameterName(param);
    if (name !== null) {
      declared.push({ name: name.text, default: field(param, "value") });
    }
  }
  return declared;
}

/** Every name a parameter list binds in the body, `*args` and `**kwargs` included. */
function boundParameterNames(fn: PyNode): string[] {
  const params = field(fn, "parameters");
  const names: string[] = [];
  for (const param of params === null ? [] : children(params)) {
    const name = parameterName(param);
    if (name !== null) {
      names.push(name.text);
    }
  }
  return names;
}

/** The function a name is read in, and what it binds, so two functions' `query` stay apart. */
interface FunctionScope {
  funcKey: string;
  /** Names this function binds, which is what a read of one keys to. */
  locals: ReadonlySet<string>;
  /** Names a `global` statement here sends to the module. */
  globals: ReadonlySet<string>;
  parent: FunctionScope | null;
}

interface Emitter {
  db: Database;
  filePath: string;
  /** The function whose body is being walked, and the functions around it. Null at module level. */
  enclosing: FunctionScope | null;
}

function add(emitter: Emitter, relation: string, ...tuple: string[]): void {
  emitter.db.add(relation, tuple);
}

/**
 * Where a name resolves: the innermost function that binds it, the module
 * when a `global` declaration sends it there, and the module again when
 * nothing binds it.
 */
function nameKey(
  filePath: string,
  scope: FunctionScope | null,
  name: string,
): string {
  for (let current = scope; current !== null; current = current.parent) {
    if (current.globals.has(name)) {
      return nameId(filePath, name);
    }
    if (current.locals.has(name)) {
      return `${current.funcKey}#${name}`;
    }
  }
  return nameId(filePath, name);
}

/** The chain of functions a node is written inside, innermost first. */
function scopeChainOf(
  filePath: string,
  fn: PyNode | null,
): FunctionScope | null {
  if (fn === null) {
    return null;
  }
  const reading = scopeReadingOf(fn);
  return {
    funcKey: nodeId(filePath, fn),
    locals: reading.locals,
    globals: reading.globals,
    parent: scopeChainOf(filePath, enclosingFunction(fn)),
  };
}

/** The callee of a call, and the arguments it passes by position. */
function emitCall(emitter: Emitter, call: PyNode): void {
  // A call is written out in the source, so a name bound to one ends its
  // chain there. It gets no `comesTo`, which is the rules' own decision
  // about a factory call, and `isWrittenAs` is what reads it back.
  add(emitter, "writtenValue", nodeId(emitter.filePath, call));

  const callee = field(call, "function");
  const args = field(call, "arguments");
  // The grammar writes both fields on every call.
  /* v8 ignore start */
  if (callee === null || args === null) {
    return;
  }
  /* v8 ignore stop */
  const callKey = nodeId(emitter.filePath, call);
  add(emitter, "call", callKey, valueKey(emitter, callee));

  let position = 0;
  for (const argument of children(args)) {
    if (argument.type === "keyword_argument") {
      const name = field(argument, "name");
      const value = field(argument, "value");
      if (name !== null && value !== null) {
        add(
          emitter,
          "callKeywordArg",
          callKey,
          name.text,
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

/**
 * The key a value joins on. A bare name joins on the name in the scope that
 * binds it; anything else joins on its own node.
 */
function valueKey(emitter: Emitter, value: PyNode): string {
  if (value.type !== "identifier") {
    return nodeId(emitter.filePath, value);
  }
  return nameKey(emitter.filePath, emitter.enclosing, value.text);
}

/** A sequence is an object whose keys are positions. */
function emitSequence(emitter: Emitter, sequence: PyNode): void {
  const objectKey = nodeId(emitter.filePath, sequence);
  add(emitter, "objectValue", objectKey);
  let position = 0;
  for (const element of children(sequence)) {
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

/** A dictionary is an object whose string keys contain values. */
function emitDictionary(emitter: Emitter, dictionary: PyNode): void {
  const objectKey = nodeId(emitter.filePath, dictionary);
  add(emitter, "objectValue", objectKey);
  for (const pair of children(dictionary)) {
    if (pair.type !== "pair") {
      continue;
    }
    const key = field(pair, "key");
    const value = field(pair, "value");
    if (key === null || value === null || key.type !== "string") {
      continue;
    }
    add(
      emitter,
      "holdsProperty",
      objectKey,
      key.text.slice(1, -1),
      valueKey(emitter, value),
    );
  }
}

/** `a.b` read as a property of `a`. */
function emitAttribute(emitter: Emitter, attribute: PyNode): void {
  const object = field(attribute, "object");
  const property = field(attribute, "attribute");
  /* v8 ignore start */
  if (object === null || property === null) {
    return;
  }
  /* v8 ignore stop */
  add(
    emitter,
    "readsProperty",
    nodeId(emitter.filePath, attribute),
    valueKey(emitter, object),
    property.text,
  );
}

/** Every expression under a node, without crossing into a nested function. */
function walkExpressions(
  emitter: Emitter,
  node: PyNode,
  visit: (child: PyNode) => void,
): void {
  for (const child of children(node)) {
    if (isFunction(child)) {
      continue;
    }
    visit(child);
    walkExpressions(emitter, child, visit);
  }
}

/** What one expression says about itself, whichever walk reached it. */
function emitExpressionFact(emitter: Emitter, child: PyNode): void {
  if (child.type === "call") {
    emitCall(emitter, child);
  }
  if (child.type === "dictionary") {
    emitDictionary(emitter, child);
  }
  if (SEQUENCE_TYPES.has(child.type)) {
    emitSequence(emitter, child);
  }
  if (child.type === "attribute") {
    emitAttribute(emitter, child);
  }
  if (WRITTEN_VALUE_TYPES.has(child.type)) {
    add(emitter, "writtenValue", nodeId(emitter.filePath, child));
  }
  if (child.type === "none") {
    add(emitter, "placeholderValue", nodeId(emitter.filePath, child));
  }
}

function emitExpressionFacts(emitter: Emitter, node: PyNode): void {
  walkExpressions(emitter, node, (child) => {
    emitExpressionFact(emitter, child);
  });
}

/** The class a method belongs to, and what that method calls its receiver. */
interface MethodReceiver {
  classKey: string;
  name: string;
}

/**
 * A function's parameters by position, its returns, and the calls its body
 * makes. Where its name goes is the caller's to say, because a method belongs
 * to its class and a def belongs to its module.
 */
function emitFunctionFacts(
  emitter: Emitter,
  fn: PyNode,
  classKey?: string,
): string {
  const funcKey = nodeId(emitter.filePath, fn);
  add(emitter, "func", funcKey);

  const params = field(fn, "parameters");
  // A method's first parameter is the receiver, which the caller does not
  // write, so counting it would put the first written argument in it.
  let position = classKey === undefined ? 0 : -1;
  let byPosition = true;
  let receiver: MethodReceiver | null = null;
  for (const param of params === null ? [] : children(params)) {
    if (SPLAT_TYPES.has(param.type)) {
      // What follows a `*` can only be passed by name.
      byPosition = false;
      continue;
    }
    const paramName = parameterName(param);
    if (paramName !== null) {
      const paramKey = `${funcKey}#${paramName.text}`;
      if (byPosition && position >= 0) {
        add(emitter, "paramOf", funcKey, String(position), paramKey);
      }
      // Calling a class makes one of it, so an instance is the class
      // object, and that is what a method's receiver comes down to.
      if (classKey !== undefined && position === -1) {
        receiver = { classKey, name: paramName.text };
        add(emitter, "binds", paramKey, classKey);
      }
      add(emitter, "paramNamed", funcKey, paramName.text, paramKey);
    }
    position += 1;
  }

  const reading = scopeReadingOf(fn);
  const inside: Emitter = {
    ...emitter,
    enclosing: {
      funcKey,
      locals: reading.locals,
      globals: reading.globals,
      parent: emitter.enclosing,
    },
  };
  emitScopeWrites(inside, reading, false);

  const body = field(fn, "body");
  /* v8 ignore start */
  if (body === null) {
    return funcKey;
  }
  /* v8 ignore stop */

  emitNestedDefinitions(inside, body);

  // One walk for both, since this function's own facts and the expression
  // facts want the same nodes and the walk is the expensive part.
  walkExpressions(inside, body, (child) => {
    if (child.type === "return_statement") {
      const returned = child.namedChildren[0];
      if (returned != null) {
        add(inside, "returnsValue", funcKey, valueKey(inside, returned));
      }
    }
    if (child.type === "call") {
      add(inside, "bodyCalls", funcKey, nodeId(inside.filePath, child));
    }
    if (child.type === "assignment" && receiver !== null) {
      emitReceiverProperty(inside, child, receiver);
    }
    emitExpressionFact(inside, child);
  });

  return funcKey;
}

/**
 * `self.name = value` inside a method, which puts the value on the class so
 * a later `self.name` finds it.
 */
function emitReceiverProperty(
  emitter: Emitter,
  assignment: PyNode,
  receiver: MethodReceiver,
): void {
  const left = field(assignment, "left");
  const right = field(assignment, "right");
  if (left === null || right === null || left.type !== "attribute") {
    return;
  }

  const object = field(left, "object");
  const property = field(left, "attribute");
  if (
    object?.type !== "identifier" ||
    object.text !== receiver.name ||
    property === null
  ) {
    return;
  }
  add(
    emitter,
    "holdsProperty",
    receiver.classKey,
    property.text,
    valueKey(emitter, right),
  );
}

/**
 * What an assignment gives its name. `Annotated[T, ...]` is `T` with
 * metadata beside it, so `SessionDep = Annotated[Session, Depends(get_db)]`
 * gives the name `Session`, and a handler declared `db: SessionDep` is
 * read as one declared `db: Session`.
 */
function assignedValue(right: PyNode): PyNode {
  if (right.type !== "subscript") {
    return right;
  }
  const outer = field(right, "value");
  const first = fields(right, "subscript")[0];
  return outer?.text === "Annotated" && first !== undefined ? first : right;
}

/** The declaration a class-body statement makes, under whatever the grammar wraps it in. */
function declaredBy(statement: PyNode): PyNode {
  if (statement.type === "decorated_definition") {
    return field(statement, "definition") ?? statement;
  }
  if (statement.type === "expression_statement") {
    return children(statement)[0] ?? statement;
  }
  return statement;
}

/**
 * What a class body declares under a name: a method, or a class declared
 * inside another class. Null for anything else, which the class puts no
 * property under.
 */
function declaredMemberKey(
  emitter: Emitter,
  member: PyNode,
  classKey: string,
): string | null {
  if (member.type === "class_definition") {
    return emitClassFacts(emitter, member);
  }
  if (isFunction(member)) {
    return emitFunctionFacts(emitter, member, classKey);
  }
  return null;
}

/**
 * A class is an object containing its methods, which is the treatment an
 * object literal gets. That is what lets a method read off an instance
 * resolve to the method the class declares.
 */
function emitClassFacts(emitter: Emitter, cls: PyNode): string {
  const classKey = nodeId(emitter.filePath, cls);
  add(emitter, "objectValue", classKey);

  const bases = field(cls, "superclasses");
  for (const base of bases === null ? [] : children(bases)) {
    add(emitter, "extends", classKey, valueKey(emitter, base));
  }

  const body = field(cls, "body");
  for (const statement of body === null ? [] : children(body)) {
    const member = declaredBy(statement);
    if (member.type === "assignment") {
      const left = field(member, "left");
      const right = field(member, "right");
      if (left !== null && right !== null && left.type === "identifier") {
        add(
          emitter,
          "holdsProperty",
          classKey,
          left.text,
          valueKey(emitter, right),
        );
      }
      continue;
    }
    const memberKey = declaredMemberKey(emitter, member, classKey);
    const name = field(member, "name");
    if (memberKey !== null && name !== null) {
      add(emitter, "holdsProperty", classKey, name.text, memberKey);
    }
  }

  return classKey;
}

/**
 * Every definition written in a scope, each emitted in its own right. The
 * walk stops at one rather than descending, so what is written inside it
 * belongs to it.
 */
function emitNestedDefinitions(emitter: Emitter, node: PyNode): void {
  for (const child of children(node)) {
    if (isFunction(child)) {
      emitFunctionFacts(emitter, child);
      if (emitter.enclosing !== null) {
        add(
          emitter,
          "containsFn",
          emitter.enclosing.funcKey,
          nodeId(emitter.filePath, child),
        );
      }
      continue;
    }
    if (child.type === "class_definition") {
      emitClassFacts(emitter, child);
      continue;
    }
    emitNestedDefinitions(emitter, child);
  }
}

/** One write to a name in a scope, before its value is keyed. */
interface RawWrite {
  /** The expression written, or null when the write states no value of its own. */
  value: PyNode | null;
  /** A value the source spells nowhere, which is what a parameter arrives holding. */
  given: string | null;
  /** The node whose position orders this write among the scope's others. */
  at: PyNode;
  /** Whether the write is a direct statement of the scope's own statement list. */
  direct: boolean;
}

/** What a scope's own statements write, and the names that keeps in the scope. */
interface ScopeReading {
  /** The statement list the writes were read from, or null for a scope with no block. */
  bodyOwner: PyNode | null;
  /** The writes to each name, in source order. */
  writes: Map<string, RawWrite[]>;
  /** Names bound in this scope, which is what a read of one keys to. */
  locals: Set<string>;
  /** Names a `global` statement sends to the module scope. */
  globals: Set<string>;
}

/** Reading a function costs a walk of its body, and every caller asking for a key inside it wants the same answer. */
const readingsByTree = new WeakMap<object, Map<number, ScopeReading>>();

function scopeReadingOf(fn: PyNode): ScopeReading {
  const tree: object = fn.tree;
  let byNode = readingsByTree.get(tree);
  if (byNode === undefined) {
    byNode = new Map();
    readingsByTree.set(tree, byNode);
  }
  const remembered = byNode.get(fn.id);
  if (remembered !== undefined) {
    return remembered;
  }
  const body = field(fn, "body");
  const reading = readScope(
    body !== null && body.type === "block" ? body : null,
    boundParameterNames(fn),
  );
  byNode.set(fn.id, reading);
  return reading;
}

/** The patterns `a, b = ...` and `for k, v in ...` spell an unpacked target with. */
const TARGET_PATTERN_TYPES = new Set([
  "pattern_list",
  "tuple_pattern",
  "list_pattern",
]);

/** Every name a target writes. */
function targetNames(target: PyNode, found: PyNode[] = []): PyNode[] {
  if (target.type === "identifier") {
    found.push(target);
    return found;
  }
  if (TARGET_PATTERN_TYPES.has(target.type)) {
    for (const child of children(target)) {
      targetNames(child, found);
    }
  }
  return found;
}

/** Where a write reader puts what it finds. */
interface WriteSink {
  bodyOwner: PyNode | null;
  record: (name: string, write: RawWrite) => void;
  globals: Set<string>;
  nonlocals: Set<string>;
}

function readAssignment(node: PyNode, sink: WriteSink): void {
  const left = field(node, "left");
  const right = field(node, "right");
  /* v8 ignore start */
  if (left === null) {
    return;
  }
  /* v8 ignore stop */
  const written = right === null ? null : assignedValue(right);
  const names = targetNames(left);
  for (const name of names) {
    sink.record(name.text, {
      // An unpacked target takes one piece of the value, and which piece
      // is not something the assignment says.
      value: names.length === 1 ? written : null,
      given: null,
      at: node,
      direct: isDirectStatement(node, sink.bodyOwner),
    });
  }
}

function readAugmentedAssignment(node: PyNode, sink: WriteSink): void {
  const left = field(node, "left");
  if (left === null || left.type !== "identifier") {
    return;
  }
  sink.record(left.text, {
    value: null,
    given: null,
    at: node,
    direct: isDirectStatement(node, sink.bodyOwner),
  });
}

/** A loop target takes one element per turn, and the element is written nowhere. */
function readIterationTarget(node: PyNode, sink: WriteSink): void {
  const left = field(node, "left");
  /* v8 ignore start */
  if (left === null) {
    return;
  }
  /* v8 ignore stop */
  for (const name of targetNames(left)) {
    sink.record(name.text, {
      value: null,
      given: null,
      at: node,
      direct: false,
    });
  }
}

/** The identifier a node is or starts with, which is how the grammar wraps an `as` target. */
function identifierOf(node: PyNode): PyNode | null {
  if (node.type === "identifier") {
    return node;
  }
  return children(node).find((child) => child.type === "identifier") ?? null;
}

/** `with open(p) as fh` and `except E as err`: what the name takes is the construct's to decide. */
function readAsPattern(node: PyNode, sink: WriteSink): void {
  const target = field(node, "alias") ?? children(node)[1];
  const name = target === undefined ? null : identifierOf(target);
  if (name === null) {
    return;
  }
  sink.record(name.text, {
    value: null,
    given: null,
    at: node,
    direct: false,
  });
}

/** A walrus is written inside an expression, and a condition or a loop decides how often that expression runs. */
function readWalrus(node: PyNode, sink: WriteSink): void {
  const name = field(node, "name");
  if (name === null || name.type !== "identifier") {
    return;
  }
  sink.record(name.text, {
    value: field(node, "value"),
    given: null,
    at: node,
    direct: false,
  });
}

function readGlobalStatement(node: PyNode, sink: WriteSink): void {
  for (const child of children(node)) {
    if (child.type === "identifier") {
      sink.globals.add(child.text);
    }
  }
}

function readNonlocalStatement(node: PyNode, sink: WriteSink): void {
  for (const child of children(node)) {
    if (child.type === "identifier") {
      sink.nonlocals.add(child.text);
    }
  }
}

const WRITE_READERS: Record<string, (node: PyNode, sink: WriteSink) => void> = {
  assignment: readAssignment,
  augmented_assignment: readAugmentedAssignment,
  for_statement: readIterationTarget,
  for_in_clause: readIterationTarget,
  as_pattern: readAsPattern,
  named_expression: readWalrus,
  global_statement: readGlobalStatement,
  nonlocal_statement: readNonlocalStatement,
};

/**
 * Every write a scope's own statements make, in source order. An import is
 * left out on purpose: import facts key a name to the file wherever it is
 * written, so keying a function's import to the function would leave a
 * chain through it with nothing to join on.
 */
function readScope(
  bodyOwner: PyNode | null,
  parameterNames: readonly string[],
): ScopeReading {
  const writes = new Map<string, RawWrite[]>();
  const globals = new Set<string>();
  const nonlocals = new Set<string>();

  const record = (name: string, write: RawWrite): void => {
    const existing = writes.get(name);
    if (existing === undefined) {
      writes.set(name, [write]);
      return;
    }
    existing.push(write);
  };
  const sink: WriteSink = { bodyOwner, globals, nonlocals, record };

  const visit = (node: PyNode): void => {
    if (isFunction(node) || node.type === "class_definition") {
      const name = field(node, "name");
      if (name !== null) {
        record(name.text, {
          value: node,
          given: null,
          at: node,
          direct: isDirectStatement(node, bodyOwner),
        });
      }
      return;
    }
    WRITE_READERS[node.type]?.(node, sink);
    for (const child of children(node)) {
      visit(child);
    }
  };

  for (const statement of bodyOwner === null ? [] : children(bodyOwner)) {
    visit(statement);
  }

  // A declared name is still written here; what changes is the scope the
  // write lands in, and leaving it out of `locals` is what sends it there.
  const locals = new Set(writes.keys());
  for (const name of [...globals, ...nonlocals]) {
    locals.delete(name);
  }
  for (const name of parameterNames) {
    locals.add(name);
    addParameterWrite(writes.get(name), name);
  }

  return { bodyOwner, writes, locals, globals };
}

/** A parameter arrives holding what the caller passed, so a body that writes the name again has to settle against that. */
function addParameterWrite(later: RawWrite[] | undefined, name: string): void {
  const first = later?.[0];
  if (later === undefined || first === undefined) {
    return;
  }
  later.unshift({ value: null, given: name, at: first.at, direct: false });
}

/** The statement a node is written in, which is a child of a block or of the module. */
function statementOf(node: PyNode): PyNode | null {
  let current: PyNode | null = node;
  while (current !== null) {
    const parent: PyNode | null = current.parent;
    if (parent === null) {
      return null;
    }
    if (parent.type === "block" || parent.type === "module") {
      return current;
    }
    current = parent;
  }
  return null;
}

function isDirectStatement(node: PyNode, bodyOwner: PyNode | null): boolean {
  if (bodyOwner === null) {
    return false;
  }
  const statement = statementOf(node);
  return statement !== null && statement.parent?.id === bodyOwner.id;
}

/**
 * Whether the writes run once each, in the order they are written. They do
 * when every one is a statement of the scope's own list, which runs through
 * once top to bottom, and nothing reads the name before the last of them.
 */
function writesRunInOrder(
  bodyOwner: PyNode | null,
  name: string,
  writes: readonly RawWrite[],
): boolean {
  const last = writes[writes.length - 1];
  if (bodyOwner === null || last === undefined) {
    return false;
  }
  if (!writes.every((write) => write.direct)) {
    return false;
  }
  return !isReadBefore(bodyOwner, name, last.at.startIndex);
}

/**
 * Whether a statement before `position` reads the name. A read inside a
 * nested body does not count: that body runs when something calls it,
 * which is after the scope's own statements have finished.
 */
function isReadBefore(
  bodyOwner: PyNode,
  name: string,
  position: number,
): boolean {
  let found = false;
  const visit = (node: PyNode): void => {
    if (found || node.startIndex >= position) {
      return;
    }
    if (isFunction(node) || node.type === "class_definition") {
      return;
    }
    if (node.type === "identifier" && node.text === name) {
      found = isNameRead(node);
      return;
    }
    for (const child of children(node)) {
      visit(child);
    }
  };
  for (const statement of children(bodyOwner)) {
    visit(statement);
  }
  return found;
}

/** Parents that make every name under them something other than a read of it. */
const UNREAD_PARENTS = new Set([
  "as_pattern_target",
  "global_statement",
  "nonlocal_statement",
  "pattern_list",
  "tuple_pattern",
  "list_pattern",
  "dotted_name",
]);

/**
 * The field of its parent a name has to be to be written, declared, or
 * spelled as somebody else's property, rather than read.
 */
const UNREAD_FIELDS: Record<string, string> = {
  assignment: "left",
  augmented_assignment: "left",
  for_statement: "left",
  for_in_clause: "left",
  named_expression: "name",
  function_definition: "name",
  class_definition: "name",
  attribute: "attribute",
  keyword_argument: "name",
};

function isNameRead(name: PyNode): boolean {
  const parent = name.parent;
  if (parent === null) {
    return true;
  }
  if (UNREAD_PARENTS.has(parent.type)) {
    return false;
  }
  const fieldName = UNREAD_FIELDS[parent.type];
  return fieldName === undefined || field(parent, fieldName)?.id !== name.id;
}

/** A value built where it is written, which is what tells two writes of one name apart. */
const CONSTRUCTION_TYPES = new Set([
  "call",
  "list",
  "dictionary",
  "set",
  "tuple",
  "list_comprehension",
  "dictionary_comprehension",
  "set_comprehension",
  "generator_expression",
]);

function describeWrite(emitter: Emitter, write: RawWrite): NameWrite {
  if (write.value === null) {
    return { value: write.given, placeholder: false, construction: null };
  }
  return {
    value: valueKey(emitter, write.value),
    placeholder: write.value.type === "none",
    construction: CONSTRUCTION_TYPES.has(write.value.type)
      ? write.value.text.replace(/\s+/g, " ").trim()
      : null,
  };
}

/**
 * What a name comes down to, or null when the writes leave it undecided. A
 * name written again goes to the shared policy, which is where every
 * adapter decides it.
 */
function settledValue(
  emitter: Emitter,
  reading: ScopeReading,
  name: string,
  writes: readonly RawWrite[],
): string | null {
  const only = writes.length === 1 ? writes[0] : undefined;
  if (only !== undefined) {
    return only.value === null ? only.given : valueKey(emitter, only.value);
  }
  return valueLeftByWrites(
    writes.map((write) => describeWrite(emitter, write)),
    writesRunInOrder(reading.bodyOwner, name, writes),
  );
}

/**
 * One claim per name: `binds` for a name written once, `endsHolding` for a
 * reassigned name the policy settles, and nothing for one it does not. A
 * module's names are also what another file imports back out.
 */
function emitScopeWrites(
  emitter: Emitter,
  reading: ScopeReading,
  atModule: boolean,
): void {
  for (const [name, writes] of reading.writes) {
    const settled = settledValue(emitter, reading, name, writes);
    if (settled === null) {
      continue;
    }
    const key = nameKey(emitter.filePath, emitter.enclosing, name);
    add(emitter, writes.length === 1 ? "binds" : "endsHolding", key, settled);
    if (atModule) {
      add(emitter, "exportsAs", emitter.filePath, name, settled);
    }
  }
}

/**
 * Walk a module and emit the value facts. A nested function is walked in its
 * own right, so a body's returns and calls belong to the function that wrote
 * them.
 */
export function emitValueFacts(
  db: Database,
  filePath: string,
  root: PyNode,
): void {
  const emitter: Emitter = { db, filePath, enclosing: null };
  emitNestedDefinitions(emitter, root);
  emitScopeWrites(emitter, readScope(root, []), true);
  emitExpressionFacts(emitter, root);
}
