/**
 * The method names a class body defines with `define_method`.
 *
 * Ruby runs a class body like any other code, so
 * `KEYS.each { |key| define_method(key) { ... } }` defines one method
 * per element of `KEYS`, and a reader of `def` nodes sees none of them.
 * Reading the names lets a lookup for a name none of them defines carry
 * on up the ancestry instead of stopping at the class.
 *
 * A name is read when the argument comes down to one string on every
 * turn of the loops the call is written inside, which the value
 * evaluator settles. Anything else leaves the body with a name this
 * reader could not read, and a lookup on it stops the way it did before.
 */

import { force, literalOf } from "@suss/values";

import { bareCalls, bodyStatements, field, OWN_BODY_TYPES } from "./ast.js";
import { evaluatedValue, stringValueOf } from "./values/evaluator.js";

import type { RbNode } from "./parser.js";
import type { ParameterBindings } from "./values/evaluator.js";

/** Ruby's own dynamic definition. A method defined this way is called like any other and is invisible to a reader of `def` nodes. */
const DEFINE_METHOD_CALL = "define_method";

/** The list methods that run their block once per element, with the element bound to its first parameter. */
const LOOP_METHODS = new Set(["each", "each_with_index", "map"]);

const BLOCK_TYPES = new Set(["block", "do_block"]);

/** What the `define_method` calls in one class body define. */
export interface DefinedNames {
  /** Every name this reader read a `define_method` call as defining. */
  readonly names: ReadonlySet<string>;
  /** Whether some `define_method` in the body was given a method name this reader could not read. */
  readonly unreadable: boolean;
}

const NOTHING: DefinedNames = { names: new Set(), unreadable: false };

const byTree = new WeakMap<object, Map<number, DefinedNames>>();

/**
 * The names `body` defines with `define_method`. Kept per body, since
 * one class is looked up once per call site that reaches it and the
 * answer is the same every time.
 */
export function defineMethodNames(body: RbNode): DefinedNames {
  let perTree = byTree.get(body.tree);
  if (perTree === undefined) {
    perTree = new Map();
    byTree.set(body.tree, perTree);
  }
  const cached = perTree.get(body.id);
  if (cached !== undefined) {
    return cached;
  }
  const read = readNames(body);
  perTree.set(body.id, read);
  return read;
}

function readNames(body: RbNode): DefinedNames {
  const calls = bareCalls(body, DEFINE_METHOD_CALL);
  if (calls.length === 0) {
    return NOTHING;
  }
  const names = new Set<string>();
  let unreadable = false;
  for (const call of calls) {
    const defined = namesDefinedBy(call);
    if (defined === null) {
      unreadable = true;
      continue;
    }
    for (const name of defined) {
      names.add(name);
    }
  }
  return { names, unreadable };
}

/** The names one `define_method` call defines, or null when its first argument does not come down to a string on every turn. */
function namesDefinedBy(call: RbNode): string[] | null {
  const args = field(call, "arguments");
  const first = args === null ? undefined : bodyStatements(args)[0];
  if (first === undefined) {
    return null;
  }
  const names: string[] = [];
  for (const bindings of loopTurns(call)) {
    const name = stringValueOf(
      first,
      undefined,
      bindings.size === 0 ? undefined : bindings,
    );
    if (name === null) {
      return null;
    }
    names.push(name);
  }
  return names;
}

/**
 * One set of block-parameter bindings per turn of the loops the call is
 * written inside. A block this reader cannot replay contributes no
 * binding, which leaves a name taken from its parameter unread.
 */
function loopTurns(call: RbNode): ParameterBindings[] {
  let turns: Array<Map<string, string>> = [new Map()];
  for (const taken of blocksAround(call)) {
    const perElement = elementBindings(taken);
    if (perElement === null) {
      continue;
    }
    turns = turns.flatMap((base) =>
      perElement.map((element) => new Map([...base, ...element])),
    );
  }
  return turns;
}

/** A block written out at a call, `%i(a).each do |key| ... end`. */
interface BlockAtCall {
  readonly block: RbNode;
  readonly call: RbNode;
}

/** The blocks a call is written inside, outermost first. */
function blocksAround(call: RbNode): BlockAtCall[] {
  const blocks: BlockAtCall[] = [];
  let current = call.parent;
  while (current !== null && !OWN_BODY_TYPES.has(current.type)) {
    const parent = current.parent;
    if (BLOCK_TYPES.has(current.type) && parent?.type === "call") {
      blocks.unshift({ block: current, call: parent });
    }
    current = parent;
  }
  return blocks;
}

/** What each turn of a loop over a list of literals binds, or null for any other block. */
function elementBindings(
  taken: BlockAtCall,
): Array<Map<string, string>> | null {
  const { block, call } = taken;
  const receiver = field(call, "receiver");
  const method = field(call, "method")?.text;
  if (receiver === null || method === undefined || !LOOP_METHODS.has(method)) {
    return null;
  }
  const parameters = field(block, "parameters");
  const [element, index] =
    parameters === null
      ? []
      : bodyStatements(parameters).map((parameter) => parameter.text);
  const elements = element === undefined ? null : literalElementsOf(receiver);
  if (element === undefined || elements === null) {
    return null;
  }
  return elements.map((value, position) => {
    const binding = new Map([[element, value]]);
    if (index !== undefined) {
      binding.set(index, String(position));
    }
    return binding;
  });
}

/** The strings a value comes down to when it is a list of them, or null when any element is something else. */
function literalElementsOf(node: RbNode): string[] | null {
  const value = evaluatedValue(node);
  if (value.kind !== "sequence") {
    return null;
  }
  const elements: string[] = [];
  for (const item of value.items) {
    const literal = literalOf(force(item.value));
    if (literal === null) {
      return null;
    }
    elements.push(literal);
  }
  return elements;
}
