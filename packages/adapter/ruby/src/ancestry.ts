// ancestry.ts: the chain a lookup walks to find the method behind a
// class. See this package's README for why it walks and where it stops.

import {
  bareCallArgumentGroups,
  bodyStatements,
  instanceMethodsByName,
} from "./ast.js";
import { resolveConstantFile } from "./constantPath.js";
import { qualifyConstantRef, walkDefinitions } from "./scope.js";

import type { ConstantPathConvention } from "./constantPath.js";
import type { RbNode } from "./parser.js";
import type { ClassInfo } from "./scope.js";

/** Ruby's own module keywords. `extend` is not one: it adds class methods, and a field is answered by an instance method. */
const INCLUDE_CALL = "include";
const PREPEND_CALL = "prepend";

/** Ruby's own dynamic definition. A method defined this way is called like any other and is invisible to a reader of `def` nodes. */
const DEFINE_METHOD_CALL = "define_method";

/** One class or module body a walk reached, with the definitions its own file makes, since a bare constant is shadowed per file. */
export interface ReachedBody {
  info: ClassInfo;
  knownClasses: ReadonlySet<string>;
}

/** One ancestor: every block reopening its name, or the name alone when nothing reached it. Blocks stay together because Ruby treats a reopened class as one place in the chain. */
export type AncestorEntry =
  | { type: "bodies"; name: string; blocks: ReachedBody[] }
  | { type: "unfollowed"; name: string };

/** A class and everything it inherits from, in Ruby's own method-lookup order. */
export type Ancestry = readonly AncestorEntry[];

/** What a walk needs to reach a class it knows only by name. */
export interface AncestorLookup {
  /** Directory the constant-to-path convention resolves an ancestor's name against. */
  root: string;
  pathConvention: ConstantPathConvention;
  /**
   * The library's own classes a project's chain ends at. Reaching one
   * ends a walk with nothing left unfollowed.
   */
  ancestryRootClassNames: readonly string[];
  parsedFile(absPath: string): Promise<RbNode | null>;
  /**
   * The blocks the file being read defines under a name, consulted
   * before the path convention, since a constant defined in the same
   * file is visible without a file of its own.
   */
  localDefinition?(qualifiedName: string): ReachedBody[] | null;
}

/**
 * Every block a file defines under `qualifiedName`, or null when the
 * constant-to-path convention points at no file, no file is there, or
 * the file defines nothing by that name.
 */
export async function reachDefinition(
  qualifiedName: string,
  lookup: AncestorLookup,
): Promise<ReachedBody[] | null> {
  const filePath = resolveConstantFile(
    lookup.root,
    qualifiedName,
    lookup.pathConvention,
  );
  const fileRoot = filePath === null ? null : await lookup.parsedFile(filePath);
  if (fileRoot === null) {
    return null;
  }
  const all: ClassInfo[] = [];
  walkDefinitions(fileRoot, (info) => all.push(info));
  const matches = all.filter((info) => info.qualifiedName === qualifiedName);
  if (matches.length === 0) {
    return null;
  }
  const knownClasses = new Set(all.map((info) => info.qualifiedName));
  return matches.map((info) => ({ info, knownClasses }));
}

export function ancestryOf(
  name: string,
  blocks: readonly ReachedBody[],
  lookup: AncestorLookup,
): Promise<Ancestry> {
  return chainOf(
    { type: "bodies", name, blocks: [...blocks] },
    lookup,
    new Set([name]),
  );
}

/**
 * Ruby computes a class's ancestors once at include time and inserts
 * each module's own already-computed chain as a unit, skipping anything
 * already in there. That is why the superclass chain is built first and
 * every later step filters against it: a module the superclass already
 * mixes in keeps the place the superclass gave it.
 */
async function chainOf(
  self: Extract<AncestorEntry, { type: "bodies" }>,
  lookup: AncestorLookup,
  active: ReadonlySet<string>,
): Promise<AncestorEntry[]> {
  const superChain = await superclassChain(self, lookup, active);

  const present = new Set(superChain.map((ancestor) => ancestor.name));
  present.add(self.name);

  const mixins = await mixinChain(self, INCLUDE_CALL, lookup, active, present);
  const prepends = await mixinChain(
    self,
    PREPEND_CALL,
    lookup,
    active,
    present,
  );

  return [...prepends, self, ...mixins, ...superChain];
}

async function superclassChain(
  self: Extract<AncestorEntry, { type: "bodies" }>,
  lookup: AncestorLookup,
  active: ReadonlySet<string>,
): Promise<AncestorEntry[]> {
  const superclass = superclassOf(self.blocks);
  if (
    superclass === null ||
    lookup.ancestryRootClassNames.includes(superclass) ||
    active.has(superclass)
  ) {
    return [];
  }
  return chainFor(superclass, lookup, active);
}

/**
 * What one kind of mixin call contributes, each module's whole chain
 * computed on its own and then filtered, so two concerns sharing a base
 * put that base where Ruby puts it rather than where the first of them
 * was read.
 */
async function mixinChain(
  self: Extract<AncestorEntry, { type: "bodies" }>,
  callName: string,
  lookup: AncestorLookup,
  active: ReadonlySet<string>,
  present: Set<string>,
): Promise<AncestorEntry[]> {
  let chain: AncestorEntry[] = [];
  for (const ref of moduleRefs(self.blocks, callName)) {
    if (present.has(ref.name)) {
      continue;
    }
    if (!ref.readable) {
      present.add(ref.name);
      chain = [{ type: "unfollowed", name: ref.name }, ...chain];
      continue;
    }
    const inserted = (await chainFor(ref.name, lookup, active)).filter(
      (ancestor) => !present.has(ancestor.name),
    );
    for (const ancestor of inserted) {
      present.add(ancestor.name);
    }
    chain = [...inserted, ...chain];
  }
  return chain;
}

async function chainFor(
  qualifiedName: string,
  lookup: AncestorLookup,
  active: ReadonlySet<string>,
): Promise<AncestorEntry[]> {
  const blocks =
    lookup.localDefinition?.(qualifiedName) ??
    (await reachDefinition(qualifiedName, lookup));
  if (blocks === null) {
    return [{ type: "unfollowed", name: qualifiedName }];
  }
  return chainOf(
    { type: "bodies", name: qualifiedName, blocks },
    lookup,
    new Set([...active, qualifiedName]),
  );
}

/** A constant an `include`/`prepend` call names. `readable` is false for anything but a constant path, which is named by the text it was written with. */
interface ModuleRef {
  name: string;
  readable: boolean;
}

/**
 * The modules one kind of mixin call names, in the order Ruby mixes
 * them in. Each call is inserted in front of the ones before it, and
 * `include A, B` mixes in B before A, so calls read in source order and
 * one call's own arguments read backwards.
 */
function moduleRefs(
  blocks: readonly ReachedBody[],
  callName: string,
): ModuleRef[] {
  const refs: ModuleRef[] = [];
  for (const block of blocks) {
    if (block.info.bodyNode === null) {
      continue;
    }
    for (const group of bareCallArgumentGroups(block.info.bodyNode, callName)) {
      for (const arg of [...group].reverse()) {
        const qualified = qualifyConstantRef(arg, block.info.bodyNesting);
        refs.push(
          qualified !== null
            ? { name: qualified, readable: true }
            : { name: arg.text, readable: false },
        );
      }
    }
  }
  return refs;
}

function superclassOf(blocks: readonly ReachedBody[]): string | null {
  for (const block of blocks) {
    if (block.info.superclassQualifiedName !== null) {
      return block.info.superclassQualifiedName;
    }
  }
  return null;
}

/** What searching an ancestry for one method name came to. */
export type MethodLookup =
  | { type: "found"; method: RbNode }
  /** `reason` completes "could be answered by a method ...". */
  | { type: "unsettled"; reason: string }
  | { type: "none" };

/**
 * The method `name` resolves to. An ancestor nearer than any definition
 * that nothing could read stops the search: whatever sits further along
 * is not what Ruby would have called.
 */
export function methodInAncestry(
  ancestry: Ancestry,
  name: string,
): MethodLookup {
  for (const entry of ancestry) {
    if (entry.type === "unfollowed") {
      return {
        type: "unsettled",
        reason: `inherited from ${entry.name}, which this run did not read`,
      };
    }

    const found = definitionIn(entry.blocks, name);
    if (found.method !== null) {
      return { type: "found", method: found.method };
    }
    if (found.dynamic) {
      return {
        type: "unsettled",
        reason: "defined with define_method, which this reader does not follow",
      };
    }
  }
  return { type: "none" };
}

/** What one ancestor's blocks say about `name`: its last definition, the way Ruby's own redefinition works, and whether anything here defines methods a reader of `def` nodes cannot see. */
function definitionIn(
  blocks: readonly ReachedBody[],
  name: string,
): { method: RbNode | null; dynamic: boolean } {
  let method: RbNode | null = null;
  let dynamic = false;
  for (const block of blocks) {
    const body = block.info.bodyNode;
    if (body === null) {
      continue;
    }
    method = instanceMethodsByName(body).get(name) ?? method;
    dynamic ||= bareCallArgumentGroups(body, DEFINE_METHOD_CALL).length > 0;
  }
  return { method, dynamic };
}

/** Every statement of every body reached, most distant ancestor first, so a nearer declaration overwrites what it inherits. */
export function inheritedStatements(
  ancestry: Ancestry,
): Array<{ block: ReachedBody; statement: RbNode }> {
  const statements: Array<{ block: ReachedBody; statement: RbNode }> = [];
  for (const entry of [...ancestry].reverse()) {
    if (entry.type !== "bodies") {
      continue;
    }
    for (const block of entry.blocks) {
      const body = block.info.bodyNode;
      if (body === null) {
        continue;
      }
      for (const statement of bodyStatements(body)) {
        statements.push({ block, statement });
      }
    }
  }
  return statements;
}
