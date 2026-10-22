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
import { type LoopElement, loopElementsOf } from "./values/literals.js";

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
  loops: readonly LoopBlock[],
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
 * One set of block variable bindings per turn of the loops the name is
 * written inside. A loop whose elements cannot be listed adds no turns,
 * so a name taken from its variables stays unread.
 */
function loopTurns(
  db: Database,
  rootsByFile: ReadonlyMap<string, RbNode>,
  loops: readonly LoopBlock[],
): ParameterBindings[] {
  let turns: Array<Map<string, string>> = [new Map()];
  for (const loop of loops) {
    const bindings = bindingsOf(db, rootsByFile, loop);
    if (bindings === null) {
      continue;
    }
    turns = turns.flatMap((base) =>
      bindings.map((binding) => new Map([...base, ...binding])),
    );
  }
  return turns;
}

/**
 * What each of a loop block's variables is given on each turn, one map
 * per element. A variable that some element gives no literal is left out
 * of every turn, and a loop with no variable left is null.
 */
function bindingsOf(
  db: Database,
  rootsByFile: ReadonlyMap<string, RbNode>,
  loop: LoopBlock,
): Map<string, string>[] | null {
  const node = collectionNode(rootsByFile, loop);
  const elements = node === null ? null : loopElementsOf(node, db);
  if (elements === null) {
    return null;
  }
  const bound = [...loop.variables].flatMap(([name, takes]) => {
    const values = elements.map((element, position) =>
      GIVEN[takes.kind](element, position, takes),
    );
    return values.every((value) => value !== null)
      ? [{ name, values: values as string[] }]
      : [];
  });
  if (bound.length === 0) {
    return null;
  }
  return elements.map(
    (_, position) =>
      new Map(bound.map(({ name, values }) => [name, values[position] ?? ""])),
  );
}

/** What a block variable is given each time round: the element, one part of it, or its position. */
type Takes =
  | { readonly kind: "element" }
  | { readonly kind: "part"; readonly part: number }
  | { readonly kind: "position" };

/** The literal one element gives a variable, by what the variable takes, or null when it gives none. */
const GIVEN: Record<
  Takes["kind"],
  (element: LoopElement, position: number, takes: Takes) => string | null
> = {
  element: (element) => literalOf(element.whole),
  part: (element, _, takes) => {
    const part = takes.kind === "part" ? element.parts[takes.part] : undefined;
    return part === undefined ? null : literalOf(part);
  },
  position: (_, position) => String(position),
};

/**
 * The syntax of the collection a loop block runs over, for the evaluator
 * to read. A name's key has no node of its own, so a name is read where
 * the call the block is passed to writes it.
 */
function collectionNode(
  rootsByFile: ReadonlyMap<string, RbNode>,
  loop: LoopBlock,
): RbNode | null {
  const written = nodeOfKey(rootsByFile, loop.over);
  if (written !== null) {
    return written;
  }
  const call = nodeOfKey(rootsByFile, loop.block.key)?.parent ?? null;
  return call === null ? null : field(call, "receiver");
}

/** A loop block, with where it is written, what it runs over and what each of its variables is given. */
interface LoopBlock {
  readonly block: KeySpan & { readonly key: string };
  /** The key of the collection the block runs over. */
  readonly over: string;
  readonly variables: Map<string, Takes>;
}

/**
 * The block and the name a block variable's key is made of. The adapter
 * keys a block's variable on the block, then `#`, then the name, the way
 * it keys a read of it. Null for any other key.
 */
function blockVariableOf(
  key: string,
): { block: KeySpan & { key: string }; name: string } | null {
  const at = key.lastIndexOf("#");
  const span = at < 0 ? null : spanOfKey(key.slice(0, at));
  return span === null
    ? null
    : { block: { ...span, key: key.slice(0, at) }, name: key.slice(at + 1) };
}

/** Every loop block in the run that elementOf or elementPartOf states, by the file it is in. */
function loopsByFile(db: Database): Map<string, LoopBlock[]> {
  const blocks = new Map<string, LoopBlock>();
  const note = (key: unknown, over: unknown, takes: Takes): void => {
    const variable = blockVariableOf(String(key));
    if (variable === null) {
      return;
    }
    const known = blocks.get(variable.block.key);
    const loop = known ?? {
      block: variable.block,
      over: String(over),
      variables: new Map(),
    };
    loop.variables.set(variable.name, takes);
    blocks.set(variable.block.key, loop);
  };
  for (const [element, over] of db.facts("elementOf")) {
    note(element, over, { kind: "element" });
  }
  for (const [element, over, part] of db.facts("elementPartOf")) {
    note(element, over, { kind: "part", part: Number(part) });
  }
  // A position belongs to the block of the variable it is tied to.
  for (const [position, element] of db.facts("positionOf")) {
    const block = blockVariableOf(String(element))?.block.key;
    if (block !== undefined && blocks.has(block)) {
      note(position, blocks.get(block)?.over, { kind: "position" });
    }
  }
  const byFile = new Map<string, LoopBlock[]>();
  for (const loop of blocks.values()) {
    byFile.set(loop.block.file, [...(byFile.get(loop.block.file) ?? []), loop]);
  }
  return byFile;
}

/**
 * The loops a class body writes around a `define_method` name, outermost
 * first: each block inside the class whose span covers the name's.
 */
function loopsAround(
  loops: ReadonlyMap<string, readonly LoopBlock[]>,
  classKey: string,
  nameKey: string,
): LoopBlock[] {
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
