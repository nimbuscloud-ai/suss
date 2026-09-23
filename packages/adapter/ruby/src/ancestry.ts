/**
 * The ancestor chain a lookup walks to find the method behind a class,
 * in the order Ruby's `Module#ancestors` gives. A reopened class is one
 * place in the chain, an included module's own chain goes in as a unit,
 * and an ancestor already in the chain is not added again.
 */

import {
  bareCallArgumentGroups,
  INCLUDE_CALL,
  instanceMethodsByName,
  PREPEND_CALL,
  runStatements,
} from "./ast.js";
import { resolveConstantFile } from "./constantPath.js";
import { couldBeDefined, definedNamesOf } from "./defineMethod.js";
import { nodeId } from "./facts/values.js";
import { constantRefCandidates, walkDefinitions } from "./scope.js";

import type { Database } from "@suss/datalog";
import type { BlockConfigures, BodyBlocks } from "./ast.js";
import type { ConstantPathConvention } from "./constantPath.js";
import type { DynamicNames } from "./defineMethod.js";
import type { RbNode } from "./parser.js";
import type { ClassInfo } from "./scope.js";

/** One class or module body a walk reached, with the definitions its own file makes, since a bare constant is shadowed per file. */
export interface ReachedBody {
  info: ClassInfo;
  knownClasses: ReadonlySet<string>;
  /** Absolute path of the file the block is written in. */
  file: string;
}

/**
 * One ancestor: every block reopening its name, the name alone when
 * nothing reached it, or the library's own class the walk stopped at.
 * Blocks stay together because Ruby treats a reopened class as one
 * place in the chain. The root is kept by name so a caller can tell a
 * chain that ended at the library from one that ended at nothing.
 */
export type AncestorEntry =
  | { type: "bodies"; name: string; blocks: ReachedBody[] }
  | { type: "unfollowed"; name: string }
  | { type: "root"; name: string };

/** A class and everything it inherits from, in Ruby's own method-lookup order. */
export type Ancestry = readonly AncestorEntry[];

/** What reading a class body needs besides the body: the run's facts, and what the packs declare about blocks written in one. */
export interface BodyReading {
  readonly facts?: Database | undefined;
  readonly bodyBlocks?: BodyBlocks | undefined;
  /** What each class defines under a name the source computes, by class key. */
  readonly dynamicNames?: DynamicNames | undefined;
}

/** What a walk needs to reach a class it knows only by name. */
export interface AncestorLookup {
  /** Directory the constant-to-path convention resolves an ancestor's name against. */
  root: string;
  pathConvention: ConstantPathConvention;
  /** Acronyms the convention keeps as one word, `ActivityPub` to `activitypub`. */
  acronyms?: readonly string[];
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
    lookup.acronyms,
  );
  if (filePath === null) {
    return null;
  }
  const fileRoot = await lookup.parsedFile(filePath);
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
  return matches.map((info) => ({ info, knownClasses, file: filePath }));
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
 * Ruby computes ancestors as each `include` runs. It inserts the
 * module's own chain as a unit and skips anything already present. So
 * the superclass chain is built first and every later step is checked
 * against it, and a module the superclass already mixes in keeps the
 * place the superclass gave it.
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
  const candidates = superclassCandidatesOf(self.blocks);
  const settled = await settleConstant(
    candidates,
    lookup.ancestryRootClassNames,
    lookup,
    active,
  );
  if (settled === null) {
    return unreadConstant(candidates);
  }
  if (settled.type === "root") {
    return [{ type: "root", name: settled.name }];
  }
  if (settled.type === "cycle") {
    return [];
  }
  return chainOf(
    { type: "bodies", name: settled.name, blocks: settled.blocks },
    lookup,
    new Set([...active, settled.name]),
  );
}

/** Which of a constant reference's candidates Ruby would take, the first match winning. */
type SettledConstant =
  | { type: "root"; name: string }
  /** A candidate the walk is already inside, which Ruby would reject as a cyclic ancestry. */
  | { type: "cycle"; name: string }
  | { type: "bodies"; name: string; blocks: ReachedBody[] };

/**
 * Tries each candidate in the order Ruby looks a constant up and
 * settles on the first one that is a library root, one the walk is
 * already inside, or one the run defines. Null when it is none of them.
 */
async function settleConstant(
  candidates: readonly string[],
  roots: readonly string[],
  lookup: AncestorLookup,
  active: ReadonlySet<string>,
): Promise<SettledConstant | null> {
  for (const candidate of candidates) {
    if (roots.includes(candidate)) {
      return { type: "root", name: candidate };
    }
    if (active.has(candidate)) {
      return { type: "cycle", name: candidate };
    }
    const blocks = await definitionOf(candidate, lookup);
    if (blocks !== null) {
      return { type: "bodies", name: candidate, blocks };
    }
  }
  return null;
}

/** The class or module a constant reference settles on, or null when the run defines none of its candidates. */
export async function reachConstant(
  candidates: readonly string[],
  lookup: AncestorLookup,
): Promise<{ name: string; blocks: ReachedBody[] } | null> {
  const settled = await settleConstant(candidates, [], lookup, new Set());
  return settled?.type === "bodies" ? settled : null;
}

/**
 * A constant none of the candidates defines, which Ruby would reject with
 * a NameError. The chain keeps the bare name, since a configured base
 * class is written that way, so an unread ancestor still matches it.
 */
function unreadConstant(candidates: readonly string[]): AncestorEntry[] {
  const bare = candidates.at(-1);
  return bare === undefined ? [] : [{ type: "unfollowed", name: bare }];
}

function definitionOf(
  qualifiedName: string,
  lookup: AncestorLookup,
): Promise<ReachedBody[] | null> {
  const local = lookup.localDefinition?.(qualifiedName);
  return local !== undefined && local !== null
    ? Promise.resolve(local)
    : reachDefinition(qualifiedName, lookup);
}

/**
 * What one kind of mixin call adds to the chain. Each module's whole
 * chain is computed on its own and then filtered, so two concerns that
 * share a base put it where Ruby puts it, after both concerns.
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
    const inserted = (await mixinEntries(ref, lookup, active, present)).filter(
      (ancestor) => !present.has(ancestor.name),
    );
    for (const ancestor of inserted) {
      present.add(ancestor.name);
    }
    chain = [...inserted, ...chain];
  }
  return chain;
}

/** The entries one mixed-in module puts in the chain: its own chain when the run defines it, or its name alone when it does not. */
async function mixinEntries(
  ref: ModuleRef,
  lookup: AncestorLookup,
  active: ReadonlySet<string>,
  present: ReadonlySet<string>,
): Promise<AncestorEntry[]> {
  if (ref.candidates.length === 0) {
    return [{ type: "unfollowed", name: ref.text }];
  }
  const settled = await settleConstant(ref.candidates, [], lookup, active);
  if (settled === null) {
    return unreadConstant(ref.candidates);
  }
  // Ruby skips a module the chain already has, and rejects a cyclic include.
  if (settled.type !== "bodies" || present.has(settled.name)) {
    return [];
  }
  return chainOf(
    { type: "bodies", name: settled.name, blocks: settled.blocks },
    lookup,
    new Set([...active, settled.name]),
  );
}

/** One argument to an `include` or `prepend` call. `candidates` is empty for anything but a constant path, and the walk then uses the text as written. */
interface ModuleRef {
  text: string;
  /** Every name the constant could mean, in the order Ruby tries them. */
  candidates: readonly string[];
}

/**
 * The modules one kind of mixin call lists, in the order Ruby mixes them
 * in. Each call is inserted in front of the ones before it, and
 * `include A, B` mixes in B before A, so calls are read in source order
 * and one call's arguments backwards.
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
        refs.push({
          text: arg.text,
          candidates: constantRefCandidates(arg, block.info.bodyNesting),
        });
      }
    }
  }
  return refs;
}

/** The first reopening that declares a superclass decides; Ruby rejects a second one that disagrees. */
function superclassCandidatesOf(
  blocks: readonly ReachedBody[],
): readonly string[] {
  for (const block of blocks) {
    if (block.info.superclassCandidates.length > 0) {
      return block.info.superclassCandidates;
    }
  }
  return [];
}

/** What searching an ancestry for one method name came to. */
export type MethodLookup =
  /** `block` is the ancestor body the method is written in, which gives a caller its file. */
  | { type: "found"; method: RbNode; block: ReachedBody }
  /**
   * `reason` finishes the sentence "could be answered by a method ...".
   * `cause` gives the reason as a value, for a caller deciding whether
   * to look further. `unreadAncestor` is a base whose file the run could
   * not open, and `dynamicDefine` is a `define_method` call that defines
   * this name or whose own name did not settle.
   */
  | {
      type: "unsettled";
      reason: string;
      cause: "unreadAncestor" | "dynamicDefine";
    }
  | { type: "none" };

/**
 * The method `name` resolves to. An unread ancestor nearer than any
 * definition stops the search, since Ruby would have called that one first.
 */
export function methodInAncestry(
  ancestry: Ancestry,
  name: string,
  read: BodyReading = {},
): MethodLookup {
  for (const entry of ancestry) {
    if (entry.type === "root") {
      return { type: "none" };
    }
    if (entry.type === "unfollowed") {
      return {
        type: "unsettled",
        reason: `inherited from ${entry.name}, which this run did not read`,
        cause: "unreadAncestor",
      };
    }

    const found = definitionIn(entry.blocks, name, read);
    if (found.method !== null && found.block !== null) {
      return { type: "found", method: found.method, block: found.block };
    }
    if (found.definedDynamically || found.unreadableDefine) {
      return {
        type: "unsettled",
        reason: "defined with define_method, which this reader does not follow",
        cause: "dynamicDefine",
      };
    }
  }
  return { type: "none" };
}

/** What one ancestor's blocks show about `name`: its last definition, since a later `def` replaces an earlier one, and what the `define_method` calls in them define. */
function definitionIn(
  blocks: readonly ReachedBody[],
  name: string,
  read: BodyReading,
): {
  method: RbNode | null;
  block: ReachedBody | null;
  /** Whether a `define_method` here defines `name`, which has no body a reader of `def` nodes can see. */
  definedDynamically: boolean;
  /** Whether a `define_method` here has a name that did not fully settle, so it may define `name`. */
  unreadableDefine: boolean;
} {
  let method: RbNode | null = null;
  let block: ReachedBody | null = null;
  let definedDynamically = false;
  let unreadableDefine = false;
  for (const candidate of blocks) {
    const body = candidate.info.bodyNode;
    if (body === null) {
      continue;
    }
    const found = instanceMethodsByName(body, read.bodyBlocks).get(name);
    if (found !== undefined) {
      method = found;
      block = candidate;
    }
    const defined = definedNamesOf(
      read.dynamicNames,
      nodeId(candidate.file, candidate.info.node),
    );
    definedDynamically ||= defined.names.has(name);
    unreadableDefine ||= couldBeDefined(defined, name);
  }
  return { method, block, definedDynamically, unreadableDefine };
}

/** Every statement of every body reached, most distant ancestor first, so a nearer declaration overwrites what it inherits. */
export function inheritedStatements(
  ancestry: Ancestry,
  blockConfigures?: BlockConfigures,
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
      for (const statement of runStatements(body, blockConfigures)) {
        statements.push({ block, statement });
      }
    }
  }
  return statements;
}
