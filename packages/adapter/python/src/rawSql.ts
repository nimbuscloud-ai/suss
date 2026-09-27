/**
 * Which calls in a body pass the database a statement written as SQL.
 *
 * A pack declares how its library takes one. SQLAlchemy exports a
 * function, `text`, and a cloud warehouse gives the project a client
 * object whose methods take the statement. A call matching either becomes
 * the same storage-access effect a query through an ORM would produce,
 * one per table.
 *
 * The statement goes through the shared value evaluator, and any piece it
 * cannot settle becomes a parameter. DESIGN.md, under "A statement the
 * project wrote as SQL", describes how a table name becomes the boundary.
 */

import { storageBinding } from "@suss/ir-core";
import { readSqlAccess, splitQualifiedTable, sqlFromParts } from "@suss/sql";
import { force } from "@suss/values";

import { children, field, stringLiteralValue } from "./ast.js";
import { receiverTypeOrigins } from "./receiverTypes.js";
import { evaluatedValue, stringValueOf } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { SqlAccess, SqlPlaceholder } from "@suss/sql";
import type { Value } from "@suss/values";
import type { SubjectOrigin } from "./facts/resolve.js";
import type {
  RawSqlPattern,
  SqlCallArgument,
  SqlClientPattern,
} from "./pack.js";
import type { PyNode } from "./parser.js";
import type { SlottedEffects, SlotValue, StorageLookup } from "./storage.js";

export interface RawSqlOptions {
  readonly facts: Database;
  readonly filePath: string;
  readonly patterns: readonly RawSqlPattern[];
  /** The client objects the packs declare, empty when no pack declares one. */
  readonly clients?: readonly SqlClientPattern[];
}

/** What the raw-SQL reader is asked with, out of what discovery already looked up for the file. */
export function rawSqlOptionsOf(lookup: StorageLookup): RawSqlOptions {
  return {
    facts: lookup.facts,
    filePath: lookup.factsPath,
    patterns: lookup.rawSql ?? [],
    clients: lookup.sqlClients ?? [],
  };
}

/** One call a pattern matched, and the tables its statement reads or writes. */
interface RawSqlMatch {
  readonly call: PyNode;
  /** Which pack recognition to stamp on the binding. */
  readonly recognition: string;
  readonly storageSystem: string;
  readonly accesses: readonly SqlAccess[];
  /** The values bound to the statement's placeholders, or null for a client call, whose binds are not read. */
  readonly binds: Binds | null;
}

/** The statements a body hands the database, as storage effects, with the value each placeholder's column is given. */
export function rawSqlEffects(
  calls: readonly PyNode[],
  options: RawSqlOptions,
): SlottedEffects {
  const found: SlottedEffects = { effects: [], slots: [] };
  for (const match of matchesIn(calls, options)) {
    for (const access of match.accesses) {
      const effect = effectFor(match, access);
      found.effects.push(effect);
      for (const slot of boundSlots(access, match.binds)) {
        found.slots.push({ ...slot, effect });
      }
    }
  }
  return found;
}

/** The values a call binds to a statement's placeholders. */
interface Binds {
  /**
   * `$1`, or the first `?`, is the first of these. Empty when a piece of
   * the statement did not settle, since that piece is numbered too.
   */
  numbered: readonly PyNode[];
  /** `:tenant` is the value bound under `tenant`. */
  named: ReadonlyMap<string, PyNode>;
}

const SLOT_OF: Record<SqlPlaceholder["clause"], SlotValue["slot"]> = {
  fields: "field",
  selector: "selector",
};

/** Each column the statement gives a placeholder, with the value bound to it. */
function boundSlots(access: SqlAccess, binds: Binds | null): SlotValue[] {
  if (binds === null) {
    return [];
  }
  return (access.placeholders ?? []).flatMap((one) => {
    const value =
      typeof one.placeholder === "number"
        ? (binds.numbered[one.placeholder - 1] ?? null)
        : (binds.named.get(one.placeholder) ?? null);
    return value === null
      ? []
      : [{ slot: SLOT_OF[one.clause], name: one.field, value }];
  });
}

/**
 * Where a `text()` statement's values come from: `.bindparams(tenant=t)`
 * on the statement, or the argument after it in the call it is handed
 * to, `session.execute(stmt, {"tenant": t})` or a sequence for `?`.
 */
function bindsOf(statementCall: PyNode, wholeText: boolean): Binds {
  const bindparams = calledOn(statementCall, "bindparams");
  const handedTo = callTakingFirst(bindparams ?? statementCall);
  const given = handedTo === null ? null : secondArgument(handedTo);
  return {
    numbered:
      wholeText && (given?.type === "tuple" || given?.type === "list")
        ? children(given)
        : [],
    named: new Map([
      ...(given === null ? [] : dictionaryEntries(given)),
      ...(bindparams === null ? [] : keywordValues(bindparams)),
    ]),
  };
}

/** The call `node.method(...)` makes, when `node` is what the method is read off. */
function calledOn(node: PyNode, method: string): PyNode | null {
  const attribute = node.parent;
  const call = attribute?.parent ?? null;
  const read =
    attribute?.type === "attribute" &&
    field(attribute, "object")?.id === node.id &&
    field(attribute, "attribute")?.text === method;
  return read &&
    call?.type === "call" &&
    field(call, "function")?.id === attribute.id
    ? call
    : null;
}

/** The call `node` is the first positional argument of. */
function callTakingFirst(node: PyNode): PyNode | null {
  const list = node.parent;
  const first = list === null ? undefined : children(list)[0];
  return list?.type === "argument_list" && first?.id === node.id
    ? list.parent
    : null;
}

/** The second positional argument of a call, or what it passes as `params`. */
function secondArgument(call: PyNode): PyNode | null {
  const args = field(call, "arguments");
  const written = args === null ? [] : children(args);
  const positional = written.filter((one) => one.type !== "keyword_argument");
  return positional[1] ?? keywordValue(call, "params");
}

function keywordValue(call: PyNode, name: string): PyNode | null {
  return keywordValues(call).find(([keyword]) => keyword === name)?.[1] ?? null;
}

/** Each keyword a call passes, with the value it passes there. */
function keywordValues(call: PyNode): Array<[string, PyNode]> {
  const args = field(call, "arguments");
  return (args === null ? [] : children(args)).flatMap(
    (one): Array<[string, PyNode]> => {
      const name =
        one.type === "keyword_argument" ? field(one, "name")?.text : undefined;
      const value = field(one, "value");
      return name === undefined || value === null ? [] : [[name, value]];
    },
  );
}

/** Each value a dictionary written out in the source gives under a string key. */
function dictionaryEntries(dictionary: PyNode): Array<[string, PyNode]> {
  if (dictionary.type !== "dictionary") {
    return [];
  }
  return children(dictionary).flatMap((one): Array<[string, PyNode]> => {
    const written = one.type === "pair" ? field(one, "key") : null;
    const key = written === null ? null : stringLiteralValue(written);
    const value = field(one, "value");
    return key === null || value === null ? [] : [[key, value]];
  });
}

/**
 * The calls this module already recognized, by node id. The reach walk
 * cannot follow a library call, and checks here so it does not report a
 * recognized call as one it failed to follow.
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
function effectFor(match: RawSqlMatch, access: SqlAccess): Effect {
  const operation = field(match.call, "function")?.text ?? "";
  return {
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
  };
}

/** The scope a table addressed by its name alone is in. */
const NO_GROUP = "default";

/**
 * The pattern a call matches because the file imported the callee from
 * the pattern's module. Matching on the import keeps a local function of
 * the same name from counting.
 */
function importedFunctionMatch(
  call: PyNode,
  options: RawSqlOptions,
): RawSqlMatch | null {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "identifier") {
    return null;
  }
  const modules = new Set(
    options.facts
      .lookup("imports", 0, `${options.filePath}#${callee.text}`)
      .map((row) => String(row[1])),
  );
  const pattern = options.patterns.find(
    (candidate) =>
      modules.has(candidate.module) &&
      candidate.functions.includes(callee.text),
  );
  if (pattern === undefined) {
    return null;
  }
  const args = field(call, "arguments");
  const first = args?.namedChildren.find((child) => child !== null) ?? null;
  const statement =
    first === null ? null : writtenStatement(first, undefined, options.facts);
  if (statement === null) {
    return null;
  }
  return {
    call,
    recognition: `python-${pattern.module}`,
    storageSystem: pattern.storageSystem,
    accesses: readSqlAccess(statement.sql, {
      dialect: pattern.storageSystem,
      placeholders: true,
    }),
    binds: bindsOf(call, statement.whole),
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
      binds: null,
    };
  }
  return null;
}

/**
 * The tables one call on a client touches, or null when the pattern
 * declares no method of that name. A declared method whose argument the
 * evaluator cannot settle returns an empty list, so the call still counts
 * as recognized.
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
    // Split the same way as a table written in a statement, so both give
    // the same dataset and table.
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
 * The class a declared handoff says a call returns, so a chain off one
 * client can reach another client's methods. Nothing in the project says
 * what a library method returns, so the pack declares it and nothing here
 * infers it.
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

/** The argument node `at` points to, by keyword first and then by position. */
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
  return writtenStatement(node, path, facts)?.sql ?? null;
}

/**
 * The statement, and whether it was settled whole. Each piece nothing
 * settled is written as a numbered placeholder, the same way a bind is.
 */
function writtenStatement(
  node: PyNode,
  path: readonly string[] | undefined,
  facts: Database,
): { sql: string; whole: boolean } | null {
  const reached = valueAt(evaluatedValue(node, facts), path ?? []);
  const parts = reached === null ? null : literalParts(reached);
  if (parts === null) {
    return null;
  }
  const sql = sqlFromParts(parts);
  return sql.trim() === "" ? null : { sql, whole: parts.length === 1 };
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
 * The literal text on either side of each unsettled piece, which is the
 * form the SQL reader takes. Null for a value that is not a string, so a
 * call passed an unknown name stays unread instead of becoming a statement
 * made only of parameters.
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
