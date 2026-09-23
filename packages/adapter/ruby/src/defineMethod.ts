/**
 * The methods a class defines under a name the source computes.
 *
 * `KEYS.each { |key| define_method(key) { ... } }` defines one method
 * per element of `KEYS`, and a reader of `def` nodes sees none of them.
 * Knowing the names lets a lookup for any other name continue up the
 * ancestry instead of stopping at the class.
 *
 * The calls and their name expressions come in as `definesMethodFrom`
 * and `nameTurnsOn` facts, so this module never reads source itself. Each
 * name goes through the shared value evaluator, which follows names and
 * constants across the whole run. A name that settles only in part
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
  /** Every name a dynamic definition settled on. */
  readonly names: ReadonlySet<string>;
  /** One pattern per name that settled only in part. A name matching one may be defined by the class. */
  readonly patterns: readonly RegExp[];
  /** Whether any definition's name settled on nothing at all. */
  readonly unreadable: boolean;
}

/** What each class defines dynamically, keyed by the class node's value fact key. */
export type DynamicNames = ReadonlyMap<string, DefinedNames>;

const NOTHING: DefinedNames = {
  names: new Set(),
  patterns: [],
  unreadable: false,
};

/** Whether the class may define `name` through a definition whose name did not fully settle. */
export function couldBeDefined(defined: DefinedNames, name: string): boolean {
  return (
    defined.unreadable || defined.patterns.some((pattern) => pattern.test(name))
  );
}

/** What a class defines dynamically, or an empty result for a class with no dynamic definitions. */
export function definedNamesOf(
  dynamic: DynamicNames | undefined,
  classKey: string,
): DefinedNames {
  return dynamic?.get(classKey) ?? NOTHING;
}

/**
 * Reads every dynamic definition in the run. The names they settle on
 * go into the facts as `declaresName`, so the shared
 * `wantedDeclaredName` rule reports them next to the names a `def`
 * writes. The result also has the patterns and the unreadable flag the
 * ancestry lookup needs. Call it after the evaluator is bound, since
 * settling a name reads the run's facts.
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

/** Adds one more call's result to what the calls read so far found. */
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

/** What one call defines: a name for each turn of the loops around it, or a pattern when a turn's name settles only in part. Null when some turn gives neither. */
function readOne(
  db: Database,
  rootsByFile: ReadonlyMap<string, RbNode>,
  nameKey: string,
): { names: string[]; patterns: RegExp[] } | null {
  // A key with no node in the run is treated like an unreadable name.
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
 * One set of block parameter bindings per turn of the loops the name is
 * written inside. A loop whose elements cannot be listed adds no
 * binding, so a name taken from its parameter stays unread.
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

/** One loop around a name, with the elements it runs over. */
interface LoopOver {
  readonly element: string;
  /** The name the position is bound to, or the empty string for a block that takes one parameter. */
  readonly index: string;
  readonly elements: string[];
}

/** Every loop around the name whose elements could be listed, in the order of the facts. */
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
