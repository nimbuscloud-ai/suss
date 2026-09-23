/**
 * Finds the calls in a Ruby body that send the store a statement the
 * project wrote itself.
 *
 * A pack says which constant its library's calls start at, which methods
 * on it return a client, which calls on that client take a statement,
 * and where each one takes it. A statement goes through the shared value
 * evaluator, so one kept in a constant another file defines reads the
 * same as one written at the call. `@suss/sql` then works out which
 * tables it touches.
 */

import { storageBinding } from "@suss/ir-core";
import { readSqlAccess, splitQualifiedTable, sqlFromParts } from "@suss/sql";
import { piecesOf } from "@suss/values";

import { field, readCallArgs } from "./ast.js";
import { classBehind, enclosingClassKey, reachesBase } from "./baseClass.js";
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
  /** The absolute path the calls were read from, which the constant bindings key on. */
  readonly file?: string;
}

/**
 * Where a pattern's statements go and how they are read. A model pattern
 * and a raw SQL pattern both declare these, so both use the same reader.
 */
export interface RbStatementStore {
  /** Which store is behind the calls, in the words OpenTelemetry's semantic conventions use. */
  readonly storageSystem: string;
  /** Which dialect the statements are written in. */
  readonly dialect: string;
  /** Which namespace the calls reach when neither the chain nor the table name says. */
  readonly scope?: string;
  /** The token the library writes where a bind value goes, when the dialect does not read that token itself. */
  readonly bindPlaceholder?: string;
}

/**
 * How far the reader follows a name back to what it was written as. A
 * client is assigned once and then read, so anything deeper than this
 * is a cycle in the facts and not a chain somebody wrote.
 */
const MOST_HOPS = 8;

/** The part of the store a chain of calls reached. */
export interface Address {
  readonly scope: string | null;
  readonly container: string | null;
}

/** What a call on the library's own constant has addressed, which is nothing yet. */
export const NOWHERE: Address = { scope: null, container: null };

/** The storage effects one call makes. Empty unless a pattern matches the call. */
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
    const statement = statementAt(
      args,
      place,
      options.facts,
      pattern.bindPlaceholder,
    );
    return statementEffects(call, statement, address, pattern);
  }

  return rowCallEffects(call, args, address, pattern, options);
}

/** One effect per table the statement touches. */
export function statementEffects(
  call: RbNode,
  statement: string | null,
  address: Address,
  store: RbStatementStore,
): Effect[] {
  if (statement === null) {
    return [];
  }

  return readSqlAccess(statement, { dialect: store.dialect }).map((access) =>
    effectOf(
      call,
      store,
      {
        scope: innermost(access.qualifier) ?? address.scope,
        container: access.table,
      },
      {
        kind: access.kind,
        fields: access.fields,
        selector: access.selector,
      },
    ),
  );
}

/** The namespace a table belongs to, which is the last of the ones written in front of it. */
function innermost(qualifier: readonly string[]): string | null {
  return qualifier[qualifier.length - 1] ?? null;
}

/**
 * A call that reads or writes the rows of a container the chain already
 * addressed, or that is given the container itself. A call whose
 * container did not settle reports nothing, since a guess would report a
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
      : namedTable(stringAt(args, rowCall.container, options.facts));
  const reached = {
    scope: given?.scope ?? address.scope,
    container: given?.container ?? address.container,
  };
  if (reached.container === null) {
    return [];
  }

  return [
    effectOf(call, pattern, reached, {
      kind: rowCall.kind,
      fields: [],
      selector: [],
    }),
  ];
}

/**
 * A table a call was given by name, split the same way as a table written
 * in a statement, so a call and a statement give the same namespace and
 * table. Null for a name that settled on nothing.
 */
function namedTable(name: string | null): Address | null {
  const split = name === null ? null : splitQualifiedTable(name);
  return split === null
    ? null
    : { scope: innermost(split.qualifier), container: split.table };
}

function effectOf(
  call: RbNode,
  store: RbStatementStore,
  address: Address,
  access: Pick<SqlAccess, "kind" | "fields" | "selector">,
): Effect {
  const operation = field(call, "method")?.text ?? "";
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: "ruby-raw-sql",
      storageSystem: store.storageSystem,
      scope: address.scope ?? store.scope ?? "default",
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
 * The part of the store a receiver has reached, or null when the receiver
 * did not come from the library. A receiver written as a name is followed
 * back to the expression behind it, so a connection kept in a local, an
 * instance variable or a method reads the same as one built at the call.
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
    if (written !== null && written.id !== receiver.id) {
      return addressBehind(written, pattern, options, hops + 1);
    }
    return receiver.type === "identifier" &&
      buildsOnOwnClass(receiver, receiver.text, pattern, options)
      ? NOWHERE
      : null;
  }

  const method = field(receiver, "method")?.text ?? "";
  const inner = field(receiver, "receiver");
  if (inner === null) {
    return buildsOnOwnClass(receiver, method, pattern, options)
      ? NOWHERE
      : null;
  }

  if (
    namesConstant(inner, pattern.constantName) ||
    namesSubclass(inner, pattern, options)
  ) {
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
  if (addressing.says === "scope") {
    return { scope: named ?? behind.scope, container: behind.container };
  }

  // A table given on the chain is split the same way as one in a
  // statement, so `dataset.table("core.accounts")` gives the dataset `core`.
  const table = namedTable(named);
  return {
    scope: table?.scope ?? behind.scope,
    container: table?.container ?? behind.container,
  };
}

/** Whether this receiver is the constant the pack declared, such as `PG` or `Google::Cloud::Bigquery`. */
function namesConstant(receiver: RbNode, constantName: string): boolean {
  if (receiver.type === "constant") {
    return receiver.text === constantName;
  }

  return (
    receiver.type === "scope_resolution" &&
    compoundName(receiver) === constantName
  );
}

/**
 * Whether this receiver is a constant whose class reaches one of the base
 * classes the pack listed. A library that gives every subclass a
 * connection is called through a subclass as often as through the base,
 * and both reach the same store.
 */
function namesSubclass(
  receiver: RbNode,
  pattern: RbRawSqlPattern,
  options: RbRawSqlOptions,
): boolean {
  const bases = pattern.baseClasses ?? [];
  const facts = options.facts;
  const file = options.file;
  if (
    bases.length === 0 ||
    facts === undefined ||
    file === undefined ||
    (receiver.type !== "constant" && receiver.type !== "scope_resolution")
  ) {
    return false;
  }

  const classKey = classBehind(facts, file, receiver);
  return classKey !== undefined && reachesBase(facts, classKey, bases);
}

/**
 * Whether a call written with no receiver builds a client on the class it
 * is written inside, like the bare `connection` in a model's own class
 * method. Ruby sends such a call to the enclosing class, so that class's
 * ancestry decides whether the method comes from the library.
 */
function buildsOnOwnClass(
  node: RbNode,
  method: string,
  pattern: RbRawSqlPattern,
  options: RbRawSqlOptions,
): boolean {
  const bases = pattern.baseClasses ?? [];
  const facts = options.facts;
  const file = options.file;
  if (
    bases.length === 0 ||
    facts === undefined ||
    file === undefined ||
    !pattern.clientBuilders.includes(method)
  ) {
    return false;
  }

  const classKey = enclosingClassKey(node, file);
  return classKey !== null && reachesBase(facts, classKey, bases);
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
 * The SQL a call sends, with everything the evaluator could not settle
 * written as a parameter. Null for an argument that is not a string at
 * all, so a call given a value from outside the run stays unread instead
 * of becoming a statement made only of parameters.
 */
export function statementAt(
  args: CallArgs,
  place: RbArgumentPlace,
  facts: Database | undefined,
  bindPlaceholder?: string,
): string | null {
  const written = argumentAt(args, place);
  if (written === undefined) {
    return null;
  }

  const parts = literalParts(statementValue(evaluatedValue(written, facts)));
  if (parts === null) {
    return null;
  }

  const statement = sqlFromParts(bindsSplit(parts, bindPlaceholder));
  return statement.trim() === "" ? null : statement;
}

/** A library with a bind placeholder of its own writes a statement no dialect parses, so each placeholder becomes a part boundary and reaches the reader as a parameter. */
function bindsSplit(
  parts: readonly string[],
  bindPlaceholder: string | undefined,
): string[] {
  if (bindPlaceholder === undefined || bindPlaceholder === "") {
    return [...parts];
  }

  return parts.flatMap((part) => part.split(bindPlaceholder));
}

/**
 * A library that takes the bind values alongside the statement takes both
 * as one list, `["SELECT ... WHERE id = ?", id]`, so the statement is the
 * first of them.
 */
function statementValue(value: Value): Value {
  if (value.kind !== "sequence") {
    return value;
  }

  const first = value.items[0];
  return first === undefined ? value : first.value;
}

/**
 * The literal text on either side of each part a value left unsettled,
 * the form the SQL reader expects. Null for a value that is not a string,
 * since a parameter in place of the whole statement says nothing about
 * any table.
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
