/**
 * What this adapter hands the ops in `@suss/recognize/ops`, so a pack
 * declared with `@suss/recognize` runs over Ruby the way it runs over
 * TypeScript and Python. Ruby states every fact before discovery, so
 * nothing is read on demand.
 *
 * Three readings are Ruby's own. A call's callee is keyed on the method's
 * name, so its text is the receiver and the name as written. A class's own
 * method is stated under a spelling of its own, which the ops read back as
 * the plain name. And Ruby has no imports, so a value counts as coming
 * from a library when the constant it was made from starts with the
 * library's own constant, as `Aws::SQS::Client` starts with `Aws`.
 */

import { referenceName } from "@suss/behavioral-ir";
import { classMemberOf } from "@suss/resolution";

import { numberLiteralValue, stringLiteralValue } from "./ast.js";
import { CONSTRUCTOR } from "./facts/languageWords.js";
import { anchorCallsOf, writtenValueOf } from "./facts/resolve.js";
import { argOf } from "./paths/effects.js";
import { nodeOfResolutionKey, stringValueOf } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { EffectArg, FactSource } from "@suss/extractor";
import type { RbNode } from "./parser.js";

/** The fact source for one run's database. */
export function rubyFactSource(db: Database): FactSource {
  const nodeAt = (key: string | null): RbNode | null =>
    key === null ? null : nodeOfResolutionKey(key, db);
  // A name has no node, so its value is what it was written as.
  const valueNode = (key: string): RbNode | null =>
    nodeAt(key) ?? nodeAt(writtenValueOf(db, key));
  const textOf = (key: string): string => {
    const node = nodeAt(key);
    return node === null ? nameIn(key) : calleeText(node);
  };

  return {
    db,
    read: () => undefined,
    writtenAs: (key) => writtenValueOf(db, key),
    anchorCalls: (key) => anchorCallsOf(db, key),
    importedFrom: (key, module) => fromConstant(textOf(key), module),
    shapeOf: (key) => shapeOf(nodeAt(key)),
    memberName: (stated) => classMemberOf(stated) ?? stated,
    constructedClass: (callee) => constructedClass(nodeAt(callee)),
    textOf,
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
  };
}

/** A method's name with the receiver it is sent to, `cache.get`, which is how Ruby writes a callee. */
function calleeText(node: RbNode): string {
  const call = node.parent;
  if (call?.type !== "call" || call.childForFieldName("method") !== node) {
    return node.text;
  }
  const receiver = call.childForFieldName("receiver");
  return receiver === null ? node.text : `${receiver.text}.${node.text}`;
}

/** The class `Klass.new` makes, by its own name: `Connection` for `PG::Connection.new`. */
function constructedClass(method: RbNode | null): string | null {
  const call = method?.parent;
  if (
    method === null ||
    method === undefined ||
    method.text !== CONSTRUCTOR ||
    call?.type !== "call" ||
    call.childForFieldName("method") !== method
  ) {
    return null;
  }
  const receiver = call.childForFieldName("receiver");
  const named =
    receiver?.type === "scope_resolution"
      ? receiver.childForFieldName("name")
      : receiver;
  return named?.type === "constant" ? named.text : null;
}

/** Whether a constant path is the library's own constant or one inside it. */
function fromConstant(path: string, module: string): boolean {
  const constant = path.startsWith("::") ? path.slice(2) : path;
  return constant === module || constant.startsWith(`${module}::`);
}

const SHAPES: Record<string, "object" | "list"> = {
  hash: "object",
  array: "list",
  string_array: "list",
  symbol_array: "list",
};

function shapeOf(node: RbNode | null): "object" | "list" | null {
  return node === null ? null : (SHAPES[node.type] ?? null);
}

/** A string, number or boolean the source writes out at this node, read as written. */
function literalOf(node: RbNode | null): string | number | boolean | null {
  if (node === null) {
    return null;
  }
  if (node.type === "true" || node.type === "false") {
    return node.type === "true";
  }
  return stringLiteralValue(node) ?? numberLiteralValue(node);
}

/** The name at the end of a name key. */
function nameIn(key: string): string {
  return key.slice(key.lastIndexOf("#") + 1);
}
