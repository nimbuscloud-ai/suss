/**
 * associations.ts: reading `has_many :statuses` out of a model's body.
 *
 * A pack says which calls declare an association. The target is the
 * class the `class_name:` keyword gives, or the association's own name
 * put through ActiveSupport's default inflections when the declaration
 * gives none. That inflected name is written nowhere in the source, so
 * the declaration comes with a constant reference of its own and the
 * constant bindings settle it from the nesting the model is written in:
 * a `has_many :statuses` inside `Admin::Account` reaches `Admin::Status`
 * before it reaches `Status`.
 */

import {
  field,
  readCallArgs,
  runStatements,
  stringLiteralValue,
} from "../ast.js";
import { associationTargetName } from "../inflect.js";

import type { RbAssociationCalls } from "../pack.js";
import type { RbNode } from "../parser.js";
import type { ConstantReference } from "./constants.js";

/** One association a class or module body declares. */
export interface AssociationDeclaration {
  /** The class or module whose body declares it, keyed the way a class is. */
  readonly classKey: string;
  /** The association's name, as the call writes it. */
  readonly name: string;
  /** The class it reaches, as a reference the constant bindings settle. */
  readonly target: ConstantReference;
}

/** The name a call gives an association, written as a symbol or as a string. */
function declaredName(argument: RbNode | undefined): string | null {
  if (argument === undefined) {
    return null;
  }
  if (argument.type === "simple_symbol") {
    return argument.text.slice(1);
  }
  return stringLiteralValue(argument);
}

/** A reference read from the nesting it is written in, unless `::Status` pins it to the top level. */
function targetReference(
  key: string,
  written: string,
  nesting: readonly string[],
): ConstantReference {
  if (written.startsWith("::")) {
    return { key, written: written.slice(2), nesting: [] };
  }
  return { key, written, nesting };
}

/**
 * The name of the class one declaration reaches, or null when the call
 * writes a `class_name:` this cannot read. Falling back to the
 * inflection there would point the association at the wrong class.
 */
function targetName(
  call: RbNode,
  calls: RbAssociationCalls,
  name: string,
  plural: boolean,
): string | null {
  const override = readCallArgs(field(call, "arguments")).keyword[
    calls.classNameKeyword
  ];
  if (override === undefined) {
    return associationTargetName(name, plural);
  }
  return stringLiteralValue(override);
}

/**
 * Every association declared in one class or module body, the ones
 * inside an `included do` or a `with_options` block included. `nesting`
 * is the enclosing module and class names, outermost first, and is
 * where the lookup of a target reference starts.
 */
export function associationsDeclaredIn(
  cls: RbNode,
  classKey: string,
  nesting: readonly string[],
  calls: readonly RbAssociationCalls[],
): AssociationDeclaration[] {
  const body = field(cls, "body");
  if (body === null || calls.length === 0) {
    return [];
  }

  const found: AssociationDeclaration[] = [];
  for (const statement of runStatements(body)) {
    if (statement.type !== "call" || field(statement, "receiver") !== null) {
      continue;
    }
    const method = field(statement, "method")?.text ?? "";
    for (const declaration of calls) {
      const plural = declaration.plural.includes(method);
      if (!plural && !declaration.singular.includes(method)) {
        continue;
      }
      const positional = readCallArgs(field(statement, "arguments")).positional;
      const name = declaredName(positional[0]);
      if (name === null) {
        continue;
      }
      const written = targetName(statement, declaration, name, plural);
      if (written === null) {
        continue;
      }
      found.push({
        classKey,
        name,
        target: targetReference(
          `${classKey}#association:${name}`,
          written,
          nesting,
        ),
      });
    }
  }
  return found;
}
