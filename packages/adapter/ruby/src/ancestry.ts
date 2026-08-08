// ancestry.ts: the chain a lookup walks to find what answers for a
// class. See this package's README for why it walks and where it stops.

import {
  bareCallArguments,
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

/** Ruby's own dynamic definition. A method defined this way is called the same as any other and is invisible to a reader of `def` nodes. */
const DEFINE_METHOD_CALL = "define_method";

/** One class or module body a walk reached, with the definitions its own file makes, since a bare constant is shadowed per file. */
export interface ReachedBody {
  info: ClassInfo;
  knownClasses: ReadonlySet<string>;
}

/** Everything a lookup may search, and the ancestor it could not follow. */
export interface Ancestry {
  /** Every body reached, in Ruby's own lookup order: what a class prepends, the class, what it includes, then its superclass and that chain. */
  bodies: ReachedBody[];
  /** The first ancestor the walk could not follow, or null when it followed every one. */
  unfollowed: string | null;
}

/** What a walk needs to reach a class it holds only the name of. */
export interface AncestorLookup {
  /** Directory the constant-to-path convention resolves an ancestor's name against. */
  root: string;
  pathConvention: ConstantPathConvention;
  /**
   * The library's own classes a project's chain ends at. Reaching one
   * ends a walk with nothing left unfollowed: above it is the library,
   * which defines no method answering a project's field.
   */
  ancestryRootClassNames: readonly string[];
  parsedFile(absPath: string): Promise<RbNode | null>;
}

/**
 * Every block a file defines under `qualifiedName`, or null when the
 * constant-to-path convention names no file, no file sits there, or
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
  // A class can be reopened more than once in the same file, ordinary
  // Ruby, and every block contributes.
  const matches = all.filter((info) => info.qualifiedName === qualifiedName);
  if (matches.length === 0) {
    return null;
  }
  const knownClasses = new Set(all.map((info) => info.qualifiedName));
  return matches.map((info) => ({ info, knownClasses }));
}

export async function ancestryOf(
  start: readonly ReachedBody[],
  lookup: AncestorLookup,
): Promise<Ancestry> {
  const bodies: ReachedBody[] = [];
  const seen = new Set(start.map((body) => body.info.qualifiedName));
  const unfollowed = await collect(start, lookup, seen, bodies);
  return { bodies, unfollowed };
}

/** A constant a `include`/`prepend` call names, as the qualified path it resolves to and as it was written. */
interface ModuleRef {
  qualifiedName: string | null;
  text: string;
}

/**
 * Append everything `blocks` inherits from, in lookup order, and
 * answer with the first ancestor that could not be followed.
 */
async function collect(
  blocks: readonly ReachedBody[],
  lookup: AncestorLookup,
  seen: Set<string>,
  out: ReachedBody[],
): Promise<string | null> {
  const prepended = await appendModules(
    moduleRefs(blocks, PREPEND_CALL),
    lookup,
    seen,
    out,
  );
  if (prepended !== null) {
    return prepended;
  }

  out.push(...blocks);

  const included = await appendModules(
    moduleRefs(blocks, INCLUDE_CALL),
    lookup,
    seen,
    out,
  );
  if (included !== null) {
    return included;
  }

  const superclass = superclassOf(blocks);
  if (
    superclass === null ||
    lookup.ancestryRootClassNames.includes(superclass) ||
    seen.has(superclass)
  ) {
    return null;
  }
  seen.add(superclass);
  const reached = await reachDefinition(superclass, lookup);
  if (reached === null) {
    return superclass;
  }
  return collect(reached, lookup, seen, out);
}

async function appendModules(
  refs: readonly ModuleRef[],
  lookup: AncestorLookup,
  seen: Set<string>,
  out: ReachedBody[],
): Promise<string | null> {
  for (const ref of refs) {
    if (ref.qualifiedName === null) {
      return ref.text;
    }
    if (seen.has(ref.qualifiedName)) {
      continue;
    }
    seen.add(ref.qualifiedName);
    const reached = await reachDefinition(ref.qualifiedName, lookup);
    if (reached === null) {
      return ref.qualifiedName;
    }
    const unfollowed = await collect(reached, lookup, seen, out);
    if (unfollowed !== null) {
      return unfollowed;
    }
  }
  return null;
}

/** Ruby searches the most recently mixed-in module first, so these come back in reverse source order. */
function moduleRefs(
  blocks: readonly ReachedBody[],
  callName: string,
): ModuleRef[] {
  const refs: ModuleRef[] = [];
  for (const block of blocks) {
    if (block.info.bodyNode === null) {
      continue;
    }
    for (const arg of bareCallArguments(block.info.bodyNode, callName)) {
      refs.push({
        qualifiedName: qualifyConstantRef(arg, block.info.bodyNesting),
        text: arg.text,
      });
    }
  }
  return refs.reverse();
}

function superclassOf(blocks: readonly ReachedBody[]): string | null {
  for (const block of blocks) {
    if (block.info.superclassQualifiedName !== null) {
      return block.info.superclassQualifiedName;
    }
  }
  return null;
}

/**
 * The method `name` resolves to: the nearest ancestor defining it wins,
 * and within that ancestor the last definition does, the way Ruby's own
 * redefinition works across reopened blocks.
 */
export function methodInAncestry(
  ancestry: Ancestry,
  name: string,
): RbNode | null {
  let found: RbNode | null = null;
  let foundIn: string | null = null;
  for (const body of ancestry.bodies) {
    if (body.info.bodyNode === null) {
      continue;
    }
    const method = instanceMethodsByName(body.info.bodyNode).get(name);
    if (method === undefined) {
      continue;
    }
    if (found !== null && body.info.qualifiedName !== foundIn) {
      break;
    }
    found = method;
    foundIn = body.info.qualifiedName;
  }
  return found;
}

/** Whether any body reached defines methods dynamically, which a reader of `def` nodes cannot see and `public_send` would still call. */
export function definesMethodsDynamically(ancestry: Ancestry): boolean {
  return ancestry.bodies.some(
    (body) =>
      body.info.bodyNode !== null &&
      bareCallArguments(body.info.bodyNode, DEFINE_METHOD_CALL).length > 0,
  );
}

/** Every statement of every body reached, most distant ancestor first, so a nearer declaration overwrites what it inherits. */
export function inheritedStatements(
  ancestry: Ancestry,
): Array<{ block: ReachedBody; statement: RbNode }> {
  const statements: Array<{ block: ReachedBody; statement: RbNode }> = [];
  for (const block of [...ancestry.bodies].reverse()) {
    if (block.info.bodyNode === null) {
      continue;
    }
    for (const statement of bodyStatements(block.info.bodyNode)) {
      statements.push({ block, statement });
    }
  }
  return statements;
}
