/**
 * What a test builds with a factory library. `create(:order)` and
 * `Fabricate(:order)` look a factory up by name and give back one of
 * its class, which the factory's definition says or implies. Without
 * that, `order.cancel` in a test calls a method on a value nothing
 * types, and the walk stops there.
 *
 * Definitions can be in any file the run reads, so this runs once every
 * file is in. A factory's class is the one its definition gives, else
 * the class of the factory it builds on, else the class its own name
 * camelizes to, as both libraries infer it. Each build in a test file
 * is then stated as one of that class, with `instanceOf`.
 */

import { literalOf } from "@suss/values";

import { children, field, readCallArgs, symbolValue } from "./ast.js";
import { nodeId, readKey } from "./facts/values.js";
import { camelize } from "./inflect.js";
import { calleeMethodName } from "./paths/effects.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { RbFactories, RbInflections, RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";

interface ParsedFile {
  readonly file: string;
  readonly root: RbNode;
}

/** How a definition says its class: a key the rules can follow, or a class name to look up. */
type ClassRef = { key: string } | { qualifiedName: string };

interface Definition {
  readonly name: string;
  readonly classRef: ClassRef | null;
  /** The factory it builds on, by name. */
  readonly parent: string | null;
}

export function factoriesIn(packs: readonly RubyPack[]): RbFactories[] {
  return packs.flatMap((pack) => pack.factories ?? []);
}

/**
 * States each factory build in a test file as one of its factory's
 * class. `isTestFile` says which files are read as tests; a build
 * anywhere else is left alone, so the rest of the run is unchanged.
 */
export function emitFactoryFacts(
  db: Database,
  files: readonly ParsedFile[],
  isTestFile: (file: string) => boolean,
  patterns: readonly RbFactories[],
  inflections: RbInflections,
): void {
  for (const pattern of patterns) {
    const definitions = new Map<string, Definition>();
    for (const { file, root } of files) {
      collectDefinitions(db, file, root, pattern, null, definitions);
    }
    const classes = new FactoryClasses(db, definitions, inflections);
    for (const { file, root } of files) {
      if (!isTestFile(file)) {
        continue;
      }
      for (const [call, name] of buildsIn(db, root, pattern)) {
        const classKey = classes.of(name);
        if (classKey !== null) {
          db.add("instanceOf", [nodeId(file, call), classKey]);
        }
      }
    }
  }
}

function collectDefinitions(
  db: Database,
  file: string,
  node: RbNode,
  pattern: RbFactories,
  enclosing: string | null,
  into: Map<string, Definition>,
): void {
  for (const child of children(node)) {
    const defined = definitionAt(db, file, child, pattern, enclosing);
    if (defined !== null && !into.has(defined.name)) {
      into.set(defined.name, defined);
    }
    collectDefinitions(
      db,
      file,
      child,
      pattern,
      defined?.name ?? enclosing,
      into,
    );
  }
}

function definitionAt(
  db: Database,
  file: string,
  call: RbNode,
  pattern: RbFactories,
  enclosing: string | null,
): Definition | null {
  if (
    call.type !== "call" ||
    field(call, "receiver") !== null ||
    !pattern.definitionMethods.includes(calleeMethodName(call) ?? "")
  ) {
    return null;
  }
  const { positional, keyword } = readCallArgs(field(call, "arguments"));
  const name = positional[0] === undefined ? null : nameOf(db, positional[0]);
  if (name === null) {
    return null;
  }
  const classNode = pattern.classKeywords
    .map((key) => keyword[key])
    .find((one) => one !== undefined);
  const parentNode = pattern.parentKeywords
    .map((key) => keyword[key])
    .find((one) => one !== undefined);
  const inherited = pattern.nestedDefinitionsInherit ? enclosing : null;
  return {
    name,
    classRef: classNode === undefined ? null : classRefOf(db, file, classNode),
    parent: parentNode === undefined ? inherited : nameOf(db, parentNode),
  };
}

function classRefOf(db: Database, file: string, node: RbNode): ClassRef | null {
  if (node.type === "constant" || node.type === "scope_resolution") {
    return { key: readKey(file, node, null) };
  }
  const written = literalOf(evaluatedValue(node, db));
  if (written === null) {
    return null;
  }
  // A name written from the top, "::Order", is the same class.
  return {
    qualifiedName: written.startsWith("::") ? written.slice(2) : written,
  };
}

/** A factory named by a symbol or a string. */
function nameOf(db: Database, node: RbNode): string | null {
  return symbolValue(node) ?? literalOf(evaluatedValue(node, db));
}

/** The class each factory builds, worked out once per name. */
class FactoryClasses {
  private readonly known = new Map<string, string | null>();

  constructor(
    private readonly db: Database,
    private readonly definitions: ReadonlyMap<string, Definition>,
    private readonly inflections: RbInflections,
  ) {}

  of(name: string, seen: ReadonlySet<string> = new Set()): string | null {
    const known = this.known.get(name);
    if (known !== undefined) {
      return known;
    }
    const found = this.work(name, seen);
    this.known.set(name, found);
    return found;
  }

  private work(name: string, seen: ReadonlySet<string>): string | null {
    const definition = this.definitions.get(name);
    if (definition === undefined || seen.has(name)) {
      return this.byName(this.camelized(name));
    }
    if (definition.classRef !== null) {
      return "key" in definition.classRef
        ? definition.classRef.key
        : this.byName(definition.classRef.qualifiedName);
    }
    if (definition.parent !== null) {
      return this.of(definition.parent, new Set([...seen, name]));
    }
    return this.byName(this.camelized(name));
  }

  private camelized(name: string): string {
    return camelize(name, this.inflections.acronyms ?? []);
  }

  /** The class the run defines under this name, when it defines one. */
  private byName(qualifiedName: string): string | null {
    const keys = this.db
      .lookup("rbConstantName", 1, qualifiedName)
      .map((row) => String(row[0]))
      .sort();
    return keys[0] ?? null;
  }
}

/** Each build call in a file, with the factory name it gives. */
function buildsIn(
  db: Database,
  root: RbNode,
  pattern: RbFactories,
): [RbNode, string][] {
  const found: [RbNode, string][] = [];
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      const name = child.type === "call" ? builtAt(db, child, pattern) : null;
      if (name !== null) {
        found.push([child, name]);
      }
      visit(child);
    }
  };
  visit(root);
  return found;
}

function builtAt(
  db: Database,
  call: RbNode,
  pattern: RbFactories,
): string | null {
  const method = calleeMethodName(call);
  const receiver = field(call, "receiver")?.text;
  const builds = pattern.builders.some(
    (one) => one.method === method && one.receiver === receiver,
  );
  if (!builds) {
    return null;
  }
  const [first] = readCallArgs(field(call, "arguments")).positional;
  return first === undefined ? null : nameOf(db, first);
}
