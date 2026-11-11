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
import { copingAt, sitesNamingParameter } from "./envReads.js";
import { encoderCalled } from "./facts/languageWords.js";
import {
  anchorCallsOf,
  originsOf,
  resolveCalls,
  resolveStreamObjects,
  writtenValueOf,
} from "./facts/resolve.js";
import { argOf } from "./paths/effects.js";
import { shapeOfReturned } from "./paths/returnedShape.js";
import { receiverTypeOrigins } from "./receiverTypes.js";
import { scopeAt } from "./scope.js";
import { isBuiltin } from "./stdlibNames.js";
import {
  evaluatedValue,
  moduleOf,
  nodeOfResolutionKey,
  resolutionKeyOf,
  stringValueOf,
} from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { EffectArg, FactSource, ValueForm } from "@suss/extractor";
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
    formOf: (key) => formOf(nodeAt(key)),
    extendValue: (key, ops) => {
      const node = nodeAt(key);
      return node === null ? ops : Object.assign(ops, { ast: () => node });
    },
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
    encodedOf: (key) => encodedBy(db, key),
    typeShapeOf: (key) => {
      const node = nodeAt(key);
      return node === null
        ? { type: "ref", name: nameIn(key) }
        : shapeOfReturned(node);
    },
    spellsGlobal: (key, path) => importPathOf(db, key) === path,
    callsGlobal: (call, path) => {
      const node = nodeAt(call);
      const callee = node?.type === "call" ? field(node, "function") : null;
      return (
        callee !== null &&
        isBuiltin(callee, scopeAt(callee, moduleOf(callee)), path)
      );
    },
    globalsReaching: (key) => streamsReaching(db, key),
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
          (origin.named === undefined || origin.named.includes(found.name)) &&
          origin.importedFrom.some((module) => inModule(found.module, module)),
      ),
    defaultedAt: (key) => {
      const node = nodeAt(key);
      return node !== null && copingAt(node).defaulted;
    },
    fallbackOf: (key) => {
      const node = nodeAt(key);
      const fallback = node === null ? null : copingAt(node).fallback;
      return fallback === null ? null : resolutionKeyOf(fallback, db);
    },
    sitesNaming: (parameter) => sitesNamingParameter(db, parameter),
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
 * The name a method call is made on, `client` in `client.query(...)`, or
 * the one a member read is read off, `client` in `client.users`.
 * Python declares no method types, so the class behind that name, from
 * its annotation or the call that built it, is what declares the method.
 */
function receiverNamed(call: PyNode | null): PyNode | null {
  const callee =
    call === null || call.type === "attribute" ? call : field(call, "function");
  const receiver =
    callee?.type === "attribute" ? field(callee, "object") : null;
  return receiver?.type === "identifier" ? receiver : null;
}

/**
 * The dotted path a value is spelled as through the file's imports:
 * `sys.stdout` for `sys.stdout` after `import sys`, and for `stdout`
 * after `from sys import stdout`. Null for a value no import spells, such
 * as a parameter that happens to be called `sys`.
 */
function importPathOf(db: Database, key: string): string | null {
  const imported = new Set(
    db
      .lookup("imports", 0, key)
      .filter((row) => db.lookup("importsModule", 1, String(row[1])).length > 0)
      .map((row) =>
        row[2] === "*" ? String(row[1]) : `${String(row[1])}.${String(row[2])}`,
      ),
  );
  const [one] = imported;
  if (imported.size > 0) {
    return imported.size === 1 && one !== undefined ? one : null;
  }
  const [read, ...more] = db.lookup("readsProperty", 0, key);
  if (read === undefined || more.length > 0) {
    return null;
  }
  const object = importPathOf(db, String(read[1]));
  return object === null ? null : `${object}.${String(read[2])}`;
}

/** The output streams the rules followed into a value, each as the path that spells it. */
function streamsReaching(db: Database, key: string): string[] {
  resolveStreamObjects(
    db,
    db.facts("streamObject").map((row) => String(row[0])),
  );
  return db.lookup("wantedStreamValue", 0, key).flatMap((row) => {
    const path = importPathOf(db, String(row[1]));
    return path === null ? [] : [path];
  });
}

/**
 * The argument a call of one of the standard library's encoders encodes,
 * read off the call's facts: `json.dumps(report)` is `report` under
 * `json` when `json` is the module the file imported.
 */
function encodedBy(
  db: Database,
  call: string,
): { codec: string; value: string } | null {
  for (const [, callee] of db.lookup("call", 0, call)) {
    for (const [, object, name] of db.lookup(
      "readsProperty",
      0,
      String(callee),
    )) {
      const encoder = encoderCalled(String(name), (module) =>
        originsOf(db, String(object)).some((origin) =>
          importedNameIn(origin, module).includes("*"),
        ),
      );
      if (encoder === null) {
        continue;
      }
      const value = db
        .lookup("callArg", 0, call)
        .find((row) => String(row[1]) === String(encoder.argument));
      return value === undefined
        ? null
        : { codec: encoder.codec, value: String(value[2]) };
    }
  }
  return null;
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

const FORMS: Record<string, ValueForm> = {
  lambda: "function",
  dictionary: "object",
};

/** A key with no node of its own is a name, since only a name is keyed by its scope. */
function formOf(node: PyNode | null): ValueForm {
  return node === null ? "name" : (FORMS[node.type] ?? "other");
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
