/**
 * callbacks.ts: the methods a class body registers for its library to
 * run when a write happens.
 *
 * `after_commit :sync_search, on: :create` registers a method of the
 * class, and a body that creates a row through the model runs it
 * without ever writing its name. The declaration is stated as a fact,
 * and the shared rules join it to the ancestry, so a callback
 * registered on a base reaches every model below it.
 *
 * Which call registers a callback, and which events it covers, is the
 * library's own vocabulary and arrives from the pack.
 */

import { field, readCallArgs, runStatements } from "../ast.js";
import { symbolArgumentNames } from "../filters.js";
import { stringValueOf } from "../values/evaluator.js";
import { nodeId } from "./values.js";

import type { Database } from "@suss/datalog";
import type { RbModelCallbacks, RbStoragePattern } from "../pack.js";
import type { RbNode } from "../parser.js";

/** Everything a run's storage patterns say about callbacks, pooled. */
export function callbacksIn(
  patterns: readonly RbStoragePattern[],
): RbModelCallbacks[] {
  return patterns.flatMap((pattern) =>
    pattern.callbacks === undefined ? [] : [pattern.callbacks],
  );
}

/**
 * One `classCallback(class, event, method)` per event a declaration in
 * this class body covers. A declaration giving several methods states
 * one per method, the way the library registers them.
 */
export function emitClassCallbacks(
  db: Database,
  file: string,
  classNode: RbNode,
  declared: readonly RbModelCallbacks[],
): void {
  const body = field(classNode, "body");
  if (body === null || declared.length === 0) {
    return;
  }

  const classKey = nodeId(file, classNode);
  for (const statement of runStatements(body)) {
    if (statement.type !== "call" || field(statement, "receiver") !== null) {
      continue;
    }
    const called = field(statement, "method")?.text ?? "";
    const args = readCallArgs(field(statement, "arguments"));
    for (const callbacks of declared) {
      const events = eventsOf(args, called, callbacks, db);
      for (const event of events) {
        for (const method of symbolArgumentNames(args, db)) {
          db.add("classCallback", [classKey, event, method]);
        }
      }
    }
  }
}

/**
 * The events one declaration covers: what the registering call runs on,
 * narrowed by the keyword the library gives for that. Empty when this
 * call registers nothing.
 */
function eventsOf(
  args: ReturnType<typeof readCallArgs>,
  called: string,
  callbacks: RbModelCallbacks,
  db: Database,
): string[] {
  const covered = callbacks.registeredBy[called];
  if (covered === undefined) {
    return [];
  }

  const written = args.keyword[callbacks.eventKeyword];
  const narrowed = written === undefined ? null : stringValueOf(written, db);
  if (narrowed === null) {
    return covered;
  }
  return covered.filter((event) => event === narrowed);
}
