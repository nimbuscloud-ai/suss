/**
 * Resolves Ruby constant paths against lexical nesting.
 *
 * A compound reference such as `Data::Record` is read as absolute. A bare
 * name is relative to the nesting it is written inside, and so is a
 * compound name that `class` or `module` opens. `require` is never
 * resolved, because Rails autoloads by naming convention. A constant that
 * nesting alone cannot qualify keeps the name the source wrote.
 *
 * Ruby's `Module.nesting` puts each newly opened class or module on the
 * front of the chain, whether its name was bare or compound. Inside
 * `module Api; class Types::CampaignType`, a bare reference is still
 * looked up through `Api`.
 */

import { field, runStatements } from "./ast.js";

import type { RbNode } from "./parser.js";

/**
 * Qualifies a name against the innermost level of `nesting` only, which
 * gives the name a `class` or `module` keyword defines. Returns null for
 * a computed expression or a variable, which callers treat as
 * unresolved. To find the class a reference refers to, use
 * `constantRefCandidates`.
 */
export function qualifyConstantRef(
  node: RbNode,
  nesting: readonly string[],
): string | null {
  if (node.type === "scope_resolution") {
    return compoundName(node);
  }
  if (node.type === "constant") {
    const innermost = nesting[0] ?? null;
    return innermost === null ? node.text : `${innermost}::${node.text}`;
  }
  return null;
}

/**
 * Every qualified name a constant reference could mean, in the order Ruby
 * tries them. `module Api; class UsersController < ApplicationController`
 * gives `Api::ApplicationController` then `ApplicationController`. Which
 * one applies depends on which is defined, so the caller picks.
 */
export function constantRefCandidates(
  node: RbNode,
  nesting: readonly string[],
): string[] {
  if (node.type === "scope_resolution") {
    return [compoundName(node)];
  }
  if (node.type === "constant") {
    return [...nesting.map((level) => `${level}::${node.text}`), node.text];
  }
  return [];
}

/** The qualified name a compound path spells. `::Order` is `Order` looked up from the top level, so the leading `::` is not part of the name. */
export function compoundName(node: RbNode): string {
  return node.text.replace(/^::/, "");
}

/**
 * The project class a bare `constant` resolves to before Ruby ever
 * reaches a scalar. Ruby searches `Module.nesting` innermost first, so
 * the first match wins.
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
  /** Which keyword opened it. A module has no superclass and cannot be subclassed, but its methods are available to every class including it. */
  kind: "class" | "module";
  /** This class's own fully-qualified constant path. */
  qualifiedName: string;
  /** Null when it declares no superclass, or the expression is not a literal constant path. */
  superclassQualifiedName: string | null;
  /**
   * Every name the superclass expression can resolve to, in the order Ruby
   * tries them: each level of the enclosing nesting innermost first, then the
   * bare name at top level. A compound path is one entry. Empty when there is
   * no readable superclass.
   */
  superclassCandidates: readonly string[];
  /** `body_statement` node, or null for `class Foo; end`. */
  bodyNode: RbNode | null;
  /** `Module.nesting` in effect inside this class's own body, innermost first. */
  bodyNesting: readonly string[];
}

/** Every `class` declaration reachable from `root` through module/class nesting, in source order. */
export function walkClasses(
  root: RbNode,
  visit: (info: ClassInfo) => void,
): void {
  walkDefinitions(root, (info) => {
    if (info.kind === "class") {
      visit(info);
    }
  });
}

/** The same walk including `module` declarations, for a lookup that has to reach a module's own methods. */
export function walkDefinitions(
  root: RbNode,
  visit: (info: ClassInfo) => void,
): void {
  walkBody(runStatements(root), [], visit);
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
  }
}

/**
 * The qualified name a class or module's `name` field gives it, along with the
 * nesting chain inside its body. `bodyNesting` always puts the qualified name on
 * the front of `outerNesting`, whichever form the name took.
 *
 * A compound name opened inside a module is nested under it, so
 * `module Admin; class Users::RolesController` defines
 * `Admin::Users::RolesController`, which is also the constant the file's
 * path under `app/controllers/admin/users/` autoloads. Only a name
 * written with a leading `::` opens the class at the top level.
 */
function ownIdentity(
  nameNode: RbNode,
  outerNesting: readonly string[],
): { qualifiedName: string; bodyNesting: readonly string[] } | null {
  const qualifiedName = definedName(nameNode, outerNesting);
  if (qualifiedName === null) {
    return null;
  }
  return { qualifiedName, bodyNesting: [qualifiedName, ...outerNesting] };
}

function definedName(
  nameNode: RbNode,
  outerNesting: readonly string[],
): string | null {
  const innermost = outerNesting[0] ?? null;
  if (
    nameNode.type === "scope_resolution" &&
    innermost !== null &&
    !nameNode.text.startsWith("::")
  ) {
    return `${innermost}::${nameNode.text}`;
  }
  return qualifyConstantRef(nameNode, outerNesting);
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
  // Ruby evaluates the superclass expression in the scope where it is written,
  // before the class's own name goes onto the nesting chain.
  const superclassQualifiedName =
    superclassExpr !== null
      ? qualifyConstantRef(superclassExpr, nesting)
      : null;
  const superclassCandidates =
    superclassExpr !== null
      ? constantRefCandidates(superclassExpr, nesting)
      : [];
  const bodyNode = field(node, "body");

  visit({
    node,
    kind: "class",
    qualifiedName: identity.qualifiedName,
    superclassQualifiedName,
    superclassCandidates,
    bodyNode,
    bodyNesting: identity.bodyNesting,
  });

  if (bodyNode !== null) {
    walkBody(runStatements(bodyNode), identity.bodyNesting, visit);
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

  visit({
    node,
    kind: "module",
    qualifiedName: identity.qualifiedName,
    superclassQualifiedName: null,
    superclassCandidates: [],
    bodyNode,
    bodyNesting: identity.bodyNesting,
  });

  if (bodyNode !== null) {
    walkBody(runStatements(bodyNode), identity.bodyNesting, visit);
  }
}

/** A pack picks a convention by name, and `TYPE_NAME_CONVENTIONS` maps each name to its code. */
export type GraphqlTypeNameConvention = "stripTypeSuffix";

/**
 * A class's short name, meaning the segment after the last `::`, with a trailing
 * `Type` removed. `Types::CampaignType` becomes `Campaign` and `Types::QueryType`
 * becomes `Query`.
 */
function stripTypeSuffixName(qualifiedName: string): string {
  const shortName = qualifiedName.split("::").at(-1) ?? qualifiedName;
  return shortName.endsWith("Type") ? shortName.slice(0, -4) : shortName;
}

const TYPE_NAME_CONVENTIONS: Record<
  GraphqlTypeNameConvention,
  (qualifiedName: string) => string
> = {
  stripTypeSuffix: stripTypeSuffixName,
};

/** The GraphQL type name the convention derives from a class name. A name a class sets for itself is not read. */
export function graphqlTypeNameFromQualified(
  qualifiedName: string,
  convention: GraphqlTypeNameConvention,
): string {
  return TYPE_NAME_CONVENTIONS[convention](qualifiedName);
}
