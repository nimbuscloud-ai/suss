/**
 * The methods a class defines under a name the source computes.
 *
 * `KEYS.each { |key| define_method(key) { ... } }` defines one method
 * per element of `KEYS`, and a reader of `def` nodes sees none of them.
 * Knowing the names lets a lookup for any other name continue up the
 * ancestry instead of stopping at the class.
 *
 * The calls come in as `definesMethodFrom` facts, and the loops around
 * them as `elementOf` and `positionOf`. The shared value evaluator reads
 * each name once for each element of each loop. A name that settles
 * only in part becomes a pattern the whole name has to match.
 */

import { type KeySpan, nodeOfKey, spanOfKey } from "@suss/resolution";
import { hole, literalOf, piecesOf } from "@suss/values";

import { field } from "./ast.js";
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
  const definitions = db.facts("definesMethodFrom");
  const loops = definitions.length === 0 ? new Map() : loopsByFile(db);
  for (const [classKey, nameKey] of definitions) {
    const key = String(classKey);
    const around = loopsAround(loops, key, String(nameKey));
    byClass.set(
      key,
      foldReading(
        byClass.get(key) ?? NOTHING,
        readOne(db, rootsByFile, String(nameKey), around),
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
  loops: readonly LoopVariable[],
): { names: string[]; patterns: RegExp[] } | null {
  // A key with no node in the run is treated like an unreadable name.
  const node = nodeOfKey(rootsByFile, nameKey);
  const names: string[] = [];
  const patterns: RegExp[] = [];
  for (const bindings of loopTurns(db, rootsByFile, loops)) {
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
  loops: readonly LoopVariable[],
): ParameterBindings[] {
  let turns: Array<Map<string, string>> = [new Map()];
  for (const over of listsBehind(db, rootsByFile, loops)) {
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

/** Every loop in `loops` whose elements could be listed, in the same order. */
function listsBehind(
  db: Database,
  rootsByFile: ReadonlyMap<string, RbNode>,
  loops: readonly LoopVariable[],
): LoopOver[] {
  const found: LoopOver[] = [];
  for (const loop of loops) {
    const node = collectionNode(rootsByFile, loop);
    const elements = node === null ? null : literalElementsOf(node, db);
    if (elements !== null) {
      found.push({ element: loop.element, index: loop.index, elements });
    }
  }
  return found;
}

/**
 * The syntax of the collection a loop block runs over, for the evaluator
 * to read. A name's key has no node of its own, so a name is read where
 * the call the block is passed to writes it.
 */
function collectionNode(
  rootsByFile: ReadonlyMap<string, RbNode>,
  loop: LoopVariable,
): RbNode | null {
  const written = nodeOfKey(rootsByFile, loop.over);
  if (written !== null) {
    return written;
  }
  const call = nodeOfKey(rootsByFile, loop.block.key)?.parent ?? null;
  return call === null ? null : field(call, "receiver");
}

/** A loop block's variable that `elementOf` states, with where the block is written. */
interface LoopVariable {
  readonly block: KeySpan & { readonly key: string };
  /** The name the block gives each element. */
  readonly element: string;
  /** The name the block gives the position, or the empty string when it takes none. */
  readonly index: string;
  /** The key of the collection the block runs over. */
  readonly over: string;
}

/**
 * The name a block variable's key ends with. The adapter keys a block's
 * variable on the block, then `#`, then the name, the way it keys a read
 * of it.
 */
function blockVariableOf(key: string): { block: string; name: string } | null {
  const at = key.lastIndexOf("#");
  return at < 0 ? null : { block: key.slice(0, at), name: key.slice(at + 1) };
}

/** Every loop variable in the run, by the file its block is in. */
function loopsByFile(db: Database): Map<string, LoopVariable[]> {
  const indexes = new Map<string, string>();
  for (const [position, element] of db.facts("positionOf")) {
    const name = blockVariableOf(String(position))?.name;
    if (name !== undefined) {
      indexes.set(String(element), name);
    }
  }
  const byFile = new Map<string, LoopVariable[]>();
  for (const [element, over] of db.facts("elementOf")) {
    const variable = blockVariableOf(String(element));
    const span = variable === null ? null : spanOfKey(variable.block);
    if (variable === null || span === null) {
      continue;
    }
    const found = byFile.get(span.file) ?? [];
    found.push({
      block: { ...span, key: variable.block },
      element: variable.name,
      index: indexes.get(String(element)) ?? "",
      over: String(over),
    });
    byFile.set(span.file, found);
  }
  return byFile;
}

/**
 * The loops a class body writes around a `define_method` name, outermost
 * first: each block inside the class whose span covers the name's.
 */
function loopsAround(
  loops: ReadonlyMap<string, readonly LoopVariable[]>,
  classKey: string,
  nameKey: string,
): LoopVariable[] {
  const cls = spanOfKey(classKey);
  const name = spanOfKey(nameKey);
  if (cls === null || name === null) {
    return [];
  }
  return (loops.get(name.file) ?? [])
    .filter(
      ({ block }) =>
        cls.start <= block.start &&
        block.end <= cls.end &&
        block.start <= name.start &&
        name.end <= block.end,
    )
    .sort((a, b) => a.block.start - b.block.start);
}
