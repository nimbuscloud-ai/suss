/**
 * The name of the model class a Python expression refers to, as an ORM
 * query names its table.
 *
 * Python writes a class in CapWords and a variable in lowercase, which is
 * how `Item` is told from `item` without a type checker: the class is its
 * own name, and the variable is whatever the enclosing function declares
 * it as, by its annotation or by the call it is assigned from. The storage
 * reader and the fact source's `classNameOf` both read a model this way,
 * so a column and the container it belongs to are named alike.
 */

import { answersFor } from "@suss/resolution";

import { children, enclosingFunction, field } from "./ast.js";
import { originsOf, resolveCalls, settledFunction } from "./facts/resolve.js";
import { readKey } from "./facts/values.js";
import {
  firstInBody,
  receiverTypeOrigins,
  statedTypeName,
} from "./receiverTypes.js";

import type { Database } from "@suss/datalog";
import type { PyNode } from "./parser.js";

/** What reading a model's name needs: the run's facts, the file, and the libraries whose own types are no model. */
export interface ModelNaming {
  readonly facts: Database;
  readonly filePath: string;
  /** Top-level packages, `sqlalchemy`, whose types are statements and columns rather than models. */
  readonly libraries: ReadonlySet<string>;
}

/** The call a method is read off, or null when the callee is not a method read. */
function receiverCall(call: PyNode): PyNode | null {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "attribute") {
    return null;
  }
  const object = field(callee, "object");
  return object !== null && object.type === "call" ? object : null;
}

/** The call a chain starts at, following receivers down. */
export function rootOf(call: PyNode): PyNode {
  const receiver = receiverCall(call);
  return receiver === null ? call : rootOf(receiver);
}

export const topPackage = (module: string): string =>
  module.split(".")[0] ?? module;

export function isClassName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(name) && name !== name.toUpperCase();
}

/**
 * The model an expression refers to: a class by its own name, a variable
 * by what the enclosing function of `from` declares it as, an attribute by
 * a CapWords member (`models.Item`) or what it is read off (`Item.id`),
 * and a call by its callee or its first argument (`func.count(Item.id)`).
 */
export function modelNamed(
  node: PyNode,
  from: PyNode,
  naming: ModelNaming,
): string | null {
  if (node.type === "identifier") {
    if (isClassName(node.text)) {
      return node.text;
    }
    if (declaredAsLibraryType(node, naming)) {
      return null;
    }
    const declared = declaredTypeName(node.text, from, naming);
    return declared === null ? null : classBehind(declared, naming);
  }
  if (node.type === "attribute") {
    // `Item.id` and `models.Item` both refer to `Item`; `self.model` says nothing.
    const property = field(node, "attribute");
    if (property !== null && isClassName(property.text)) {
      return property.text;
    }
    const object = field(node, "object");
    return object === null ? null : modelNamed(object, from, naming);
  }
  if (node.type === "call") {
    // `Item(name=...)` builds one, and `func.count(Item.id)` counts one.
    const callee = field(node, "function");
    const built = callee === null ? null : modelNamed(callee, from, naming);
    return built ?? modelArgument(node, from, naming);
  }
  return null;
}

/** The model in the call's first positional argument, or null. */
function modelArgument(
  call: PyNode,
  from: PyNode,
  naming: ModelNaming,
): string | null {
  const args = field(call, "arguments");
  const first = (args === null ? [] : children(args)).find(
    (argument) => argument.type !== "keyword_argument",
  );
  return first === undefined ? null : modelNamed(first, from, naming);
}

/**
 * The class a call builds: `Session()` builds a Session, a class method
 * such as `User.model_validate(data)` gives back one of its class, and a
 * method given a class as its first argument, `db.get(Orders, 1)` or the
 * `db.query(Orders)` a chain starts at, gives back one of that class.
 * A function the project wrote, `get_user_by_email(...)`, gives back what
 * its annotation says.
 */
function builtType(call: PyNode, naming: ModelNaming): string | null {
  const root = rootOf(call);
  const callee = field(root, "function");
  if (callee?.type === "identifier") {
    return isClassName(callee.text)
      ? callee.text
      : resolvedReturnType(naming, callee);
  }
  const object = callee?.type === "attribute" ? field(callee, "object") : null;
  if (object?.type === "identifier" && isClassName(object.text)) {
    return object.text;
  }
  const args = field(root, "arguments");
  const first = (args === null ? [] : children(args))[0];
  if (first?.type === "identifier" && isClassName(first.text)) {
    return first.text;
  }
  return callee === null ? null : resolvedReturnType(naming, callee);
}

/** What the project function a callee resolves to says it returns, or null when it resolves to none or to more than one. */
function resolvedReturnType(
  naming: ModelNaming,
  callee: PyNode,
): string | null {
  const settled = settledCallee(naming, callee);
  return settled === undefined ? null : returnTypeName(naming.facts, settled);
}

/** The one definition a callee resolves to, asking the rules. Undefined when it resolves to none or to more than one. */
export function settledCallee(
  naming: { readonly facts: Database; readonly filePath: string },
  callee: PyNode,
): string | undefined {
  const key = readKey(naming.filePath, callee, enclosingFunction(callee));
  resolveCalls(naming.facts, [key]);
  return settledFunction(naming.facts, key) ?? undefined;
}

/** What the function at a resolved key says it gives back, as the name written in its annotation. */
export function returnTypeName(facts: Database, key: string): string | null {
  const [row] = facts.lookup("returnsNamed", 0, key);
  return row === undefined ? null : String(row[1]);
}

/**
 * The class returned by the call a name is assigned from. This walks the
 * body itself instead of asking the rules, because the rules settle the
 * value only when the class is one the file imported. Here it can also be
 * a project class, a method read off one, or a return annotation.
 */
function builtTypeName(
  name: string,
  from: PyNode,
  naming: ModelNaming,
): string | null {
  const fn = enclosingFunction(from);
  const body = fn === null ? null : field(fn, "body");
  if (body === null) {
    return null;
  }
  return firstInBody(body, (statement) => {
    const right =
      statement.type === "assignment" ? field(statement, "right") : null;
    return right?.type === "call" && field(statement, "left")?.text === name
      ? builtType(right, naming)
      : null;
  });
}

/** The class a name has in the enclosing function: its annotation, or what the call it is assigned from builds. */
function declaredTypeName(
  name: string,
  from: PyNode,
  naming: ModelNaming,
): string | null {
  return statedTypeName(name, from) ?? builtTypeName(name, from, naming);
}

/**
 * Whether a variable is declared as one of the library's own types, such
 * as `query: Select` or `column: ColumnElement` in SQLAlchemy. Those are
 * statements and columns, never one of the project's models.
 */
function declaredAsLibraryType(variable: PyNode, naming: ModelNaming): boolean {
  return receiverTypeOrigins(variable, naming).some((origin) =>
    naming.libraries.has(topPackage(origin.module)),
  );
}

/**
 * The class a declared type is an alias of. `current_user: CurrentUser`
 * with `CurrentUser = Annotated[User, Depends(get_current_user)]` in the
 * file or in a module it imports from declares a `User`, the class the
 * shared rules say the name reaches. A name that reaches no project class
 * is returned as it is when it is written like a class name.
 */
function classBehind(typeName: string, naming: ModelNaming): string | null {
  const key = `${naming.filePath}#${typeName}`;
  originsOf(naming.facts, key);
  const reached = new Set(answersFor(naming.facts, "wantedComesTo", key));
  const classes = new Set(
    naming.facts
      .facts("objectValue")
      .map((row) => String(row[0]))
      .filter((value) => reached.has(value)),
  );
  const exported = naming.facts
    .facts("exportsAs")
    .find((row) => classes.has(String(row[2])));
  if (exported !== undefined) {
    return String(exported[1]);
  }
  return isClassName(typeName) ? typeName : null;
}
