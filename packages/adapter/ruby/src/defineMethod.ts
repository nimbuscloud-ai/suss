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
 * turn of the loops around the call, which the value evaluator settles
 * from the run's facts. A name read only in part is kept as a pattern
 * the whole name has to match. Anything less stops every lookup here.
 */

import { force, literalOf, piecesOf } from "@suss/values";

import { bareCalls, bodyStatements, field, OWN_BODY_TYPES } from "./ast.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { Value } from "@suss/values";
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
  /** What a name read only in part has to match for the loop to be defining it. */
  readonly patterns: readonly RegExp[];
  /** Whether some `define_method` in the body was given a method name this reader could not read. */
  readonly unreadable: boolean;
}

const NOTHING: DefinedNames = {
  names: new Set(),
  patterns: [],
  unreadable: false,
};

/** Whether `name` could be one a `define_method` here defines without this reader having read which. */
export function couldBeDefined(defined: DefinedNames, name: string): boolean {
  return (
    defined.unreadable || defined.patterns.some((pattern) => pattern.test(name))
  );
}

const byRun = new WeakMap<object, Map<number, DefinedNames>>();

/**
 * The names `body` defines with `define_method`. Kept per body, since
 * one class is looked up once per call site that reaches it and the
 * answer is the same every time.
 */
export function defineMethodNames(
  body: RbNode,
  facts?: Database,
): DefinedNames {
  const perRun = cacheFor(facts ?? body.tree);
  const cached = perRun.get(body.id);
  if (cached !== undefined) {
    return cached;
  }
  const read = readNames(body, facts);
  perRun.set(body.id, read);
  return read;
}

function cacheFor(owner: object): Map<number, DefinedNames> {
  let perRun = byRun.get(owner);
  if (perRun === undefined) {
    perRun = new Map();
    byRun.set(owner, perRun);
  }
  return perRun;
}

function readNames(body: RbNode, facts: Database | undefined): DefinedNames {
  const calls = bareCalls(body, DEFINE_METHOD_CALL);
  if (calls.length === 0) {
    return NOTHING;
  }
  const names = new Set<string>();
  const patterns: RegExp[] = [];
  let unreadable = false;
  for (const call of calls) {
    const defined = namesDefinedBy(call, facts);
    if (defined === null) {
      unreadable = true;
      continue;
    }
    for (const name of defined.names) {
      names.add(name);
    }
    patterns.push(...defined.patterns);
  }
  return { names, patterns, unreadable };
}

/** What one `define_method` call defines: a name per turn, or the pattern a turn's name matches. Null when a turn gives neither. */
function namesDefinedBy(
  call: RbNode,
  facts: Database | undefined,
): { names: string[]; patterns: RegExp[] } | null {
  const args = field(call, "arguments");
  const first = args === null ? undefined : bodyStatements(args)[0];
  if (first === undefined) {
    return null;
  }
  const names: string[] = [];
  const patterns: RegExp[] = [];
  for (const bindings of loopTurns(call, facts)) {
    const value = evaluatedValue(
      first,
      facts,
      bindings.size === 0 ? undefined : bindings,
    );
    const name = literalOf(value);
    if (name !== null) {
      names.push(name);
      continue;
    }
    const pattern = patternOf(value);
    if (pattern === null) {
      return null;
    }
    patterns.push(pattern);
  }
  return { names, patterns };
}

/**
 * The pattern a partly read name matches: its literal parts in order,
 * with anything at all where a part went unread. Null when no part was
 * read, since such a pattern would match every name.
 */
function patternOf(value: Value): RegExp | null {
  const pieces = piecesOf(value);
  let source = "^";
  let readSomething = false;
  for (const piece of pieces) {
    if (piece.kind === "hole") {
      source += "[\\s\\S]*";
      continue;
    }
    const options = piece.options.filter((option) => option.length > 0);
    if (options.length === 0) {
      continue;
    }
    readSomething = true;
    source += `(?:${options.map(escapeForPattern).join("|")})`;
  }
  return readSomething ? new RegExp(`${source}$`) : null;
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One set of block-parameter bindings per turn of the loops the call is
 * written inside. A block this reader cannot replay contributes no
 * binding, which leaves a name taken from its parameter unread.
 */
function loopTurns(
  call: RbNode,
  facts: Database | undefined,
): ParameterBindings[] {
  let turns: Array<Map<string, string>> = [new Map()];
  for (const taken of blocksAround(call)) {
    const perElement = elementBindings(taken, facts);
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
  facts: Database | undefined,
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
  const elements =
    element === undefined ? null : literalElementsOf(receiver, facts);
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
function literalElementsOf(
  node: RbNode,
  facts: Database | undefined,
): string[] | null {
  const value = evaluatedValue(node, facts);
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
