/**
 * rawSql.ts: which calls in a body hand the store a statement the
 * project wrote itself, for Ruby.
 *
 * A pack says which constant its library's calls start at, which
 * methods on it give back a client, which calls on that client take a
 * statement, and where each one takes it. A statement goes through the
 * shared value evaluator, so one held in a constant another module
 * wrote reads the same as one written out at the call, and `@suss/sql`
 * says which tables it touches.
 *
 * The README says how a chain that addresses a container without a
 * statement is read, and what a statement nobody can settle produces.
 */

import { storageBinding } from "@suss/ir-core";
import { readSqlAccess, sqlFromParts } from "@suss/sql";
import { piecesOf } from "@suss/values";

import { field, readCallArgs } from "./ast.js";
import { compoundName } from "./scope.js";
import { evaluatedValue, writtenNodeOf } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { SqlAccess } from "@suss/sql";
import type { Value } from "@suss/values";
import type { CallArgs } from "./ast.js";
import type { RbArgumentPlace, RbRawSqlPattern } from "./pack.js";
import type { RbNode } from "./parser.js";

export interface RbRawSqlOptions {
  readonly facts: Database | undefined;
  readonly patterns: readonly RbRawSqlPattern[];
}

/**
 * How far the reader follows a name back to what it was written as. A
 * client is assigned once and then read, so anything deeper than this
 * is a cycle in the facts rather than a chain somebody wrote.
 */
const MOST_HOPS = 8;

/** The part of the store a chain of calls reached. */
interface Address {
  readonly scope: string | null;
  readonly container: string | null;
}

/** What a call on the library's own constant has addressed, which is nothing yet. */
const NOWHERE: Address = { scope: null, container: null };

/** The storage effects one call makes, which is nothing unless a pattern matches it. */
export function rawSqlEffects(
  call: RbNode,
  options: RbRawSqlOptions,
): Effect[] {
  for (const pattern of options.patterns) {
    const effects = patternEffects(call, pattern, options);
    if (effects.length > 0) {
      return effects;
    }
  }
  return [];
}

function patternEffects(
  call: RbNode,
  pattern: RbRawSqlPattern,
  options: RbRawSqlOptions,
): Effect[] {
  const receiver = field(call, "receiver");
  if (receiver === null) {
    return [];
  }

  const address = addressBehind(receiver, pattern, options, 0);
  if (address === null) {
    return [];
  }

  const method = field(call, "method")?.text ?? "";
  const args = readCallArgs(field(call, "arguments"));
  const place = pattern.statements?.[method];
  if (place !== undefined) {
    const statement = statementAt(args, place, options.facts);
    return statementEffects(call, statement, address, pattern);
  }

  return rowCallEffects(call, args, address, pattern, options);
}

/** One effect per table the statement touches. */
function statementEffects(
  call: RbNode,
  statement: string | null,
  address: Address,
  pattern: RbRawSqlPattern,
): Effect[] {
  if (statement === null) {
    return [];
  }

  return readSqlAccess(statement, { dialect: pattern.dialect }).map((access) =>
    effectOf(call, pattern, addressOfTable(access.table, address, pattern), {
      kind: access.kind,
      fields: access.fields,
      selector: access.selector,
    }),
  );
}

/**
 * A call that reads or writes the rows of a container the chain already
 * addressed, or that is given the container itself. Nothing is reported
 * for a container nobody settled, since guessing one would report a
 * table the code never mentions.
 */
function rowCallEffects(
  call: RbNode,
  args: CallArgs,
  address: Address,
  pattern: RbRawSqlPattern,
  options: RbRawSqlOptions,
): Effect[] {
  const method = field(call, "method")?.text ?? "";
  const rowCall = pattern.rowCalls?.[method];
  if (rowCall === undefined) {
    return [];
  }

  const given =
    rowCall.container === undefined
      ? null
      : stringAt(args, rowCall.container, options.facts);
  const container = given ?? address.container;
  if (container === null) {
    return [];
  }

  const reached = { scope: address.scope, container };
  return [
    effectOf(call, pattern, reached, {
      kind: rowCall.kind,
      fields: [],
      selector: [],
    }),
  ];
}

/**
 * Which part of the store a table name in the statement refers to. A
 * library whose names carry their namespace spells the scope in the
 * name itself, and a name written without one belongs to whatever the
 * chain addressed.
 */
function addressOfTable(
  table: string,
  address: Address,
  pattern: RbRawSqlPattern,
): Address {
  const separator = pattern.qualifiedNameSeparator;
  if (separator === undefined) {
    return { scope: address.scope, container: table };
  }

  const parts = table.split(separator);
  const container = parts[parts.length - 1] ?? table;
  const spelled = parts.length > 1 ? (parts[parts.length - 2] ?? null) : null;
  return { scope: spelled ?? address.scope, container };
}

function effectOf(
  call: RbNode,
  pattern: RbRawSqlPattern,
  address: Address,
  access: Omit<SqlAccess, "table">,
): Effect {
  const operation = field(call, "method")?.text ?? "";
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: "ruby-raw-sql",
      storageSystem: pattern.storageSystem,
      scope: address.scope ?? pattern.scope ?? "default",
      container: address.container,
    }),
    callee: call.text,
    interaction: {
      class: "storage-access",
      kind: access.kind,
      fields: access.fields,
      operation,
      ...(access.selector.length > 0 ? { selector: access.selector } : {}),
    },
  };
}

/**
 * The part of the store a receiver has reached, or null when the
 * library did not give that receiver out. A receiver written as a name is
 * followed back to the expression behind it, so a connection kept in a
 * local, an instance variable or a method reads the same as one built
 * at the call.
 */
function addressBehind(
  receiver: RbNode,
  pattern: RbRawSqlPattern,
  options: RbRawSqlOptions,
  hops: number,
): Address | null {
  if (hops > MOST_HOPS) {
    return null;
  }

  if (receiver.type !== "call") {
    const written = writtenNodeOf(receiver, options.facts);
    return written === null || written.id === receiver.id
      ? null
      : addressBehind(written, pattern, options, hops + 1);
  }

  const method = field(receiver, "method")?.text ?? "";
  const inner = field(receiver, "receiver");
  if (inner !== null && namesConstant(inner, pattern.constantName)) {
    return pattern.clientBuilders.includes(method) ? NOWHERE : null;
  }

  const addressing = pattern.addressing?.[method];
  if (addressing === undefined || inner === null) {
    return null;
  }

  const behind = addressBehind(inner, pattern, options, hops + 1);
  if (behind === null) {
    return null;
  }

  const named = stringAt(
    readCallArgs(field(receiver, "arguments")),
    addressing,
    options.facts,
  );
  return addressing.says === "scope"
    ? { scope: named ?? behind.scope, container: behind.container }
    : { scope: behind.scope, container: named ?? behind.container };
}

/** Whether this receiver is the constant the pack said, `PG` or `Google::Cloud::Bigquery`. */
function namesConstant(receiver: RbNode, constantName: string): boolean {
  if (receiver.type === "constant") {
    return receiver.text === constantName;
  }

  return (
    receiver.type === "scope_resolution" &&
    compoundName(receiver) === constantName
  );
}

function argumentAt(
  args: CallArgs,
  place: RbArgumentPlace,
): RbNode | undefined {
  const keyword = place.keyword;
  return (
    (keyword === undefined ? undefined : args.keyword[keyword]) ??
    args.positional[place.at]
  );
}

/** The one string an argument settles on, or null when it settles on several or on none. */
function stringAt(
  args: CallArgs,
  place: RbArgumentPlace,
  facts: Database | undefined,
): string | null {
  const written = argumentAt(args, place);
  if (written === undefined) {
    return null;
  }

  const pieces = piecesOf(evaluatedValue(written, facts));
  const only = pieces.length === 1 ? pieces[0] : undefined;
  if (only === undefined || only.kind !== "text" || only.options.length !== 1) {
    return null;
  }

  return only.options[0] ?? null;
}

/**
 * The SQL a call states, with everything the evaluator could not settle
 * written as a parameter. Null for an argument that is not a string at
 * all, so a call handed a value nothing in the run wrote stays unread
 * rather than becoming a statement of nothing but parameters.
 */
function statementAt(
  args: CallArgs,
  place: RbArgumentPlace,
  facts: Database | undefined,
): string | null {
  const written = argumentAt(args, place);
  if (written === undefined) {
    return null;
  }

  const parts = literalParts(evaluatedValue(written, facts));
  if (parts === null) {
    return null;
  }

  const statement = sqlFromParts(parts);
  return statement.trim() === "" ? null : statement;
}

/**
 * The literal text either side of everything a value left unsettled,
 * which is the form the SQL reader takes a statement in. Null for a
 * value that is not a string, since a parameter standing in for the
 * whole statement says nothing about any table.
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
