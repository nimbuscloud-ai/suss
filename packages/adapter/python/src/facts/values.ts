/**
 * Emits the value facts that the rules in @suss/resolution join, read from
 * Python source. The relations are the ones that package defines, so a
 * Python value is followed by the same rules as a TypeScript one.
 *
 * A name is keyed by the scope that binds it. A function's own names take
 * the function's key, so two handlers that both write `query` stay apart.
 * A module's names take the file's key, and another file's import matches
 * on that key. Every write to a name in one scope is collected in source
 * order, and `valueLeftByWrites` decides what the name comes down to, so a
 * reassigned name gets one value or none, never two.
 */

import {
  NAMED_STORE_NAME,
  RECEIVER_STORE_NAME,
  startsAtName,
  valueLeftByWrites,
  writesRunInOrder,
} from "@suss/resolution";

import { annotationTarget, typeNameOf } from "../annotations.js";
import {
  children,
  enclosingFunction,
  field,
  fields,
  isFunction,
  LATER_BODY_TYPES,
  parameterNameAndType,
  stringLiteralValue,
} from "../ast.js";

import type { Database } from "@suss/datalog";
import type { ChainReads, NameReads, NameWrite } from "@suss/resolution";
import type { Parameter } from "@suss/values";
import type { PyNode } from "../parser.js";

/**
 * A node's identity across the whole run. The end is part of it because a
 * call and its callee start at the same offset.
 */
export function nodeId(filePath: string, node: PyNode): string {
  return `${filePath}:${node.startIndex}-${node.endIndex}`;
}

/**
 * The node a value key was made from, for a caller that has the key the
 * rules settled on and wants the expression back to read something the
 * facts do not record. Null when the key belongs to another file, and
 * then the caller has nothing to read and abstains.
 */
export function nodeAt(
  filePath: string,
  root: PyNode,
  key: string,
): PyNode | null {
  const prefix = `${filePath}:`;
  if (!key.startsWith(prefix)) {
    return null;
  }
  const [start, end] = key
    .slice(prefix.length)
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  // Every key the rules hand back was written by `nodeId`.
  /* v8 ignore start */
  if (start === undefined || end === undefined || Number.isNaN(start * end)) {
    return null;
  }
  /* v8 ignore stop */

  let found = root.descendantForIndex(start, Math.max(start, end - 1));
  while (
    found !== null &&
    (found.startIndex !== start || found.endIndex !== end)
  ) {
    found = found.parent;
  }
  return found;
}

/** The key of a module-level name in a file. Bindings and imports match on it. */
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
  // `a or b` is the exception, stated as the branches it picks between.
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

/** A bare `*` or `/` divides the list into positional-only, ordinary and keyword-only groups; a call never supplies an argument for either. */
const PARAMETER_DIVIDERS = new Set([
  "keyword_separator",
  "positional_separator",
]);

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

/**
 * Each parameter with the expression it defaults to and the position
 * of the argument that fills it, in order. `*args`, `**kwargs` and a
 * bare `*` or `/` are left out; `skip` drops a method's leading
 * receiver from both the list and the count, since a call never
 * writes it.
 */
export function parameterShapes(fn: PyNode, skip = 0): Parameter<PyNode>[] {
  const params = field(fn, "parameters");
  const declared: Parameter<PyNode>[] = [];
  let position = 0;
  for (const param of params === null ? [] : children(params)) {
    if (SPLAT_TYPES.has(param.type) || PARAMETER_DIVIDERS.has(param.type)) {
      continue;
    }
    const name = parameterName(param);
    if (name !== null && position >= skip) {
      declared.push({
        name: name.text,
        default: field(param, "value"),
        position: position - skip,
      });
    }
    position += 1;
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
  /** Names this function binds. A read of one of them is keyed to this function. */
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
  /** Whether the body being walked runs with a receiver, so a call in it has one too. */
  insideMethod: boolean;
  /** Where the walk puts each write to a property of a name the body declares. */
  namedWrites: NamedWrites | null;
}

/**
 * The writes one body makes to a property of a name, `job.retries = 3`,
 * grouped by the name's key and the property.
 */
interface NamedWrites {
  body: PyNode;
  /** Whether the body declares the name, which is the only case its writes are settled here. */
  declares: (name: string) => boolean;
  byProperty: Map<
    string,
    { receiverKey: string; property: string; writes: ReceiverWrite[] }
  >;
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

/**
 * The key of a call's callee. `call` and `bodyCalls` both state it, and
 * the rules take the two for the same value, so both read it here.
 */
function calleeKey(emitter: Emitter, call: PyNode): string | null {
  const callee = field(call, "function");
  return callee === null ? null : valueKey(emitter, callee);
}

/** The callee of a call, and the arguments it passes by position. */
function emitCall(emitter: Emitter, call: PyNode): void {
  // A call is written out in the source, so a name bound to one ends its
  // chain there. The rules decide what a factory call comes to, so it gets
  // no `comesTo` here, and `isWrittenAs` reads it back.
  add(emitter, "writtenValue", nodeId(emitter.filePath, call));

  const callee = calleeKey(emitter, call);
  const args = field(call, "arguments");
  // The grammar writes both fields on every call.
  /* v8 ignore start */
  if (callee === null || args === null) {
    return;
  }
  /* v8 ignore stop */
  const callKey = nodeId(emitter.filePath, call);
  add(emitter, "call", callKey, callee);
  if (!emitter.insideMethod) {
    add(emitter, "callOutsideMethod", callKey);
  }
  add(emitter, "callArgCount", callKey, String(writtenArgumentCount(args)));

  for (const argument of callArguments(call)) {
    if (argument.kind === "keyword") {
      add(
        emitter,
        "callKeywordArg",
        callKey,
        argument.name,
        valueKey(emitter, argument.node),
      );
      continue;
    }
    add(
      emitter,
      "callArg",
      callKey,
      String(argument.position),
      valueKey(emitter, argument.node),
    );
  }
}

/** One argument a call writes out, under the position or the name `passesArgument` joins it to a parameter on. */
export type CallArgument =
  | { kind: "positional"; position: number; node: PyNode }
  | { kind: "keyword"; name: string; node: PyNode };

/**
 * The arguments a call writes out, in source order. The facts are keyed
 * through this too, so a caller looking for the argument at a parameter
 * never disagrees with them about which one is at position 1.
 *
 * `*args` and `**kwargs` fill parameters the call does not identify, so
 * neither counts as an argument here. A positional argument after `*args`
 * has no position that can be counted, so it is left out too.
 */
export function callArguments(call: PyNode): CallArgument[] {
  const args = field(call, "arguments");
  if (args === null) {
    return [];
  }
  const written: CallArgument[] = [];
  let position: number | null = 0;
  for (const argument of children(args)) {
    if (argument.type === "keyword_argument") {
      const name = field(argument, "name");
      const value = field(argument, "value");
      if (name !== null && value !== null) {
        written.push({ kind: "keyword", name: name.text, node: value });
      }
      continue;
    }
    if (argument.type === "list_splat") {
      position = null;
      continue;
    }
    if (NOT_AN_ARGUMENT.has(argument.type) || position === null) {
      continue;
    }
    written.push({ kind: "positional", position, node: argument });
    position += 1;
  }
  return written;
}

/** Written in an argument list without taking a position of its own. */
const NOT_AN_ARGUMENT = new Set(["dictionary_splat", "comment"]);

/**
 * How many arguments a call writes, whatever their kind. `f(x for x in y)`
 * passes a generator with no list around it, which is one.
 */
function writtenArgumentCount(args: PyNode): number {
  if (args.type !== "argument_list") {
    return 1;
  }
  return children(args).filter((child) => child.type !== "comment").length;
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

/**
 * The key the class an annotation writes joins on, past the wrappers
 * that do not change which class it is. A dotted class is keyed on its
 * own node, with the property reads the rules follow to its module.
 */
function statedTypeKey(emitter: Emitter, annotation: PyNode): string | null {
  const target = annotationTarget(annotation);
  if (target?.type === "attribute") {
    emitExpressionFact(emitter, target);
    emitExpressionFacts(emitter, target);
    return nodeId(emitter.filePath, target);
  }
  return target === null ? null : classReferenceKey(emitter, target);
}

/** `name: T` on a parameter or an assignment says the name is one of T. */
function emitStatedType(
  emitter: Emitter,
  nameKey: string,
  annotation: PyNode | null,
): void {
  const typeKey =
    annotation === null ? null : statedTypeKey(emitter, annotation);
  if (typeKey !== null) {
    add(emitter, "instanceOf", nameKey, typeKey);
  }
}

/** Whether a statement is written in a class body, where a name it assigns is a field of the class. */
function writtenInClassBody(statement: PyNode): boolean {
  for (let at = statement.parent; at !== null; at = at.parent) {
    if (at.type === "class_definition") {
      return true;
    }
    if (isFunction(at)) {
      return false;
    }
  }
  return false;
}

/** `name: T = value` in a function or a module. */
function emitAssignedType(emitter: Emitter, assignment: PyNode): void {
  const left = field(assignment, "left");
  const annotation = field(assignment, "type");
  if (
    left?.type !== "identifier" ||
    annotation === null ||
    writtenInClassBody(assignment)
  ) {
    return;
  }
  emitStatedType(emitter, valueKey(emitter, left), annotation);
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

/** A key the source writes out, which `readsProperty` covers instead. */
const WRITTEN_KEY_TYPES = new Set(["string", "integer", "concatenated_string"]);

/**
 * `settings[name]` and `settings.get(name)`: the container, and the
 * expression the key comes from. The rules decide which containers are
 * the environment, so this records every keyed read whatever the container.
 */
function emitKeyedRead(
  emitter: Emitter,
  site: PyNode,
  container: PyNode,
  key: PyNode,
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

/** The subscript of `a[i]`, when the source writes exactly one. */
function singleSubscript(node: PyNode): PyNode | null {
  const written = fields(node, "subscript");
  return written.length === 1 ? (written[0] ?? null) : null;
}

/** The container and key of `d.get(name)`, the mapping read written as a call. */
function mappingGetRead(
  call: PyNode,
): { container: PyNode; key: PyNode } | null {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "attribute") {
    return null;
  }
  const container = field(callee, "object");
  if (container === null || field(callee, "attribute")?.text !== "get") {
    return null;
  }
  const first = callArguments(call).find(
    (argument) => argument.kind === "positional" && argument.position === 0,
  );
  return first === undefined ? null : { container, key: first.node };
}

/**
 * The two sides of `a or b`, whose value is one of them, or null for any
 * other expression. `a and b` stays a written value, because its left
 * side is the value only when that side is falsy.
 */
function fallbackBranchesOf(node: PyNode): PyNode[] | null {
  if (
    node.type !== "boolean_operator" ||
    field(node, "operator")?.text !== "or"
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

/** What one expression says about itself, whichever walk reached it. */
function emitExpressionFact(emitter: Emitter, child: PyNode): void {
  if (child.type === "call") {
    emitCall(emitter, child);
    const mapping = mappingGetRead(child);
    if (mapping !== null) {
      emitKeyedRead(emitter, child, mapping.container, mapping.key);
    }
  }
  if (child.type === "subscript") {
    const index = singleSubscript(child);
    const container = field(child, "value");
    if (index !== null && container !== null) {
      emitKeyedRead(emitter, child, container, index);
    }
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
  if (child.type === "assignment") {
    emitAssignedType(emitter, child);
    collectNamedWrite(emitter, child);
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
 * makes. The caller records where the function's name is bound, because a
 * method belongs to its class and a def belongs to its module.
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
    if (SPLAT_TYPES.has(param.type) || param.type === "keyword_separator") {
      // What follows a `*` can only be passed by name.
      byPosition = false;
      continue;
    }
    if (param.type === "positional_separator") {
      continue;
    }
    const paramName = parameterName(param);
    if (paramName !== null) {
      const paramKey = `${funcKey}#${paramName.text}`;
      if (byPosition && position >= 0) {
        add(emitter, "paramOf", funcKey, String(position), paramKey);
      }
      // The receiver is an instance of the class, so a value one method
      // stores on it reaches a read in another method.
      if (classKey !== undefined && position === -1) {
        receiver = { classKey, name: paramName.text };
        add(emitter, "instanceOf", paramKey, classKey);
      }
      add(emitter, "paramNamed", funcKey, paramName.text, paramKey);
      // The annotation is read in the scope around the function.
      emitStatedType(
        emitter,
        paramKey,
        parameterNameAndType(param)?.typeNode ?? null,
      );
    }
    position += 1;
  }

  const reading = scopeReadingOf(fn);
  const body = field(fn, "body");
  const parameters = new Set(boundParameterNames(fn));
  const inside: Emitter = {
    ...emitter,
    // A def written in a class takes a receiver or it does not, and a
    // def nested in a method runs as part of the method around it.
    insideMethod:
      classKey === undefined ? emitter.insideMethod : receiver !== null,
    enclosing: {
      funcKey,
      locals: reading.locals,
      globals: reading.globals,
      parent: emitter.enclosing,
    },
    // A parameter leads to no object the rules can find, so a write
    // through one is left out along with a write through an outer name.
    namedWrites:
      body === null
        ? null
        : {
            body,
            declares: (name) =>
              reading.locals.has(name) && !parameters.has(name),
            byProperty: new Map(),
          },
  };
  emitScopeWrites(inside, reading, false);

  /* v8 ignore start */
  if (body === null) {
    return funcKey;
  }
  /* v8 ignore stop */

  emitNestedDefinitions(inside, body);

  // One walk for both, since this function's own facts and the expression
  // facts want the same nodes and the walk is the expensive part.
  let statesReturn = false;
  const stores = new Map<string, ReceiverWrite[]>();
  const visit = (child: PyNode): void => {
    if (child.type === "return_statement") {
      const returned = child.namedChildren[0];
      if (returned != null) {
        add(inside, "returnsValue", funcKey, valueKey(inside, returned));
        statesReturn = true;
      }
    }
    const callee = child.type === "call" ? calleeKey(inside, child) : null;
    if (callee !== null) {
      add(inside, "bodyCalls", funcKey, callee);
      add(inside, "makesCall", funcKey, nodeId(inside.filePath, child));
    }
    if (child.type === "assignment" && receiver !== null) {
      collectReceiverProperty(inside, child, receiver, body, stores);
    }
    emitExpressionFact(inside, child);
  };
  // A lambda's body is one expression rather than a block, and the walk
  // below reaches only that expression's children.
  if (fn.type === "lambda") {
    visit(body);
  }
  walkExpressions(inside, body, visit);
  emitReceiverStores(inside, funcKey, body, stores);
  emitNamedStores(inside);

  if (!statesReturn) {
    emitReturnAnnotation(emitter, fn, funcKey);
  }
  emitReturnName(emitter, fn, funcKey);

  return funcKey;
}

/**
 * What a function's signature says it gives back, read only when its
 * body stated nothing, so a caller never gets two different results for
 * one function. The name is bound in the scope around the function.
 */
function emitReturnAnnotation(
  emitter: Emitter,
  fn: PyNode,
  funcKey: string,
): void {
  const annotated = returnedClass(field(fn, "return_type") ?? undefined);
  if (annotated === null) {
    return;
  }
  const classKey = classReferenceKey(emitter, annotated);
  if (classKey !== null) {
    add(emitter, "returnsClass", funcKey, classKey);
  }
}

/**
 * The name a function's return annotation is written under, whatever its
 * body returns. A method that says it returns `Query` and builds one
 * itself is how a pack finds a query that starts in the project.
 */
function emitReturnName(emitter: Emitter, fn: PyNode, funcKey: string): void {
  const annotation = field(fn, "return_type");
  const written = annotation === null ? null : typeNameOf(annotation);
  if (written !== null) {
    add(emitter, "returnsNamed", funcKey, written);
  }
}

/** One `self.name = value` or `job.name = value`, with what orders it against the others in the body. */
interface ReceiverWrite {
  write: NameWrite;
  /** The property as the source writes it, `self.name`, so reads of it can be matched against it. */
  spelling: string;
  at: PyNode;
  /** Whether the write is a direct statement of the method's own statement list. */
  direct: boolean;
}

/**
 * `self.name = value` inside a method, kept until the body has been read
 * so two writes to one name settle against each other.
 */
function collectReceiverProperty(
  emitter: Emitter,
  assignment: PyNode,
  receiver: MethodReceiver,
  body: PyNode,
  stores: Map<string, ReceiverWrite[]>,
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
  const written = stores.get(property.text) ?? [];
  written.push({
    write: describeWrite(
      emitter,
      { value: right, given: null, at: assignment, direct: false },
      property.text,
    ),
    spelling: left.text,
    at: left,
    direct: isDirectStatement(assignment, body),
  });
  stores.set(property.text, written);
}

/**
 * What each property a method writes ends up with. Writes the body runs
 * one after another settle on the last; anything a branch or a loop
 * decides gives one value per write, and a reader that needs a single
 * answer sees more than one source.
 */
function emitReceiverStores(
  emitter: Emitter,
  funcKey: string,
  body: PyNode,
  stores: ReadonlyMap<string, ReceiverWrite[]>,
): void {
  for (const [name, writes] of stores) {
    const spelling = writes[0]?.spelling ?? name;
    const settled = valueLeftByWrites(
      writes.map((written) => written.write),
      writesRunInOrder(body, spelling, writes, ATTRIBUTE_READS),
    );
    if (settled !== null) {
      add(
        emitter,
        "storesProperty",
        funcKey,
        name,
        settled,
        RECEIVER_STORE_NAME,
      );
      continue;
    }
    for (const { write } of writes) {
      if (write.value !== null && !write.narrowsName) {
        add(
          emitter,
          "storesProperty",
          funcKey,
          name,
          write.value,
          RECEIVER_STORE_NAME,
        );
      }
    }
  }
}

/**
 * `job.retries = 3`, in a body that declares `job`, noted for
 * `emitNamedStores`. A write through `self` is the method's own store.
 */
function collectNamedWrite(emitter: Emitter, assignment: PyNode): void {
  const collected = emitter.namedWrites;
  const left = field(assignment, "left");
  const right = field(assignment, "right");
  if (collected === null || left?.type !== "attribute" || right === null) {
    return;
  }
  const object = field(left, "object");
  const property = field(left, "attribute");
  if (
    object?.type !== "identifier" ||
    property === null ||
    !collected.declares(object.text)
  ) {
    return;
  }
  const receiverKey = valueKey(emitter, object);
  const key = `${receiverKey} ${property.text}`;
  const group = collected.byProperty.get(key) ?? {
    receiverKey,
    property: property.text,
    writes: [],
  };
  group.writes.push({
    write: describeWrite(
      emitter,
      { value: right, given: null, at: assignment, direct: false },
      property.text,
    ),
    spelling: left.text,
    at: left,
    direct: isDirectStatement(assignment, collected.body),
  });
  collected.byProperty.set(key, group);
}

/**
 * What each property a body writes through a name ends up with. It is
 * stated only when the writes settle the way a reassigned name's do,
 * since a rule cannot tell a read before the write from one after it.
 */
function emitNamedStores(emitter: Emitter): void {
  const collected = emitter.namedWrites;
  if (collected === null) {
    return;
  }
  for (const group of collected.byProperty.values()) {
    const spelling = group.writes[0]?.spelling ?? group.property;
    const settled = valueLeftByWrites(
      group.writes.map((written) => written.write),
      writesRunInOrder(collected.body, spelling, group.writes, ATTRIBUTE_READS),
    );
    if (settled !== null) {
      add(
        emitter,
        "storesProperty",
        group.receiverKey,
        group.property,
        settled,
        NAMED_STORE_NAME,
      );
    }
  }
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

/** The side of `Item | None` that is not None, or null when neither side is None. */
function sideBesidesNone(node: PyNode): PyNode | null {
  const left = field(node, "left");
  const right = field(node, "right");
  if (right?.type === "none") {
    return left;
  }
  if (left?.type === "none") {
    return right;
  }
  return null;
}

/**
 * The class an annotation is about, with the wrappers an ORM writes a
 * relationship inside taken off: `list[Item]`, `Optional[Item]`,
 * `Mapped[list["Item"]]` and `Item | None` are each about Item. A
 * forward reference comes back as the string it is written as.
 */
function annotatedClass(node: PyNode | undefined): PyNode | null {
  if (node === undefined) {
    return null;
  }
  if (node.type === "identifier" || node.type === "string") {
    return node;
  }
  if (node.type === "type") {
    return annotatedClass(children(node)[0]);
  }
  if (node.type === "generic_type") {
    const parameter = children(node).find(
      (child) => child.type === "type_parameter",
    );
    return annotatedClass(
      parameter === undefined ? undefined : children(parameter)[0],
    );
  }
  if (node.type === "binary_operator") {
    return annotatedClass(sideBesidesNone(node) ?? undefined);
  }
  return null;
}

/**
 * The generics a return annotation is read through. Everything else,
 * `list[Item]` included, hands the caller the container rather than the
 * Item, so the annotation says nothing about what a method call on the
 * result would find.
 */
const RETURN_WRAPPERS = new Set(["Optional", "Awaitable"]);

/**
 * The class a return annotation is about, or null when the annotation is
 * about no single class. A dotted name comes back as the attribute so
 * the caller can read its text, and a forward reference as the string.
 */
function returnedClass(node: PyNode | undefined): PyNode | null {
  if (node === undefined) {
    return null;
  }
  if (
    node.type === "identifier" ||
    node.type === "attribute" ||
    node.type === "string"
  ) {
    return node;
  }
  if (node.type === "type") {
    return returnedClass(children(node)[0]);
  }
  if (node.type === "generic_type") {
    return returnedClass(unwrappedReturnParameter(node));
  }
  if (node.type === "binary_operator") {
    return returnedClass(sideBesidesNone(node) ?? undefined);
  }
  return null;
}

/** What `Optional[Item]` and `Awaitable[Item]` are about; nothing for any other generic. */
function unwrappedReturnParameter(generic: PyNode): PyNode | undefined {
  const base = children(generic)[0];
  if (base === undefined || !RETURN_WRAPPERS.has(base.text)) {
    return undefined;
  }
  const parameter = children(generic).find(
    (child) => child.type === "type_parameter",
  );
  return parameter === undefined ? undefined : children(parameter)[0];
}

/**
 * The key a reference to a class joins on. A forward reference in quotes
 * gets the key the same name written bare would have, so the imports
 * behind it settle it the same way.
 */
function classReferenceKey(emitter: Emitter, node: PyNode): string | null {
  if (node.type === "identifier") {
    return valueKey(emitter, node);
  }
  const written = stringLiteralValue(node);
  if (written === null) {
    return null;
  }
  return nameKey(emitter.filePath, emitter.enclosing, written);
}

/** The first argument a call is given by position, or null when everything it is given is a keyword. */
function firstPositional(call: PyNode): PyNode | null {
  const args = field(call, "arguments");
  for (const argument of args === null ? [] : children(args)) {
    if (argument.type !== "keyword_argument") {
      return argument;
    }
  }
  return null;
}

/** The class a field is about: its annotation, or the class the call is given. */
function fieldClassKey(
  emitter: Emitter,
  assignment: PyNode,
  call: PyNode,
): string | null {
  const annotation = field(assignment, "type");
  const annotated = annotation === null ? null : annotatedClass(annotation);
  if (annotated !== null) {
    return classReferenceKey(emitter, annotated);
  }
  const first = firstPositional(call);
  return first === null ? null : classReferenceKey(emitter, first);
}

/**
 * A class-body field assigned from a call, with the callee and the class
 * the field refers to. A pack declares which callees make a field an
 * association and the rules do the matching, so this records every one.
 */
function emitFieldCall(
  emitter: Emitter,
  classKey: string,
  name: string,
  assignment: PyNode,
  value: PyNode,
): void {
  if (value.type !== "call") {
    return;
  }
  const callee = field(value, "function");
  const target =
    callee === null ? null : fieldClassKey(emitter, assignment, value);
  if (callee === null || target === null) {
    return;
  }
  add(emitter, "fieldCall", classKey, name, valueKey(emitter, callee), target);
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
 * The name a base is written as, for the ones a pack can match on: a
 * plain name and a dotted one. A class list can also contain
 * `table=True` or a generic's subscript, which nobody extends.
 */
function writtenBaseName(base: PyNode): string | null {
  return base.type === "identifier" || base.type === "attribute"
    ? base.text
    : null;
}

/** The method Python runs on a new instance. */
const INIT_METHOD = "__init__";

/**
 * How a class-body assignment is recorded. `TABLE = "orders"` is one
 * value every instance shares. `name: str = "x"` is a field default in
 * a dataclass, a pydantic model or an attrs class, and the constructor
 * those libraries generate lets each construction give its own. On a
 * plain class it is shared like `TABLE`, and the rules read it that way
 * once `plainClass` and `extendsOnly` show the class is plain.
 */
function classBodyValueRelation(assignment: PyNode): string {
  return field(assignment, "type") === null ? "holdsProperty" : "holdsDefault";
}

/** The base Python gives a class written without one. */
const IMPLICIT_BASE = "object";

/**
 * Records a class that nothing can generate a constructor for, when its
 * own statement shows that. Any decorator could be `@dataclass` under
 * another name, and a keyword such as `metaclass=` or a second base
 * could come from a library that builds one, so each of those leaves the
 * class unrecorded. A single base is left to the rules, which can tell
 * whether it is a plain class of the project's own.
 */
function emitPlainness(emitter: Emitter, cls: PyNode, classKey: string): void {
  if (cls.parent?.type === "decorated_definition") {
    return;
  }

  const bases = field(cls, "superclasses");
  const written = (bases === null ? [] : children(bases)).filter(
    (base) => base.type !== "comment",
  );
  const [only] = written;
  if (only === undefined) {
    add(emitter, "plainClass", classKey);
    return;
  }

  if (written.length > 1 || writtenBaseName(only) === null) {
    return;
  }

  if (only.type === "identifier" && only.text === IMPLICIT_BASE) {
    add(emitter, "plainClass", classKey);
    return;
  }

  add(emitter, "extendsOnly", classKey, valueKey(emitter, only));
}

/**
 * A class is recorded as an object containing its methods, the same as an
 * object literal, so a method read off an instance resolves to the one the
 * class declares.
 */
function emitClassFacts(emitter: Emitter, cls: PyNode): string {
  const classKey = nodeId(emitter.filePath, cls);
  add(emitter, "objectValue", classKey);

  const bases = field(cls, "superclasses");
  for (const base of bases === null ? [] : children(bases)) {
    add(emitter, "extends", classKey, valueKey(emitter, base));
    const written = writtenBaseName(base);
    if (written !== null) {
      add(emitter, "extendsNamed", classKey, written);
    }
  }
  emitPlainness(emitter, cls, classKey);

  const body = field(cls, "body");
  const statements = body === null ? [] : children(body);
  const accessed = accessorNames(statements);
  for (const statement of statements) {
    const member = declaredBy(statement);
    if (member.type === "assignment") {
      const left = field(member, "left");
      const right = field(member, "right");
      if (left !== null && right !== null && left.type === "identifier") {
        add(
          emitter,
          classBodyValueRelation(member),
          classKey,
          left.text,
          valueKey(emitter, right),
        );
        emitFieldCall(emitter, classKey, left.text, member, right);
      }
      continue;
    }
    const memberKey = declaredMemberKey(emitter, member, classKey);
    const name = field(member, "name");
    if (memberKey !== null && name !== null) {
      for (const held of readUnderName(
        emitter,
        statement,
        memberKey,
        accessed,
      )) {
        add(emitter, "holdsProperty", classKey, name.text, held);
      }
      if (name.text === INIT_METHOD) {
        add(emitter, "initializes", classKey, memberKey);
      }
    }
  }

  return classKey;
}

/** The decorators that make a def a property, as the source spells them. */
const PROPERTY_DECORATORS = new Set([
  "@property",
  "@cached_property",
  "@functools.cached_property",
]);

/** `@name.setter` and its siblings, on the def that replaces one part of a property. */
const ACCESSOR_PART = /^@(\w+)\.(setter|deleter|getter)$/;

function decoratorsOf(statement: PyNode): string[] {
  return statement.type === "decorated_definition"
    ? children(statement)
        .filter((child) => child.type === "decorator")
        .map((child) => child.text)
    : [];
}

/**
 * Each name a def in the class body writes a setter, deleter or getter
 * for. A getter under a decorator the adapter does not know, such as a
 * library's own kind of property, is still a getter when a setter for
 * its name follows it.
 */
function accessorNames(statements: readonly PyNode[]): Set<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    for (const decorator of decoratorsOf(statement)) {
      const part = ACCESSOR_PART.exec(decorator);
      if (part?.[1] !== undefined) {
        names.add(part[1]);
      }
    }
  }
  return names;
}

/**
 * What a read of a def's name finds on the class. For a plain method that
 * is the function. Reading a property runs its getter, so a read finds
 * what the getter returns, and never the setter or the deleter.
 */
function readUnderName(
  emitter: Emitter,
  statement: PyNode,
  funcKey: string,
  accessed: ReadonlySet<string>,
): string[] {
  const decorators = decoratorsOf(statement);
  const part = decorators
    .map((decorator) => ACCESSOR_PART.exec(decorator)?.[2])
    .find((found) => found !== undefined);
  if (part === "setter" || part === "deleter") {
    return [];
  }
  const name = field(declaredBy(statement), "name")?.text ?? "";
  const getter =
    part === "getter" ||
    accessed.has(name) ||
    decorators.some((decorator) => PROPERTY_DECORATORS.has(decorator));
  if (!getter) {
    return [funcKey];
  }
  return emitter.db
    .lookup("returnsValue", 0, funcKey)
    .map((row) => String(row[1]));
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
  /** A value the source never writes out, such as the argument a parameter receives. */
  given: string | null;
  /** The node whose position orders this write among the scope's others. */
  at: PyNode;
  /** Whether the write is a direct statement of the scope's own statement list. */
  direct: boolean;
  /** The call a `with` opened, when this write is the `as` target of one. */
  entered?: PyNode;
}

/** What a scope's own statements write, and which names are local to it. */
interface ScopeReading {
  /** The statement list the writes were read from, or null for a scope with no block. */
  bodyOwner: PyNode | null;
  /** The writes to each name, in source order. */
  writes: Map<string, RawWrite[]>;
  /** Names bound in this scope. A read of one of them is keyed to this scope. */
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

/** The node types of an unpacked target, as in `a, b = ...` and `for k, v in ...`. */
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

/**
 * `with open(p) as fh` and `except E as err`: the construct decides what
 * the name gets. Only a pack knows whether `__enter__` returns the call's
 * own object, so this records the call and leaves that to the pack.
 */
function readAsPattern(node: PyNode, sink: WriteSink): void {
  const target = field(node, "alias") ?? children(node)[1];
  const name = target === undefined ? null : identifierOf(target);
  if (name === null) {
    return;
  }
  const opened = children(node)[0];
  const namesOneThing = target !== undefined && target.text === name.text;
  sink.record(name.text, {
    value: null,
    given: null,
    at: node,
    direct: false,
    ...(namesOneThing && opened?.type === "call" ? { entered: opened } : {}),
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

  // A `global` or `nonlocal` name is still written here, but the write goes
  // to an outer scope. Leaving the name out of `locals` sends it there.
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

/** A parameter starts with whatever the caller passed, so a later write to the name in the body settles against that. */
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

/** The part of an expression that is read first, for the two ways a chain is written. */
const READ_FIRST: Record<string, string> = {
  call: "function",
  attribute: "object",
};

function readFirst(node: PyNode): PyNode | null {
  if (node.type === "parenthesized_expression") {
    return children(node)[0] ?? null;
  }
  const fieldName = READ_FIRST[node.type];
  return fieldName === undefined ? null : field(node, fieldName);
}

/** What the shared name walks need to know about Python's grammar. */
const NAME_READS: NameReads<PyNode> & ChainReads<PyNode> = {
  nameTypes: new Set(["identifier"]),
  laterBodies: LATER_BODY_TYPES,
  childrenOf: children,
  isRead: isNameRead,
  readFirst,
};

/** The same walk over `self.name` or `job.name`, which is an attribute rather than a name. */
const ATTRIBUTE_READS: NameReads<PyNode> = {
  ...NAME_READS,
  nameTypes: new Set(["attribute"]),
};

/** A value built where it is written. Two writes of one name that build different values can be told apart. */
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

function describeWrite(
  emitter: Emitter,
  write: RawWrite,
  name: string,
): NameWrite {
  if (write.value === null) {
    return {
      value: write.given,
      placeholder: false,
      construction: null,
      narrowsName: false,
    };
  }
  return {
    value: valueKey(emitter, write.value),
    placeholder: write.value.type === "none",
    construction: CONSTRUCTION_TYPES.has(write.value.type)
      ? write.value.text.replace(/\s+/g, " ").trim()
      : null,
    narrowsName:
      write.value.type === "call" &&
      startsAtName(write.value, name, NAME_READS),
  };
}

/**
 * What a name comes down to, or null when the writes leave it undecided. A
 * name written more than once goes to the shared policy in @suss/resolution,
 * so every adapter settles it the same way.
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
    writes.map((write) => describeWrite(emitter, write, name)),
    writesRunInOrder(reading.bodyOwner, name, writes, NAME_READS),
  );
}

/**
 * One fact per name: `binds` for a name written once, and `endsHolding` for
 * a reassigned name the policy settles. A module-level name also gets
 * `exportsAs`, since another file can import it.
 *
 * For a name the policy leaves undecided, each write's value is recorded
 * instead, so a reader can tell two sources from none.
 */
function emitScopeWrites(
  emitter: Emitter,
  reading: ScopeReading,
  atModule: boolean,
): void {
  for (const [name, writes] of reading.writes) {
    const settled = settledValue(emitter, reading, name, writes);
    const key = nameKey(emitter.filePath, emitter.enclosing, name);
    if (settled === null) {
      emitCandidates(emitter, key, name, writes);
      continue;
    }
    add(emitter, writes.length === 1 ? "binds" : "endsHolding", key, settled);
    if (atModule) {
      add(emitter, "exportsAs", emitter.filePath, name, settled);
    }
  }
}

/**
 * Each value a write put in an unsettled name. A write that narrows the
 * name is left out. A write with no value of its own, such as a loop target
 * or an `except ... as`, is recorded as `writesUnstated`. `writesAllStated`
 * records the opposite case, where every write had a value the run read.
 */
function emitCandidates(
  emitter: Emitter,
  key: string,
  name: string,
  writes: readonly RawWrite[],
): void {
  let unstated = false;
  let stated = 0;
  for (const write of writes) {
    if (write.value === null) {
      // The name a `with` opens is the call's `__enter__`, which is a
      // value the source states rather than one it left out.
      if (write.entered !== undefined) {
        add(emitter, "entersAs", key, valueKey(emitter, write.entered));
        continue;
      }
      // A parameter's value comes from the caller, and no fact here
      // says whether a later write always replaces it, so the writes
      // the run did read are not the whole set.
      unstated = true;
      if (write.given === null) {
        add(emitter, "writesUnstated", key);
      }
      continue;
    }
    if (!describeWrite(emitter, write, name).narrowsName) {
      add(emitter, "mayHold", key, valueKey(emitter, write.value));
      stated += 1;
    }
  }
  if (!unstated && stated > 0) {
    add(emitter, "writesAllStated", key);
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
  const emitter: Emitter = {
    db,
    filePath,
    enclosing: null,
    insideMethod: false,
    // Every name read at the top of a module belongs to the module.
    namedWrites: { body: root, declares: () => true, byProperty: new Map() },
  };
  emitNestedDefinitions(emitter, root);
  emitScopeWrites(emitter, readScope(root, []), true);
  emitExpressionFacts(emitter, root);
  emitNamedStores(emitter);
}
