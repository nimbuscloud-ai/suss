/**
 * The method names a class gets under a name the source computes.
 *
 * `KEYS.each { |key| define_method(key) { ... } }` defines one method
 * per element of `KEYS`, and a reader of `def` nodes sees none of them.
 * Reading the names lets a lookup for a name none of them defines carry
 * on up the ancestry instead of stopping at the class.
 *
 * Which calls those are, and what each name is written as, arrive as
 * `definesMethodFrom` and `nameTurnsOn`, so this reads no source of its
 * own. Each name goes through the shared value evaluator, which follows
 * names and constants across the whole run. A name read only in part
 * becomes a pattern the whole name has to match.
 */

import { nodeOfKey } from "@suss/resolution";
import { hole, literalOf, piecesOf } from "@suss/values";

import { evaluatedValue } from "./values/evaluator.js";
import { literalElementsOf } from "./values/literals.js";

import type { Database } from "@suss/datalog";
import type { Value } from "@suss/values";
import type { RbNode } from "./parser.js";
import type { ParameterBindings } from "./values/evaluator.js";

/** What the dynamic definitions in one class define. */
export interface DefinedNames {
  /** Every name this reader read one as defining. */
  readonly names: ReadonlySet<string>;
  /** What a name read only in part has to match for the class to be defining it. */
  readonly patterns: readonly RegExp[];
  /** Whether one of them was given a name this reader could not read. */
  readonly unreadable: boolean;
}

/** Every class's reading, by the key the value facts give the class node. */
export type DynamicNames = ReadonlyMap<string, DefinedNames>;

const NOTHING: DefinedNames = {
  names: new Set(),
  patterns: [],
  unreadable: false,
};

/** Whether `name` could be one the class defines without this reader having read which. */
export function couldBeDefined(defined: DefinedNames, name: string): boolean {
  return (
    defined.unreadable || defined.patterns.some((pattern) => pattern.test(name))
  );
}

/** What a class defines dynamically, or an empty reading for one that defines nothing that way. */
export function definedNamesOf(
  dynamic: DynamicNames | undefined,
  classKey: string,
): DefinedNames {
  return dynamic?.get(classKey) ?? NOTHING;
}

/**
 * Read every dynamic definition in the run, put the names it settles on
 * in the facts so the shared `wantedDeclaredName` rule reports them
 * beside the ones a `def` writes out, and hand back what else the
 * ancestry lookup needs. Runs after the evaluator is bound, since
 * settling a name reads the run's own facts.
 */
export function readDynamicNames(
  db: Database,
  rootsByFile: ReadonlyMap<string, RbNode>,
): DynamicNames {
  const byClass = new Map<string, DefinedNames>();
  for (const [classKey, nameKey] of db.facts("definesMethodFrom")) {
    const key = String(classKey);
    byClass.set(
      key,
      foldReading(
        byClass.get(key) ?? NOTHING,
        readOne(db, rootsByFile, String(nameKey)),
      ),
    );
  }
  for (const [classKey, reading] of byClass) {
    for (const name of reading.names) {
      db.add("declaresName", [classKey, name]);
    }
  }
  return byClass;
}

/** What the calls read so far say, with one more call's reading folded in. */
function foldReading(
  soFar: DefinedNames,
  reading: { names: string[]; patterns: RegExp[] } | null,
): DefinedNames {
  if (reading === null) {
    return { ...soFar, unreadable: true };
  }
  return {
    names: new Set([...soFar.names, ...reading.names]),
    patterns: [...soFar.patterns, ...reading.patterns],
    unreadable: soFar.unreadable,
  };
}

/** What one call defines: a name per turn of the loops around it, or the pattern a turn's name matches. Null when a turn gives neither. */
function readOne(
  db: Database,
  rootsByFile: ReadonlyMap<string, RbNode>,
  nameKey: string,
): { names: string[]; patterns: RegExp[] } | null {
  // A key naming no node in the run settles on nothing, which is what
  // an unreadable name settles on too.
  const node = nodeOfKey(rootsByFile, nameKey);
  const names: string[] = [];
  const patterns: RegExp[] = [];
  for (const bindings of loopTurns(db, rootsByFile, nameKey)) {
    const value =
      node === null
        ? hole(nameKey)
        : evaluatedValue(node, db, bindings.size === 0 ? undefined : bindings);
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
 * One set of block-parameter bindings per turn of the loops the name is
 * written inside. A loop whose elements this reader cannot list
 * contributes no binding, which leaves a name taken from its parameter
 * unread.
 */
function loopTurns(
  db: Database,
  rootsByFile: ReadonlyMap<string, RbNode>,
  nameKey: string,
): ParameterBindings[] {
  let turns: Array<Map<string, string>> = [new Map()];
  for (const over of listsBehind(db, rootsByFile, nameKey)) {
    turns = turns.flatMap((base) =>
      over.elements.map((value, position) => {
        const binding = new Map([...base, [over.element, value]]);
        if (over.index !== "") {
          binding.set(over.index, String(position));
        }
        return binding;
      }),
    );
  }
  return turns;
}

/** One loop around a name, with what it runs over read out. */
interface LoopOver {
  readonly element: string;
  /** The name the position is bound to, or the empty string for a block that takes one parameter. */
  readonly index: string;
  readonly elements: string[];
}

/** Every loop around the name whose elements this reader could list, in the order the facts state them. */
function listsBehind(
  db: Database,
  rootsByFile: ReadonlyMap<string, RbNode>,
  nameKey: string,
): LoopOver[] {
  const found: LoopOver[] = [];
  for (const [, element, index, overKey] of db.lookup(
    "nameTurnsOn",
    0,
    nameKey,
  )) {
    const node = nodeOfKey(rootsByFile, String(overKey));
    const elements = node === null ? null : literalElementsOf(node, db);
    if (elements !== null) {
      found.push({ element: String(element), index: String(index), elements });
    }
  }
  return found;
}
