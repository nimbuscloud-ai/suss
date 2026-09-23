/**
 * Which class a value belongs to, where a recognizer has the name a
 * call is read off.
 *
 * The source may state a type beside the name, as a parameter
 * annotation, an annotated assignment, or the class a `with ... as`
 * opens. Where it states none, the resolution rules say what type the
 * callers of a parameter declare, or what call wrote the name. The
 * class may be spelled as a plain name the file imported or as an
 * attribute on an imported module, and both mean the same class. The
 * answer is where the class came from rather than what it is called, so
 * a project alias in front of the library still arrives at the
 * library's own module and name.
 */

import { annotationTarget } from "./annotations.js";
import {
  children,
  enclosingFunction,
  field,
  parameterNameAndType,
  stringLiteralValue,
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

/** What a name nothing in the file declares is reported as, which says only that. */
const UNDECLARED_MODULE = "builtins";

/** The class an annotation refers to, by the name it is written under, read through a forward reference's quotes. */
export function typeNameOf(annotation: PyNode): string | null {
  const target = annotationTarget(annotation);
  if (target === null) {
    return null;
  }
  return target.type === "identifier"
    ? target.text
    : stringLiteralValue(target);
}

/** The first answer `read` gives for a statement in a body, past the nested functions, which bind a name of their own. */
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
 * Where the source states the class of a name, as the node the class is
 * written at. A type is not a value, so the resolution facts say
 * nothing about any of these spellings.
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
 * Where the class an annotation refers to came from. The rules answer
 * first, since they follow a project alias such as
 * `SessionDep = Annotated[Session, ...]` on to the library behind it.
 * What the annotation imports is the answer for a class written as an
 * attribute on an imported module, which is a name the rules never see.
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
 * Where the class of the value a name refers to came from. What the
 * source states wins, since a parameter has no construction to read.
 * Next is the type every caller of an unannotated parameter declares.
 * Otherwise the rules say what call wrote the name, which reaches
 * across modules and through a project function that builds the
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
