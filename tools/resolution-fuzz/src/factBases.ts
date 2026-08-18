/**
 * Generated fact bases, built the way a program is built.
 *
 * Random tuples over random node ids derive nothing: the rules are
 * joins, and unrelated ids never join. So a base is assembled out of
 * constructs a language has, each one emitting the facts an adapter
 * would emit for it, and each one drawing what it needs from what the
 * constructs before it produced. That is what turns a base into chains,
 * which is what the rules are about following.
 *
 * The README beside this file lists the constructs and says how the
 * weights were chosen.
 */

import { seededRandom } from "./seededRandom.js";

import type { Random } from "./seededRandom.js";

/** One fact: a relation name and its atoms, all strings. */
export type Fact = readonly [string, ...string[]];

export interface FactBase {
  /** Which stream of the run seed produced it. */
  readonly index: number;
  readonly facts: readonly Fact[];
}

/**
 * Small universes, so that two constructs picking a module or a property
 * name independently still pick the same one often enough to join.
 */
const MODULES = ["lib", "core", "app"];
const PROPERTY_NAMES = ["handle", "run", "value"];
const EXPORT_NAMES = ["main", "make", "handler"];
const ARG_NAMES = ["first", "second"];
const WRAPPER_NAMES = ["withAuth", "route"];

interface Program {
  readonly facts: Fact[];
  readonly seen: Set<string>;
  /** Anything that can stand where a value goes. */
  readonly values: string[];
  readonly functions: string[];
  readonly objects: string[];
  /** The positions each function declares a parameter at. */
  readonly positions: Map<string, string[]>;
  /** (module, name) pairs some module really exports. */
  readonly exports: Array<readonly [string, string]>;
  /** Property names an object in this base was given. */
  readonly held: string[];
  /** Names that came from a module, which is where `comesFrom` ends. */
  readonly imported: string[];
  counter: number;
}

const id = (p: Program, prefix: string): string => {
  p.counter += 1;
  return `${prefix}${p.counter}`;
};

/** Add a fact, and say nothing twice. */
function say(p: Program, ...fact: Fact): void {
  const key = fact.join(" ");
  if (p.seen.has(key)) {
    return;
  }
  p.seen.add(key);
  p.facts.push(fact);
}

const asValue = (p: Program, node: string): string => {
  p.values.push(node);
  return node;
};

/** Declare a parameter, and remember the position for a caller to fill. */
function declareParam(p: Program, f: string, position: string): string {
  const param = asValue(p, id(p, "arg"));
  say(p, "paramOf", f, position, param);
  p.positions.set(f, [...(p.positions.get(f) ?? []), position]);
  return param;
}

/** A function declaration, with up to two parameters. */
function declareFunction(p: Program, rnd: Random): void {
  const f = asValue(p, id(p, "fn"));
  say(p, "func", f);
  p.functions.push(f);
  const arity = rnd.below(3);
  for (let k = 0; k < arity; k += 1) {
    const param = declareParam(p, f, String(k));
    if (rnd.chance(0.4)) {
      say(p, "paramNamed", f, rnd.pick(ARG_NAMES), param);
    }
  }
}

/** An object or class written out, with one or two properties. */
function declareObject(p: Program, rnd: Random): void {
  const o = id(p, "obj");
  say(p, "objectValue", o);
  const properties = 1 + rnd.below(2);
  for (let i = 0; i < properties; i += 1) {
    const name = rnd.pick(PROPERTY_NAMES);
    say(p, "holdsProperty", o, name, rnd.pickRecent(p.values));
    p.held.push(name);
  }
  asValue(p, o);
  p.objects.push(o);
}

/** Something written out in source that is neither function nor object. */
function declareWritten(p: Program, _rnd: Random): void {
  const w = asValue(p, id(p, "lit"));
  say(p, "writtenValue", w);
}

/** `const x = y`. */
function bindName(p: Program, rnd: Random): void {
  const y = rnd.pickRecent(p.values);
  const x = asValue(p, id(p, "name"));
  say(p, "binds", x, y);
}

/** A name written more than once, left holding its last value. */
function reassign(p: Program, rnd: Random): void {
  const y = rnd.pickRecent(p.values);
  const x = asValue(p, id(p, "name"));
  say(p, "endsHolding", x, y);
}

/** `o.n`, off whatever expression happens to be in hand. */
function readProperty(p: Program, rnd: Random): void {
  const o = rnd.pickRecent(p.values);
  const name =
    p.held.length > 0 && rnd.chance(0.8)
      ? rnd.pick(p.held)
      : rnd.pick(PROPERTY_NAMES);
  const x = asValue(p, id(p, "read"));
  say(p, "readsProperty", x, o, name);
}

/**
 * A call site. The call is a written value because the fact contract
 * says an adapter has to say so: a chain ending at a call derives
 * nothing through `isWrittenAs` otherwise.
 */
function callSite(p: Program, rnd: Random): void {
  const callee = rnd.pickRecent(p.values);
  const r = id(p, "call");
  say(p, "call", r, callee);
  say(p, "writtenValue", r);
  const arity = rnd.below(3);
  for (let k = 0; k < arity; k += 1) {
    say(p, "callArg", r, String(k), rnd.pickRecent(p.values));
  }
  if (rnd.chance(0.25)) {
    say(p, "callKeywordArg", r, rnd.pick(ARG_NAMES), rnd.pickRecent(p.values));
  }
  asValue(p, r);
}

/**
 * A name for a function, spelled one of the three ways a call site can
 * reach one: bound locally, imported, or imported and then bound, which
 * is how an adapter for a language without an import statement writes
 * it.
 */
function nameFor(p: Program, rnd: Random, f: string): string {
  const draw = rnd.below(10);
  if (draw < 5) {
    const local = asValue(p, id(p, "name"));
    say(p, "binds", local, f);
    return local;
  }
  const module = rnd.pick(MODULES);
  const name = rnd.pick(EXPORT_NAMES);
  say(p, "exportsAs", module, name, f);
  p.exports.push([module, name]);
  const imported = asValue(p, id(p, "imp"));
  say(p, "imports", imported, module, name);
  p.imported.push(imported);
  if (draw < 8) {
    return imported;
  }
  const alias = asValue(p, id(p, "name"));
  say(p, "binds", alias, imported);
  p.imported.push(alias);
  return alias;
}

/**
 * A call of a function this base declares, filling every position it
 * takes. Left to chance, a call site that calls a declared function and
 * passes an argument at a position that function declares comes up
 * almost never, and the rules about an argument reaching a parameter go
 * untouched.
 */
function callKnownFunction(p: Program, rnd: Random): void {
  if (p.functions.length === 0) {
    return;
  }
  const f = rnd.pickRecent(p.functions);
  const callee = nameFor(p, rnd, f);
  const r = id(p, "call");
  say(p, "call", r, callee);
  say(p, "writtenValue", r);
  for (const position of p.positions.get(f) ?? ["0"]) {
    say(p, "callArg", r, position, rnd.pickRecent(p.values));
  }
  asValue(p, r);
}

/**
 * What a function returns, usually another function or an object, since
 * a call giving back something already written out is the case the
 * result walk exists for.
 */
function returnValue(p: Program, rnd: Random): void {
  if (p.functions.length === 0) {
    return;
  }
  const returned = rnd.chance(0.6)
    ? rnd.pick([...p.functions, ...p.objects])
    : rnd.pickRecent(p.values);
  say(p, "returnsValue", rnd.pickRecent(p.functions), returned);
}

/**
 * A call in a function's body, often of something imported, because a
 * function calling into a library is the whole of what `callsInto`
 * reports.
 */
function bodyCall(p: Program, rnd: Random): void {
  if (p.functions.length === 0) {
    return;
  }
  const called =
    p.imported.length > 0 && rnd.chance(0.5)
      ? rnd.pick(p.imported)
      : rnd.pickRecent(p.values);
  say(p, "bodyCalls", rnd.pickRecent(p.functions), called);
}

function nestFunction(p: Program, rnd: Random): void {
  if (p.functions.length < 2) {
    return;
  }
  const outer = rnd.pick(p.functions);
  const inner = rnd.pickRecent(p.functions);
  if (outer !== inner) {
    say(p, "containsFn", outer, inner);
  }
}

function subclass(p: Program, rnd: Random): void {
  if (p.objects.length === 0) {
    return;
  }
  const cls = rnd.pick(p.objects);
  const base = rnd.pickRecent(p.values);
  if (cls !== base) {
    say(p, "extends", cls, base);
  }
}

function exportValue(p: Program, rnd: Random): void {
  const module = rnd.pick(MODULES);
  const name = rnd.pick(EXPORT_NAMES);
  say(p, "exportsAs", module, name, rnd.pickRecent(p.values));
  p.exports.push([module, name]);
}

/**
 * An import, usually of something a module in this base really exports.
 * The rest import a name nothing exports, which is what a call into a
 * library looks like and what `comesFrom` reports.
 */
function importName(p: Program, rnd: Random): void {
  const from =
    p.exports.length > 0 && rnd.chance(0.75)
      ? rnd.pick(p.exports)
      : ([rnd.pick(MODULES), rnd.pick(EXPORT_NAMES)] as const);
  const x = asValue(p, id(p, "imp"));
  say(p, "imports", x, from[0], from[1]);
  p.imported.push(x);
  if (rnd.chance(0.4)) {
    const alias = asValue(p, id(p, "name"));
    say(p, "binds", alias, x);
    p.imported.push(alias);
  }
}

function reExportName(p: Program, rnd: Random): void {
  if (p.exports.length === 0) {
    return;
  }
  const [fromModule, fromName] = rnd.pick(p.exports);
  const module = rnd.pick(MODULES);
  const name = rnd.pick(EXPORT_NAMES);
  if (module === fromModule && name === fromName) {
    return;
  }
  say(p, "reExports", module, name, fromModule, fromName);
  p.exports.push([module, name]);
}

function reExportAll(p: Program, rnd: Random): void {
  const module = rnd.pick(MODULES);
  const from = rnd.pick(MODULES);
  if (module === from) {
    return;
  }
  say(p, "reExportsAll", module, from);
  for (const [exporting, name] of [...p.exports]) {
    if (exporting === from) {
      p.exports.push([module, name]);
    }
  }
}

/**
 * The shape that makes a decorator: a factory taking a parameter,
 * returning a function whose body calls that parameter. Assembling it
 * out of separate constructs would take four draws to line up, and the
 * unwrapping rules would go untouched in almost every base.
 */
function wrapperFactory(p: Program, rnd: Random): void {
  const factory = asValue(p, id(p, "fn"));
  say(p, "func", factory);
  p.functions.push(factory);

  const position = String(rnd.below(2));
  const param = declareParam(p, factory, position);

  const returned = asValue(p, id(p, "fn"));
  say(p, "func", returned);
  p.functions.push(returned);
  say(p, "returnsValue", factory, returned);

  const callee = asValue(p, id(p, "name"));
  say(p, "binds", callee, param);

  if (rnd.chance(0.4)) {
    const closure = asValue(p, id(p, "fn"));
    say(p, "func", closure);
    p.functions.push(closure);
    say(p, "containsFn", returned, closure);
    say(p, "bodyCalls", closure, callee);
    return;
  }
  say(p, "bodyCalls", returned, callee);
}

/** A call of something a pack declared to be a wrapper. */
function declaredWrapper(p: Program, rnd: Random): void {
  const name = rnd.pick(WRAPPER_NAMES);
  const module = rnd.pick(MODULES);
  const position = String(rnd.below(2));
  say(p, "unwrapsByName", name, position);
  say(p, "wrapperModule", name, module);

  const r = id(p, "call");
  say(p, "call", r, rnd.pickRecent(p.values));
  say(p, "writtenValue", r);
  say(p, "calleeName", r, name);
  say(p, "calleeOrigin", r, rnd.chance(0.85) ? module : rnd.pick(MODULES));
  say(p, "callArg", r, position, rnd.pickRecent(p.values));
  asValue(p, r);
}

type Construct = (p: Program, rnd: Random) => void;

const CONSTRUCTS: Record<string, Construct> = {
  declareFunction,
  declareObject,
  declareWritten,
  bindName,
  reassign,
  readProperty,
  callSite,
  callKnownFunction,
  returnValue,
  bodyCall,
  nestFunction,
  subclass,
  exportValue,
  importName,
  reExportName,
  reExportAll,
  wrapperFactory,
  declaredWrapper,
};

/**
 * How often each construct is drawn. The ones that make a chain longer
 * are heaviest, since a rule that follows a chain needs a chain to
 * follow; the rest are there so every relation an adapter supplies
 * appears in some base.
 */
const WEIGHTS: Record<keyof typeof CONSTRUCTS, number> = {
  declareFunction: 4,
  declareObject: 3,
  declareWritten: 2,
  bindName: 5,
  reassign: 2,
  readProperty: 4,
  callSite: 4,
  callKnownFunction: 5,
  returnValue: 3,
  bodyCall: 3,
  nestFunction: 2,
  subclass: 2,
  exportValue: 3,
  importName: 3,
  reExportName: 2,
  reExportAll: 1,
  wrapperFactory: 2,
  declaredWrapper: 2,
};

const DRAWS: string[] = Object.entries(WEIGHTS).flatMap(([name, weight]) =>
  Array.from({ length: weight }, () => name),
);

/**
 * Every relation the constructs above can state, which is every fact the
 * `@suss/resolution` header asks an adapter for plus the four a pack
 * supplies about a wrapper. A test compares this against what the bases
 * really state, so a construct that stopped firing, or a fact that
 * arrived in the vocabulary and nothing generates, fails the run.
 */
export const STATED_RELATIONS: readonly string[] = [
  "binds",
  "bodyCalls",
  "call",
  "callArg",
  "calleeName",
  "calleeOrigin",
  "callKeywordArg",
  "containsFn",
  "endsHolding",
  "exportsAs",
  "extends",
  "func",
  "holdsProperty",
  "imports",
  "objectValue",
  "paramNamed",
  "paramOf",
  "readsProperty",
  "reExports",
  "reExportsAll",
  "returnsValue",
  "unwrapsByName",
  "wrapperModule",
  "writtenValue",
];

const runConstruct = (p: Program, rnd: Random, name: string): void => {
  const construct = CONSTRUCTS[name];
  if (construct === undefined) {
    throw new Error(`no such construct: ${name}`);
  }
  construct(p, rnd);
};

/** The one base stream `index` produces under `seed`. */
export function factBase(seed: number, index: number): FactBase {
  const rnd = seededRandom(seed, index);
  const p: Program = {
    facts: [],
    seen: new Set(),
    values: [],
    functions: [],
    objects: [],
    positions: new Map(),
    exports: [],
    held: [],
    imported: [],
    counter: 0,
  };

  // Something has to exist before anything can draw from the pools.
  declareFunction(p, rnd);
  declareWritten(p, rnd);
  declareObject(p, rnd);

  const steps = 10 + rnd.below(16);
  for (let i = 0; i < steps; i += 1) {
    runConstruct(p, rnd, rnd.pick(DRAWS));
  }

  return { index, facts: p.facts };
}

/** Bases `from` up to but not including `to`. */
export function factBases(seed: number, from: number, to: number): FactBase[] {
  const bases: FactBase[] = [];
  for (let index = from; index < to; index += 1) {
    bases.push(factBase(seed, index));
  }
  return bases;
}
