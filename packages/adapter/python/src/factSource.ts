/**
 * What this adapter hands the ops in `@suss/recognize/ops`, so a pack
 * declared with `@suss/recognize` runs over Python the way it runs over
 * TypeScript. Python states every fact before discovery, so nothing is
 * read on demand. A bare name is keyed by its scope and has no node of its
 * own, so a name is read through what it was written as.
 */

import { referenceName } from "@suss/behavioral-ir";
import { answersFor, fileOfKey, givenBackFunction } from "@suss/resolution";
import { scalarOf } from "@suss/values";

import { field, numberLiteralValue, stringLiteralValue } from "./ast.js";
import {
  anchorCallsOf,
  originsOf,
  resolveCalls,
  writtenValueOf,
} from "./facts/resolve.js";
import { argOf } from "./paths/effects.js";
import { receiverTypeOrigins } from "./receiverTypes.js";
import {
  evaluatedValue,
  nodeOfResolutionKey,
  stringValueOf,
} from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { EffectArg, FactSource } from "@suss/extractor";
import type { SubjectOrigin } from "./facts/resolve.js";
import type { PyNode } from "./parser.js";

/** The fact source for one run's database. */
export function pythonFactSource(db: Database): FactSource {
  const nodeAt = (key: string | null): PyNode | null =>
    key === null ? null : nodeOfResolutionKey(key, db);
  // A name has no node, so its value is what it was written as.
  const valueNode = (key: string): PyNode | null =>
    nodeAt(key) ?? nodeAt(writtenValueOf(db, key));

  return {
    db,
    read: () => undefined,
    writtenAs: (key) => writtenValueOf(db, key),
    anchorCalls: (key) => anchorCallsOf(db, key),
    importedFrom: (key, module) =>
      originsOf(db, key).some(
        (origin) => importedNameIn(origin, module).length > 0,
      ),
    importedAs: (key, module) =>
      originsOf(db, key).flatMap((origin) => importedNameIn(origin, module)),
    shapeOf: (key) => shapeOf(nodeAt(key)),
    textOf: (key) => nodeAt(key)?.text ?? nameIn(key),
    literalOf: (key) => literalOf(nodeAt(key)),
    nameOf: (key, unsettled) => {
      const node = valueNode(key);
      const settled = node === null ? null : stringValueOf(node, db);
      if (settled !== null || unsettled !== "reference") {
        return settled;
      }
      return nodeAt(key) === null
        ? referenceName({ root: nameIn(key), fields: [] })
        : null;
    },
    argOf: (key): EffectArg => {
      const node = valueNode(key);
      return node === null
        ? { kind: "identifier", name: nameIn(key) }
        : argOf(node, db);
    },
    evaluatedOf: (key) => {
      const node = valueNode(key);
      return node === null ? null : scalarOf(evaluatedValue(node, db));
    },
    comesTo: (key) => {
      resolveCalls(db, [key]);
      return answersFor(db, "wantedComesTo", key);
    },
    givesBack: (key) => {
      resolveCalls(db, [key]);
      return givenBackFunction(db, key);
    },
    importSpecifierOf: (key) => moduleImportedAs(db, key),
    declares: (call, module) =>
      receiverClassesOf(call, db).some((origin) => origin.module === module),
    typedAs: (call, origin) =>
      receiverClassesOf(call, db).some(
        (found) =>
          origin.named.includes(found.name) &&
          origin.importedFrom.some((module) => inModule(found.module, module)),
      ),
  };
}

/** Where the class of the call's receiver came from, as its annotation or the call that built it says. */
function receiverClassesOf(
  call: string,
  db: Database,
): readonly SubjectOrigin[] {
  const receiver = receiverNamed(nodeOfResolutionKey(call, db));
  return receiver === null
    ? []
    : receiverTypeOrigins(receiver, { facts: db, filePath: fileOfKey(call) });
}

/**
 * The name a method call is made on, `client` in `client.query(...)`.
 * Python declares no method types, so the class behind that name, from
 * its annotation or the call that built it, is what declares the method.
 */
function receiverNamed(call: PyNode | null): PyNode | null {
  const callee = call === null ? null : field(call, "function");
  const receiver =
    callee?.type === "attribute" ? field(callee, "object") : null;
  return receiver?.type === "identifier" ? receiver : null;
}

/**
 * The name an import brought in from the module or a module inside it,
 * as the module exports it: `*` for `import ledger` or `from acme import
 * ledger` when the pack asks for `acme.ledger` itself.
 */
function importedNameIn(origin: SubjectOrigin, module: string): string[] {
  if (`${origin.module}.${origin.name}` === module) {
    return ["*"];
  }
  return inModule(origin.module, module) ? [origin.name] : [];
}

/**
 * The module a name was imported from, as the import statement spells
 * it, `.things` for `from .things import Thing`. A resolved import has a
 * second `imports` row under the file it resolved to, and no file imports
 * a module spelled as a path, so the row kept is the one whose module a
 * file states it imports.
 */
function moduleImportedAs(db: Database, key: string): string | null {
  const modules = new Set(
    db
      .lookup("imports", 0, key)
      .map((row) => String(row[1]))
      .filter((module) => db.lookup("importsModule", 1, module).length > 0),
  );
  const [one] = modules;
  return modules.size === 1 && one !== undefined ? one : null;
}

/** Whether a module is the one asked for or one inside it. */
function inModule(found: string, module: string): boolean {
  return found === module || found.startsWith(`${module}.`);
}

const SHAPES: Record<string, "object" | "list"> = {
  dictionary: "object",
  list: "list",
  tuple: "list",
  set: "list",
};

function shapeOf(node: PyNode | null): "object" | "list" | null {
  return node === null ? null : (SHAPES[node.type] ?? null);
}

/** A string, number or boolean the source writes out at this node, read as written. */
function literalOf(node: PyNode | null): string | number | boolean | null {
  if (node === null) {
    return null;
  }
  if (node.type === "true" || node.type === "false") {
    return node.type === "true";
  }
  return stringLiteralValue(node) ?? numberLiteralValue(node);
}

/** The name at the end of a name key, `config#table` to `table`. */
function nameIn(key: string): string {
  return key.slice(key.lastIndexOf("#") + 1);
}
