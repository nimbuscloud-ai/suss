/**
 * Which calls in a body pass the database a statement written as SQL.
 *
 * A pack declares the function its library takes one through, as
 * SQLAlchemy exports `text`. A call to it becomes the same storage-access
 * effect a query through an ORM would produce, one per table.
 *
 * The statement goes through the shared value evaluator, and any piece it
 * cannot settle becomes a parameter. DESIGN.md, under "A statement the
 * project wrote as SQL", describes how a table name becomes the boundary.
 */

import { storageBinding } from "@suss/ir-core";
import { readSqlAccess, sqlFromParts } from "@suss/sql";

import {
  calledName,
  children,
  field,
  rangeOf,
  stringLiteralValue,
} from "./ast.js";
import { calleeText } from "./paths/effects.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { SqlAccess, SqlPlaceholder } from "@suss/sql";
import type { Value } from "@suss/values";
import type { RawSqlPattern } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { SlottedEffects, SlotValue, StorageLookup } from "./storage.js";

export interface RawSqlOptions {
  readonly facts: Database;
  readonly filePath: string;
  readonly patterns: readonly RawSqlPattern[];
}

/** What the raw-SQL reader is asked with, out of what discovery already looked up for the file. */
export function rawSqlOptionsOf(lookup: StorageLookup): RawSqlOptions {
  return {
    facts: lookup.facts,
    filePath: lookup.factsPath,
    patterns: lookup.rawSql ?? [],
  };
}

/** One call a pattern matched, and the tables its statement reads or writes. */
interface RawSqlMatch {
  readonly call: PyNode;
  /** Which pack recognition to stamp on the binding. */
  readonly recognition: string;
  readonly storageSystem: string;
  readonly accesses: readonly SqlAccess[];
  /** The values bound to the statement's placeholders. */
  readonly binds: Binds;
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
      found.effects.push({ effect, at: match.call });
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
function boundSlots(access: SqlAccess, binds: Binds): SlotValue[] {
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
  if (options.patterns.length === 0) {
    return [];
  }
  const matched: RawSqlMatch[] = [];
  for (const call of calls) {
    const one = importedFunctionMatch(call, options);
    if (one !== null) {
      matched.push(one);
    }
  }
  return matched;
}

/** One effect for a table the reader settled. */
function effectFor(match: RawSqlMatch, access: SqlAccess): Effect {
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: match.recognition,
      storageSystem: match.storageSystem,
      scope: access.qualifier[access.qualifier.length - 1] ?? NO_GROUP,
      container: access.table,
    }),
    callee: calleeText(match.call),
    interaction: {
      class: "storage-access",
      kind: access.kind,
      fields: access.fields,
      operation: calledName(match.call),
      ...(access.selector.length > 0 ? { selector: access.selector } : {}),
    },
    location: rangeOf(match.call),
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
  const first = children(args)[0] ?? null;
  const statement =
    first === null ? null : writtenStatement(first, options.facts);
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

/**
 * The statement, and whether it was settled whole. Each piece nothing
 * settled is written as a numbered placeholder, the same way a bind is.
 */
function writtenStatement(
  node: PyNode,
  facts: Database,
): { sql: string; whole: boolean } | null {
  const parts = literalParts(evaluatedValue(node, facts));
  if (parts === null) {
    return null;
  }
  const sql = sqlFromParts(parts);
  return sql.trim() === "" ? null : { sql, whole: parts.length === 1 };
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
