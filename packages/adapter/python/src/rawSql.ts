/**
 * Which calls in a body hand the database a statement written as SQL.
 *
 * A pack says how its library takes one. SQLAlchemy exports a function,
 * `text`, and a cloud warehouse hands the project a client object whose
 * methods take the statement instead. A call matching either becomes the
 * same storage-access effect a query through an ORM would have produced,
 * one per table.
 *
 * The statement goes through the shared value evaluator, so what the
 * evaluator cannot settle becomes a parameter. The adapter's README says
 * how a table name reaches the boundary.
 */

import { storageBinding } from "@suss/ir-core";
import { readSqlAccess, splitQualifiedTable, sqlFromParts } from "@suss/sql";
import { force } from "@suss/values";

import { children, field } from "./ast.js";
import { receiverTypeOrigins } from "./receiverTypes.js";
import { evaluatedValue, stringValueOf } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { SqlAccess } from "@suss/sql";
import type { Value } from "@suss/values";
import type { SubjectOrigin } from "./facts/resolve.js";
import type {
  RawSqlPattern,
  SqlCallArgument,
  SqlClientPattern,
} from "./pack.js";
import type { PyNode } from "./parser.js";

export interface RawSqlOptions {
  readonly facts: Database;
  readonly filePath: string;
  readonly patterns: readonly RawSqlPattern[];
  /** The client objects the packs declare, empty when no pack declares one. */
  readonly clients?: readonly SqlClientPattern[];
}

/** One call a pattern claimed, and what the database work it states comes to. */
interface RawSqlMatch {
  readonly call: PyNode;
  /** Which pack recognition to stamp on the binding. */
  readonly recognition: string;
  readonly storageSystem: string;
  readonly accesses: readonly SqlAccess[];
}

/** The statements a body hands the database, as storage effects. */
export function rawSqlEffects(
  calls: readonly PyNode[],
  options: RawSqlOptions,
): Effect[] {
  return matchesIn(calls, options).flatMap((match) =>
    match.accesses.flatMap((access) => effectFor(match, access)),
  );
}

/**
 * The calls raw-SQL recognition already read the meaning of, by node id.
 * The reach walk cannot step into a library call and asks here so as not
 * to report one it already understands as one it lost.
 */
export function rawSqlCallIds(
  calls: readonly PyNode[],
  options: RawSqlOptions,
): Set<number> {
  return new Set(matchesIn(calls, options).map((match) => match.call.id));
}

function matchesIn(
  calls: readonly PyNode[],
  options: RawSqlOptions,
): RawSqlMatch[] {
  if (options.patterns.length === 0 && (options.clients ?? []).length === 0) {
    return [];
  }
  const matched: RawSqlMatch[] = [];
  for (const call of calls) {
    const one =
      importedFunctionMatch(call, options) ?? clientMatch(call, options);
    if (one !== null) {
      matched.push(one);
    }
  }
  return matched;
}

/** One effect for a table the reader settled. */
function effectFor(match: RawSqlMatch, access: SqlAccess): Effect[] {
  const operation = field(match.call, "function")?.text ?? "";
  return [
    {
      type: "interaction",
      binding: storageBinding({
        recognition: match.recognition,
        storageSystem: match.storageSystem,
        scope: access.qualifier[access.qualifier.length - 1] ?? NO_GROUP,
        container: access.table,
      }),
      callee: operation,
      interaction: {
        class: "storage-access",
        kind: access.kind,
        fields: access.fields,
        ...(access.selector.length > 0 ? { selector: access.selector } : {}),
        operation,
      },
    },
  ];
}

/** The scope a table addressed by its name alone is in. */
const NO_GROUP = "default";

/**
 * The pattern a call matches because the file imported that name from the
 * module the pattern states. A local function of the same name is
 * somebody else's, so the import is what settles it.
 */
function importedFunctionMatch(
  call: PyNode,
  options: RawSqlOptions,
): RawSqlMatch | null {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "identifier") {
    return null;
  }
  const from = options.facts
    .facts("pyImportedName")
    .find((row) => String(row[0]) === `${options.filePath}#${callee.text}`);
  if (from === undefined) {
    return null;
  }
  const module = String(from[1]);
  const pattern = options.patterns.find(
    (candidate) =>
      candidate.module === module && candidate.functions.includes(callee.text),
  );
  if (pattern === undefined) {
    return null;
  }
  const args = field(call, "arguments");
  const first = args?.namedChildren.find((child) => child !== null) ?? null;
  const statement =
    first === null ? null : statementAt(first, undefined, options.facts);
  if (statement === null) {
    return null;
  }
  return {
    call,
    recognition: `python-${pattern.module}`,
    storageSystem: pattern.storageSystem,
    accesses: readSqlAccess(statement, { dialect: pattern.storageSystem }),
  };
}

/** A call on one of the library's own client objects, matched on the class the receiver is. */
function clientMatch(call: PyNode, options: RawSqlOptions): RawSqlMatch | null {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "attribute") {
    return null;
  }
  const method = field(callee, "attribute")?.text ?? "";
  const receiver = field(callee, "object");
  if (receiver === null) {
    return null;
  }
  for (const pattern of options.clients ?? []) {
    const accesses = accessesOf(call, method, pattern, options);
    if (accesses === null || !isClientOf(receiver, pattern, options)) {
      continue;
    }
    return {
      call,
      recognition: `python-${pattern.module}`,
      storageSystem: pattern.storageSystem,
      accesses,
    };
  }
  return null;
}

/**
 * What one call on a client says it touches, or null when the pattern
 * claims no method of that name. A claimed method whose argument the
 * evaluator could not settle touches nothing, which is a different
 * answer and comes back as an empty list.
 */
function accessesOf(
  call: PyNode,
  method: string,
  pattern: SqlClientPattern,
  options: RawSqlOptions,
): SqlAccess[] | null {
  const dialect = pattern.dialect ?? pattern.storageSystem;
  for (const takes of pattern.statements ?? []) {
    if (takes.method !== method) {
      continue;
    }
    const written = argumentNode(call, takes);
    const statement =
      written === null ? null : statementAt(written, takes.path, options.facts);
    return statement === null ? [] : readSqlAccess(statement, { dialect });
  }
  for (const takes of pattern.tables ?? []) {
    if (takes.method !== method) {
      continue;
    }
    const written = argumentNode(call, takes);
    const name =
      written === null ? null : stringValueOf(written, options.facts);
    // A table named on the call is split the way one named in a
    // statement is, so the two say the same dataset and table.
    const split = name === null ? null : splitQualifiedTable(name);
    return split === null
      ? []
      : [{ ...split, kind: takes.kind, fields: [], selector: [] }];
  }
  return null;
}

/** Whether the value a call is read off is one of the pattern's client classes. */
function isClientOf(
  receiver: PyNode,
  pattern: SqlClientPattern,
  options: RawSqlOptions,
): boolean {
  return receiverOrigins(receiver, options).some(
    (origin) =>
      origin.module === pattern.module &&
      pattern.clientTypes.includes(origin.name),
  );
}

/** Where the class of the value a call is read off came from. */
function receiverOrigins(
  receiver: PyNode,
  options: RawSqlOptions,
): readonly SubjectOrigin[] {
  if (receiver.type === "identifier") {
    return receiverTypeOrigins(receiver, options);
  }
  return receiver.type === "call" ? handedBack(receiver, options) : [];
}

/**
 * The class a declared handoff says a call gives back, which is how a
 * chain off one client reaches another client's own methods. Only the
 * library can say what one of its methods gives back, so a pack declares
 * it and nothing here infers it.
 */
function handedBack(call: PyNode, options: RawSqlOptions): SubjectOrigin[] {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "attribute") {
    return [];
  }
  const method = field(callee, "attribute")?.text ?? "";
  const inner = field(callee, "object");
  if (inner === null) {
    return [];
  }
  const found: SubjectOrigin[] = [];
  for (const pattern of options.clients ?? []) {
    const handoff = (pattern.handsBack ?? []).find(
      (one) => one.method === method,
    );
    if (handoff !== undefined && isClientOf(inner, pattern, options)) {
      found.push({ module: handoff.module, name: handoff.name });
    }
  }
  return found;
}

/** The node one call was given what it works on at, by keyword first and then by position. */
function argumentNode(call: PyNode, at: SqlCallArgument): PyNode | null {
  const args = field(call, "arguments");
  const written = args === null ? [] : children(args);
  const named = written.find(
    (one) =>
      one.type === "keyword_argument" &&
      at.keyword !== undefined &&
      field(one, "name")?.text === at.keyword,
  );
  const value = named === undefined ? null : field(named, "value");
  if (value !== null) {
    return value;
  }
  if (at.argument === undefined) {
    return null;
  }
  return (
    written.filter((one) => one.type !== "keyword_argument")[at.argument] ??
    null
  );
}

/** The SQL a call states, with everything the evaluator could not settle left as a parameter. */
function statementAt(
  node: PyNode,
  path: readonly string[] | undefined,
  facts: Database,
): string | null {
  const reached = valueAt(evaluatedValue(node, facts), path ?? []);
  const parts = reached === null ? null : literalParts(reached);
  if (parts === null) {
    return null;
  }
  const statement = sqlFromParts(parts);
  return statement.trim() === "" ? null : statement;
}

/** The value a path of keys reaches inside a dictionary, or null when nothing wrote one of them. */
function valueAt(value: Value, path: readonly string[]): Value | null {
  let reached = value;
  for (const key of path) {
    if (reached.kind !== "record") {
      return null;
    }
    const item = reached.fields.get(key);
    if (item === undefined) {
      return null;
    }
    reached = force(item.value);
  }
  return reached;
}

/**
 * The literal text either side of everything the value left unsettled, which
 * is the form the SQL reader takes a statement in. Null for a value that is
 * not a string at all, so a call handed a name nothing wrote stays unread
 * instead of becoming a statement of nothing but parameters.
 */
function literalParts(value: Value): string[] | null {
  if (value.kind !== "string") {
    return null;
  }
  const parts: string[] = [""];
  for (const piece of value.pieces) {
    const only = piece.kind === "text" ? piece.options : [];
    if (only.length === 1) {
      parts[parts.length - 1] += only[0] ?? "";
      continue;
    }
    parts.push("");
  }
  return parts;
}
