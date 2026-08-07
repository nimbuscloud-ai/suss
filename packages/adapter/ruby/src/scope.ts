// scope.ts: the lexical binder.
//
// Sized to what this slice needs, per the language-adapters proposal:
// class and module nesting, so a constant written where Ruby itself
// would resolve it lexically reads the way Ruby reads it, with nothing
// beyond that. `require` is not resolved (Rails autoloads by naming
// convention, not by an explicit load graph a static reader could
// follow): a constant path this module cannot qualify from nesting
// alone is recorded as the name it was written with, and callers treat
// that as an unresolved reference rather than a guess.
//
// Two constant shapes appear in graphql-ruby source. A compound path
// written out (`Types::BaseObject`, a `scope_resolution` node) names an
// absolute path the way Ruby itself resolves it, regardless of where
// it's written, so its text is the qualified name. A bare name (a
// `constant` node, e.g. `BaseObject` written inside `module Types`) is
// nesting-relative.
//
// `Module.nesting` itself always prepends the newly opened class or
// module onto whatever chain is already in effect, regardless of
// whether the name used to open it was bare or compound: nesting
// tracks lexical (textual) class/module keyword nesting, not the
// shape of the name. `module Api; class Types::CampaignType; end; end`
// carries `Api` on the chain inside `CampaignType`'s body exactly the
// way a bare name would, even though the class's own qualified name is
// the compound path as written, not `Api::Types::CampaignType`.
// Getting this wrong matters beyond cosmetics: a bare reference inside
// that body is resolved by trying each level of the chain before
// falling back to a scalar name (see typeShape.ts), and dropping `Api`
// from it would miss a class the body's own file defines there.

import { bodyStatements, field } from "./ast.js";

import type { RbNode } from "./parser.js";

/**
 * Qualify a `constant` or `scope_resolution` node against `nesting`
 * (innermost first, per `Module.nesting`'s own order). Null for any
 * other node shape, a computed expression, a variable, which callers
 * treat as unresolved rather than guessing a path for it. This always
 * answers with the innermost level, the same single-hop qualification
 * the roadmap's "modest resolver" calls for; `shadowingClassFor` is the
 * one place that walks every level, because only a shadow check needs
 * to.
 */
export function qualifyConstantRef(
  node: RbNode,
  nesting: readonly string[],
): string | null {
  if (node.type === "scope_resolution") {
    return node.text;
  }
  if (node.type === "constant") {
    const innermost = nesting[0] ?? null;
    return innermost === null ? node.text : `${innermost}::${node.text}`;
  }
  return null;
}

/**
 * The qualified name of a project-defined class that a bare `constant`
 * node would resolve to before Ruby ever reaches a scalar inherited
 * from a base class, or null when none of `knownClasses` (every class
 * this file itself defines) sits at any level of `nesting`. Ruby
 * searches `Module.nesting` innermost first, so the first match wins;
 * a compound `scope_resolution` path is already absolute and is never
 * shadowed by nesting, so this only ever answers for a bare name.
 */
export function shadowingClassFor(
  node: RbNode,
  nesting: readonly string[],
  knownClasses: ReadonlySet<string>,
): string | null {
  if (node.type !== "constant") {
    return null;
  }
  for (const level of nesting) {
    const candidate = `${level}::${node.text}`;
    if (knownClasses.has(candidate)) {
      return candidate;
    }
  }
  return knownClasses.has(node.text) ? node.text : null;
}

export interface ClassInfo {
  node: RbNode;
  /** This class's own fully-qualified constant path. */
  qualifiedName: string;
  /** The qualified path of its `< ...` superclass, or null when it declares none or the expression isn't a literal constant path. */
  superclassQualifiedName: string | null;
  /** `body_statement` node, or null for `class Foo; end`. */
  bodyNode: RbNode | null;
  /** `Module.nesting` in effect inside this class's own body, innermost first: this class's own qualified name prepended onto the chain it's textually nested inside, the same whether its own name was written bare or compound. */
  bodyNesting: readonly string[];
}

/**
 * Walk every `class` declaration reachable from `root` through direct
 * module/class nesting (not through anything requiring `require`
 * resolution), calling `visit` with each one's qualified identity. Used
 * both for the main project scan (find classes matching a pack's base
 * class names) and for reading one specific file located by the
 * constant-to-path convention (find the class matching a target name).
 */
export function walkClasses(
  root: RbNode,
  visit: (info: ClassInfo) => void,
): void {
  walkBody(bodyStatements(root), [], visit);
}

function walkBody(
  statements: RbNode[],
  nesting: readonly string[],
  visit: (info: ClassInfo) => void,
): void {
  for (const stmt of statements) {
    if (stmt.type === "class") {
      visitClass(stmt, nesting, visit);
      continue;
    }
    if (stmt.type === "module") {
      visitModule(stmt, nesting, visit);
    }
    // Every other statement shape (assignment, if/unless, a bare call,
    // ...) introduces no class/module at this body's level for v0's
    // purposes.
  }
}

/**
 * The qualified name a class/module's own `name` field gives it, and
 * the `Module.nesting` chain in effect inside its body, given the
 * chain it's textually written inside (`outerNesting`). The qualified
 * name itself follows `qualifyConstantRef`'s own rule (a compound path
 * is absolute as written; a bare name is qualified against the
 * innermost outer level); `bodyNesting` always prepends that qualified
 * name onto `outerNesting`, because nesting inside the new body
 * carries the full lexical chain regardless of which shape the name
 * took.
 */
function ownIdentity(
  nameNode: RbNode,
  outerNesting: readonly string[],
): { qualifiedName: string; bodyNesting: readonly string[] } | null {
  const qualifiedName = qualifyConstantRef(nameNode, outerNesting);
  if (qualifiedName === null) {
    return null;
  }
  return { qualifiedName, bodyNesting: [qualifiedName, ...outerNesting] };
}

function visitClass(
  node: RbNode,
  nesting: readonly string[],
  visit: (info: ClassInfo) => void,
): void {
  const nameNode = field(node, "name");
  const identity = nameNode !== null ? ownIdentity(nameNode, nesting) : null;
  if (identity === null) {
    return;
  }
  const superclassWrapper = field(node, "superclass");
  const superclassExpr = superclassWrapper?.namedChild(0) ?? null;
  // The superclass expression is evaluated in the scope it's textually
  // written in, before the class's own name joins nesting.
  const superclassQualifiedName =
    superclassExpr !== null
      ? qualifyConstantRef(superclassExpr, nesting)
      : null;
  const bodyNode = field(node, "body");

  visit({
    node,
    qualifiedName: identity.qualifiedName,
    superclassQualifiedName,
    bodyNode,
    bodyNesting: identity.bodyNesting,
  });

  if (bodyNode !== null) {
    walkBody(bodyStatements(bodyNode), identity.bodyNesting, visit);
  }
}

function visitModule(
  node: RbNode,
  nesting: readonly string[],
  visit: (info: ClassInfo) => void,
): void {
  const nameNode = field(node, "name");
  const identity = nameNode !== null ? ownIdentity(nameNode, nesting) : null;
  if (identity === null) {
    return;
  }
  const bodyNode = field(node, "body");
  if (bodyNode !== null) {
    walkBody(bodyStatements(bodyNode), identity.bodyNesting, visit);
  }
}

/**
 * The GraphQL type name graphql-ruby derives by default for a class:
 * its own short name (the segment after the last `::`), with a
 * trailing `Type` stripped. `Types::CampaignType` reads as `Campaign`,
 * `Types::QueryType` as `Query`. This is the library's own
 * `default_graphql_name` convention (an explicit `graphql_name`
 * override is not read in v0).
 */
export function graphqlTypeNameFromQualified(qualifiedName: string): string {
  const shortName = qualifiedName.split("::").at(-1) ?? qualifiedName;
  return shortName.endsWith("Type") ? shortName.slice(0, -4) : shortName;
}
