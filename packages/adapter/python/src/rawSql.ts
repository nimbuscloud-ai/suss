/**
 * Which calls in a body hand the database a statement written as SQL.
 *
 * A pack says which function its library gives a project for that, and
 * which module it comes from. SQLAlchemy's is `text`. A call to one of
 * those with a statement it can read becomes the same storage-access
 * effect a query through the ORM would have produced, one per table.
 *
 * A statement built at runtime from a variable is left alone. What an
 * f-string interpolates is a value nearly every time, so those read as
 * parameters, which is what they would have been anyway.
 */

import { storageBinding } from "@suss/ir-core";
import { readSqlAccess, sqlFromParts } from "@suss/sql";

import { field } from "./ast.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawSqlPattern } from "./pack.js";
import type { PyNode } from "./parser.js";

export interface RawSqlOptions {
  readonly facts: Database;
  readonly filePath: string;
  readonly patterns: readonly RawSqlPattern[];
}

/** The statements a body hands the database, as storage effects. */
export function rawSqlEffects(
  calls: readonly PyNode[],
  options: RawSqlOptions,
): Effect[] {
  if (options.patterns.length === 0) {
    return [];
  }
  const effects: Effect[] = [];
  for (const call of calls) {
    const pattern = patternFor(call, options);
    if (pattern === undefined) {
      continue;
    }
    const statement = statementIn(call);
    if (statement === null) {
      continue;
    }
    for (const access of readSqlAccess(statement, {
      dialect: pattern.storageSystem,
    })) {
      effects.push({
        type: "interaction",
        binding: storageBinding({
          recognition: `python-${pattern.module}`,
          storageSystem: pattern.storageSystem,
          scope: pattern.module,
          container: access.table,
        }),
        callee: field(call, "function")?.text ?? "",
        interaction: {
          class: "storage-access",
          kind: access.kind,
          fields: access.fields,
          ...(access.selector.length > 0 ? { selector: access.selector } : {}),
          operation: field(call, "function")?.text ?? "",
        },
      });
    }
  }
  return effects;
}

/**
 * The pattern a call matches, when the file imported that name from the
 * module the pattern states. A local function of the same name is
 * somebody else's, so the import is what settles it.
 */
function patternFor(
  call: PyNode,
  options: RawSqlOptions,
): RawSqlPattern | undefined {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "identifier") {
    return undefined;
  }
  const from = options.facts
    .facts("pyImportedName")
    .find((row) => String(row[0]) === `${options.filePath}#${callee.text}`);
  if (from === undefined) {
    return undefined;
  }
  const module = String(from[1]);
  return options.patterns.find(
    (pattern) =>
      pattern.module === module && pattern.functions.includes(callee.text),
  );
}

/** The SQL a call states, with what an f-string fills in as parameters. */
function statementIn(call: PyNode): string | null {
  const args = field(call, "arguments");
  const first = args?.namedChildren.find((child) => child !== null) ?? null;
  if (first === null || first.type !== "string") {
    return null;
  }
  const parts: string[] = [""];
  for (const child of first.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "string_content") {
      parts[parts.length - 1] += child.text;
      continue;
    }
    if (child.type === "interpolation") {
      parts.push("");
    }
  }
  const statement = sqlFromParts(parts);
  return statement.trim() === "" ? null : statement;
}
