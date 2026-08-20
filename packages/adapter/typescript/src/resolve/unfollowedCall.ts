/**
 * unfollowedCall.ts: naming the calls the reachable closure stops at.
 *
 * The closure follows a call by resolving its callee to a function with a
 * body. When that fails the edge is dropped, and a unit whose body is full
 * of dropped edges produces the same empty summary as a unit that does
 * nothing. This module says which kind of stop a call site is, and which
 * kinds are worth leaving a gap for.
 *
 * The README beside this file explains where that line is drawn, and why
 * a call into a dependency stays on the other side of it.
 */

import {
  Node,
  type SourceFile,
  SyntaxKind,
  type Symbol as TsSymbol,
} from "ts-morph";

import { recordFileDependency } from "../depTracking.js";

import type { Gap } from "@suss/behavioral-ir";
import type { FunctionRoot } from "../conditions.js";

/**
 * Why the walk stopped.
 *
 * `noBody` is a declaration the project wrote that states a shape and
 * nothing else: a method on an interface, an abstract method, an ambient
 * declaration. `unsettledValue` is a callee the project declares as
 * something other than a function, a parameter or a field with something
 * in it that could not be read. `outsideRun` is a declaration in a
 * dependency, whose source this run never read. `noDeclaration` is a
 * callee nothing declares, which is what a call on an untyped value
 * comes to.
 */
export type UnfollowedReason =
  | "noBody"
  | "unsettledValue"
  | "outsideRun"
  | "noDeclaration";

/** One call the walk met and could not follow. */
export interface UnfollowedCall {
  /** The callee as the source writes it, `this.dao.getEditions` say. */
  readonly callee: string;
  readonly reason: UnfollowedReason;
}

// ---------------------------------------------------------------------------
// Whether a declaration can be followed at all
// ---------------------------------------------------------------------------

export function isInExternalCode(sourceFile: SourceFile): boolean {
  if (sourceFile.isDeclarationFile()) {
    return true;
  }
  // ts-morph surfaces node_modules files that anything imported reaches.
  // Package boundaries go through the packageExports and packageImport
  // packs instead of through this walk.
  return sourceFile.getFilePath().includes("/node_modules/");
}

export function hasBody(fn: FunctionRoot): boolean {
  // Ambient declarations and overload signatures have no body node, and
  // walking into one would summarize a signature as if it were code.
  if (
    Node.isFunctionDeclaration(fn) ||
    Node.isMethodDeclaration(fn) ||
    Node.isFunctionExpression(fn)
  ) {
    return fn.getBody?.() !== undefined;
  }
  return true;
}

/**
 * Whether a declaration states a shape rather than declaring a value.
 * A call landing on one is a call whose implementation is somewhere
 * else in the project.
 */
export function isDeclaredShape(declaration: Node): boolean {
  return (
    (Node.isMethodSignature(declaration) ||
      Node.isPropertySignature(declaration)) &&
    !isInExternalCode(declaration.getSourceFile())
  );
}

/**
 * Whether the code behind a declaration is somewhere this run never
 * read. An import declares a name in a project file and says the code is
 * in another module, so that module is what decides. A module specifier
 * nothing resolved counts as external for the same reason: the walk had
 * nothing to read either way.
 */
function isExternalDeclaration(declaration: Node): boolean {
  // Cheapest test first, and the one most call sites end at: a codebase
  // makes far more calls into its dependencies than into anything the
  // two walks below have to look for.
  if (isInExternalCode(declaration.getSourceFile())) {
    return true;
  }
  if (
    Node.isImportSpecifier(declaration) ||
    Node.isImportClause(declaration) ||
    Node.isNamespaceImport(declaration)
  ) {
    const target = declaration
      .getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
      ?.getModuleSpecifierSourceFile();
    return target === undefined || isInExternalCode(target);
  }
  return declaresAnotherModule(declaration);
}

/**
 * Whether a declaration is written inside `declare module "name"`, which
 * describes what some other package contains. A project file can carry
 * one, and what it describes still lives in a package this run never
 * read.
 */
function declaresAnotherModule(declaration: Node): boolean {
  const module = declaration.getFirstAncestorByKind(
    SyntaxKind.ModuleDeclaration,
  );
  return module !== undefined && Node.isStringLiteral(module.getNameNode());
}

/**
 * A declaration the project wrote that the walk cannot enter, because it
 * states a signature and leaves the body to whoever implements it.
 */
function statesShapeOnly(declaration: Node): boolean {
  if (isExternalDeclaration(declaration)) {
    return false;
  }
  if (
    Node.isMethodSignature(declaration) ||
    Node.isPropertySignature(declaration)
  ) {
    return true;
  }
  if (
    Node.isFunctionDeclaration(declaration) ||
    Node.isMethodDeclaration(declaration)
  ) {
    return declaration.getBody() === undefined;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Classifying a stop
// ---------------------------------------------------------------------------

/**
 * Every declaration behind a callee, with an imported or re-exported
 * name followed through to its last one. A barrel that forwards a
 * dependency's function would otherwise look like project code, because
 * the only declaration in sight is the import in the calling file.
 */
export function declarationsBehind(symbol: TsSymbol | undefined): Node[] {
  if (symbol === undefined) {
    return [];
  }
  const behind = symbol.getAliasedSymbol()?.getDeclarations() ?? [];
  return behind.length > 0 ? behind : symbol.getDeclarations();
}

/**
 * Which kind of stop a call site is, given every declaration the type
 * checker offered for its callee. Asked only once the walk has failed to
 * reach a function with a body through any of them.
 */
export function classifyStop(declarations: readonly Node[]): UnfollowedReason {
  if (declarations.length === 0) {
    return "noDeclaration";
  }
  // A stop still read the project files it stopped at: a change there
  // can make the call followable, which changes the gap.
  for (const declaration of declarations) {
    if (!isInExternalCode(declaration.getSourceFile())) {
      recordFileDependency(declaration.getSourceFile().getFilePath());
    }
  }
  if (declarations.every(isExternalDeclaration)) {
    return "outsideRun";
  }
  if (declarations.some(statesShapeOnly)) {
    return "noBody";
  }
  return "unsettledValue";
}

/**
 * Whether a stop of this kind leaves a gap. The two that are left out
 * fail the same test: nothing about either says the callee is code the
 * project owns, so a gap on them buys volume rather than a place to
 * look. The run already describes a call into a dependency, as a
 * boundary crossing, and a call on an untyped value could go anywhere.
 */
const RECORDED: Record<UnfollowedReason, boolean> = {
  noBody: true,
  unsettledValue: true,
  outsideRun: false,
  noDeclaration: false,
};

export function worthRecording(reason: UnfollowedReason): boolean {
  return RECORDED[reason];
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

const STOP_SENTENCE: Record<UnfollowedReason, (callee: string) => string> = {
  noBody: (callee) =>
    `The call to ${callee} lands on a declaration with no body, so whatever runs there is missing from this summary`,
  unsettledValue: (callee) =>
    `The call to ${callee} goes through a value this run could not settle, so whatever runs there is missing from this summary`,
  outsideRun: (callee) =>
    `The call to ${callee} lands in a package whose source is not in this run, so whatever runs there is missing from this summary`,
  noDeclaration: (callee) =>
    `The call to ${callee} has no declaration this run could find, so whatever runs there is missing from this summary`,
};

export function unfollowedCallGap(stop: UnfollowedCall): Gap {
  return {
    type: "unfollowedCall",
    conditions: [],
    consequence: "unknown",
    description: STOP_SENTENCE[stop.reason](stop.callee),
  };
}
