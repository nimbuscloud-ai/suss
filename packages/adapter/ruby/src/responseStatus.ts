/**
 * The wire status a controller action writes, read from the calls a pack
 * declares for writing one.
 *
 * A pack says which receiverless calls write a status and where each one
 * takes it, as a keyword or as a positional argument, and it supplies the
 * names the library accepts in place of a number. Nothing a library
 * defines is written here.
 *
 * An action that writes no status leaves the reading absent, and the
 * summary builder then applies the pack's declared default. An action
 * that writes two statuses down two branches is ambiguous and claims
 * neither. The package README says more.
 */

import {
  absentReading,
  ambiguousReading,
  unreadableReading,
  writtenReading,
} from "@suss/extractor";
import { constantOf, literalOf } from "@suss/values";

import { field, rangeOf, readCallArgs, runStatements } from "./ast.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { Reading } from "@suss/extractor";
import type { ControllerActions, RbStatusCall } from "./pack.js";
import type { RbNode } from "./parser.js";

/** The argument giving this call's status, or null when the call writes none. */
function statusArgumentOf(
  call: RbNode,
  declaration: RbStatusCall,
): RbNode | null {
  const args = readCallArgs(field(call, "arguments"));
  const keyword =
    declaration.statusKeyword === undefined
      ? undefined
      : args.keyword[declaration.statusKeyword];
  if (keyword !== undefined) {
    return keyword;
  }
  if (declaration.statusArgument === undefined) {
    return null;
  }
  return args.positional[declaration.statusArgument] ?? null;
}

/** The number a status argument comes down to, written either as a number or as one of the names the library accepts. */
function statusNumberOf(
  node: RbNode,
  names: Record<string, number>,
): number | null {
  const value = evaluatedValue(node);
  const constant = constantOf(value);
  if (typeof constant === "number") {
    return constant;
  }
  const name = literalOf(value);
  return name === null ? null : (names[name] ?? null);
}

function declarationsByName(
  declarations: readonly RbStatusCall[],
): Map<string, RbStatusCall> {
  return new Map(
    declarations.map((declaration) => [declaration.name, declaration]),
  );
}

/** The declaration matching a statement, when the statement is a call with no receiver, which is how an action writes one of these. */
function bareCallDeclaration(
  statement: RbNode,
  byName: ReadonlyMap<string, RbStatusCall>,
): RbStatusCall | undefined {
  if (statement.type !== "call" || field(statement, "receiver") !== null) {
    return undefined;
  }
  const name = field(statement, "method")?.text;
  return name === undefined ? undefined : byName.get(name);
}

export function responseStatusReading(
  method: RbNode,
  pattern: ControllerActions,
): Reading<number> {
  const declarations = pattern.responseStatusCalls ?? [];
  const body = field(method, "body");
  if (declarations.length === 0 || body === null) {
    return absentReading;
  }

  const byName = declarationsByName(declarations);
  const statusNames = pattern.statusCodeNames ?? {};
  const siteOf = new Map<number, RbNode>();
  let unstated = 0;
  let unreadable: RbNode | null = null;

  for (const statement of runStatements(body)) {
    const declaration = bareCallDeclaration(statement, byName);
    if (declaration === undefined) {
      continue;
    }
    const argument = statusArgumentOf(statement, declaration);
    if (argument === null) {
      unstated += 1;
      continue;
    }
    const status = statusNumberOf(argument, statusNames);
    if (status === null) {
      unreadable ??= argument;
      continue;
    }
    if (!siteOf.has(status)) {
      siteOf.set(status, argument);
    }
  }

  if (unreadable !== null) {
    return unreadableReading(
      "This action writes a response status that does not settle on a number here, so no status is claimed for it",
      rangeOf(unreadable),
    );
  }
  if (siteOf.size === 0) {
    return absentReading;
  }
  if (unstated > 0 && !siteOf.has(pattern.defaultStatusCode)) {
    siteOf.set(pattern.defaultStatusCode, method);
  }

  const candidates = [...siteOf.keys()];
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) {
    return writtenReading(only, rangeOf(siteOf.get(only) ?? method));
  }
  return ambiguousReading(
    candidates,
    "This action writes more than one response status depending on which branch runs, and nothing here reads which, so no status is claimed for it",
    rangeOf(method),
  );
}
