/**
 * The class of the value a method is called on, for a recognizer that
 * has the receiver's name.
 *
 * The source may state a type beside the name, as a parameter
 * annotation, an annotated assignment, or the class a `with ... as`
 * opens. When it states none, the resolution rules give the type the
 * callers of a parameter declare, or the call that assigned the name.
 * `Client` imported by name and `bigquery.Client` off an imported module
 * resolve to the same class. The result is the module and name the class
 * came from, so a project alias for a library class still resolves to
 * the library's own module and name.
 */

import { annotationTarget, typeNameOf } from "./annotations.js";
import {
  children,
  enclosingFunction,
  field,
  parameterNameAndType,
} from "./ast.js";
import {
  declaredTypeOrigins,
  originsOf,
  subjectConstructions,
} from "./facts/resolve.js";
import { nameKeyIn } from "./facts/values.js";
import { constructionBehind, moduleOf } from "./values/evaluator.js";
import { originOf } from "./values/origin.js";

import type { Database } from "@suss/datalog";
import type { SubjectOrigin } from "./facts/resolve.js";
import type { PyNode } from "./parser.js";

export interface ReceiverTypeOptions {
  readonly facts: Database;
  readonly filePath: string;
}

/** `originOf` puts a name nothing in the file declares under this module, which says nothing about where the class came from. */
const UNDECLARED_MODULE = "builtins";

/** The first non-null result of `read` over a body's statements. Nested functions are skipped because they bind names of their own. */
export function firstInBody<T>(
  node: PyNode,
  read: (statement: PyNode) => T | null,
): T | null {
  const here = read(node);
  if (here !== null) {
    return here;
  }
  for (const child of children(node)) {
    if (child.type === "function_definition" || child.type === "lambda") {
      continue;
    }
    const found = firstInBody(child, read);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** The type one statement states for `name`: the annotation on an assignment to it, or the class a `with ... as` opens. */
function statedBy(statement: PyNode, name: string): PyNode | null {
  if (statement.type === "assignment") {
    const annotation = field(statement, "type");
    return field(statement, "left")?.text === name ? annotation : null;
  }
  if (statement.type === "as_pattern") {
    const alias = field(statement, "alias");
    // The grammar gives the alias a field and leaves the value bare.
    const value = statement.namedChildren[0] ?? null;
    const callee = value?.type === "call" ? field(value, "function") : null;
    return alias?.text === name ? callee : null;
  }
  return null;
}

/**
 * The node where the source states the class of a name. A type is not a
 * value, so the resolution facts do not cover any of these spellings.
 */
export function statedTypeNode(name: string, from: PyNode): PyNode | null {
  const fn = enclosingFunction(from);
  if (fn === null) {
    return null;
  }
  const params = field(fn, "parameters");
  for (const param of params === null ? [] : children(params)) {
    const info = parameterNameAndType(param);
    if (info?.name === name && info.typeNode !== null) {
      return info.typeNode;
    }
  }
  const body = field(fn, "body");
  return body === null
    ? null
    : firstInBody(body, (statement) => statedBy(statement, name));
}

/** The class the enclosing function states for a name, by the name that class is written under. */
export function statedTypeName(name: string, from: PyNode): string | null {
  const stated = statedTypeNode(name, from);
  return stated === null ? null : typeNameOf(stated);
}

/**
 * Where the class an annotation refers to came from. The rules go first,
 * because they follow a project alias such as
 * `SessionDep = Annotated[Session, ...]` to the library class behind it.
 * A class written as an attribute on an imported module is not a name the
 * rules see, so its import is added as well.
 */
function statedOrigins(
  stated: PyNode,
  options: ReceiverTypeOptions,
): readonly SubjectOrigin[] {
  const name = typeNameOf(stated);
  const byRule =
    name === null
      ? []
      : originsOf(options.facts, `${options.filePath}#${name}`);
  const target = annotationTarget(stated);
  const imported = target === null ? null : originOf(target, moduleOf(target));
  if (imported === null || imported.module === UNDECLARED_MODULE) {
    return byRule;
  }
  return [...byRule, imported];
}

/**
 * Where the class of the value a name refers to came from. A type the
 * source states comes first, since a parameter has no construction to
 * read. Next is the type every caller of an unannotated parameter
 * declares. Last is the call that assigned the name, which the rules
 * follow across modules and through a project function that builds the
 * object.
 */
export function receiverTypeOrigins(
  receiver: PyNode,
  options: ReceiverTypeOptions,
): readonly SubjectOrigin[] {
  const stated = statedTypeNode(receiver.text, receiver);
  if (stated !== null) {
    return statedOrigins(stated, options);
  }
  const key = nameKeyIn(
    options.filePath,
    enclosingFunction(receiver),
    receiver.text,
  );
  const declared = declaredTypeOrigins(options.facts, key);
  if (declared.length > 0) {
    return declared;
  }
  const built = constructionBehind(receiver, options.facts);
  if (built.type === "oneCall") {
    return [built.construction.origin];
  }
  return subjectConstructions(options.facts, [key]).get(key)?.origins ?? [];
}
