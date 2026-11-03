/**
 * What this adapter hands the ops in `@suss/recognize/ops`, so a pack
 * declared with `@suss/recognize` runs over Python the way it runs over
 * TypeScript. Python states every fact before discovery, so nothing is
 * read on demand. A bare name is keyed by its scope and has no node of its
 * own, so a name is read through what it was written as.
 */

import { referenceName } from "@suss/behavioral-ir";
import { fileOfKey } from "@suss/resolution";

import { field, numberLiteralValue, stringLiteralValue } from "./ast.js";
import { anchorCallsOf, originsOf, writtenValueOf } from "./facts/resolve.js";
import { argOf } from "./paths/effects.js";
import { receiverTypeOrigins } from "./receiverTypes.js";
import { nodeOfResolutionKey, stringValueOf } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { EffectArg, FactSource } from "@suss/extractor";
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
      originsOf(db, key).some((origin) => fromModule(origin, module)),
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
    declares: (call, module) => {
      const receiver = receiverNamed(nodeAt(call));
      return (
        receiver !== null &&
        receiverTypeOrigins(receiver, {
          facts: db,
          filePath: fileOfKey(call),
        }).some((origin) => origin.module === module)
      );
    },
  };
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

/** Whether an import came from the module a pack asks for, or from inside it. */
function fromModule(
  origin: { module: string; name: string },
  module: string,
): boolean {
  return (
    origin.module === module ||
    origin.module.startsWith(`${module}.`) ||
    `${origin.module}.${origin.name}` === module
  );
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
