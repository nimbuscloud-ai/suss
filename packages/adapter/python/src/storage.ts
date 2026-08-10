// storage.ts: which calls in a body talk to the database, and what each does.
// A pack says which query types its library defines, and a call matches when
// the method behind it says it returns one. The README says why.

import { storageRelationalBinding } from "@suss/ir-core";

import { field } from "./ast.js";
import { resolveCalls } from "./facts/resolve.js";
import { nodeId } from "./facts/values.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { StoragePattern } from "./pack.js";
import type { PyNode } from "./parser.js";

/** One call chain, from the call that starts it to the call that ends it. */
interface Chain {
  readonly root: PyNode;
  readonly last: PyNode;
  /** What the chain was called on, `AccessPoints` in `AccessPoints.query()`. */
  readonly subject: string;
  /** The method the last call says, which is what tells a read from a write. */
  readonly operation: string;
}

/** The call a method is read off, or null when the callee is not a method read. */
function receiverCall(call: PyNode): PyNode | null {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "attribute") {
    return null;
  }
  const object = field(callee, "object");
  return object !== null && object.type === "call" ? object : null;
}

function methodName(call: PyNode): string {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "attribute") {
    return callee?.text ?? "";
  }
  return field(callee, "attribute")?.text ?? "";
}

/** What a chain is called on, `AccessPoints` in `AccessPoints.query()`. */
function subjectOf(call: PyNode): string {
  const callee = field(call, "function");
  if (callee === null || callee.type !== "attribute") {
    return callee?.text ?? "";
  }
  return field(callee, "object")?.text ?? "";
}

/** The call a chain starts at, following receivers down. */
function rootOf(call: PyNode): PyNode {
  const receiver = receiverCall(call);
  return receiver === null ? call : rootOf(receiver);
}

/**
 * Every call chain in a body, one entry each. A chain is one thing the code
 * does, so `Model.query().filter_by(...).first()` counts once rather than
 * three times.
 */
function chainsIn(calls: readonly PyNode[]): Chain[] {
  const endsWith = new Map<number, PyNode>();
  for (const call of calls) {
    const receiver = receiverCall(call);
    if (receiver === null) {
      continue;
    }
    // The outermost call is the one that ends the chain, and it is the one
    // whose text runs furthest.
    const start = rootOf(receiver);
    const kept = endsWith.get(start.id);
    if (kept === undefined || call.endIndex > kept.endIndex) {
      endsWith.set(start.id, call);
    }
  }

  const chains: Chain[] = [];
  for (const call of calls) {
    // A call with a call before it is somewhere in the middle of a chain.
    if (receiverCall(call) !== null) {
      continue;
    }
    const last = endsWith.get(call.id) ?? call;
    chains.push({
      root: call,
      last,
      subject: subjectOf(call),
      operation: methodName(last),
    });
  }
  return chains;
}

/** The file part of a node key, which says where a definition was written. */
function fileOf(key: string): string {
  const at = key.lastIndexOf(":");
  return at === -1 ? key : key.slice(0, at);
}

/** What a function says it gives back, as the name written in the annotation. */
function returnTypeName(node: PyNode | undefined): string | null {
  if (node === undefined) {
    return null;
  }
  const annotation = field(node, "return_type");
  if (annotation === null) {
    return null;
  }
  // `List[Order]` says its element type too, and the outer name is enough.
  return annotation.type === "subscript"
    ? (field(annotation, "value")?.text ?? null)
    : annotation.text;
}

export interface StorageOptions {
  readonly facts: Database;
  readonly filePath: string;
  readonly patterns: readonly StoragePattern[];
  /** The function a resolved key was written as, for reading its annotation. */
  readonly definitionAt: (key: string) => PyNode | undefined;
}

/**
 * The database work a body does, one effect per chain. Empty when no pack
 * declares a storage pattern, or when nothing in the body settles on one.
 */
export function storageEffects(
  calls: readonly PyNode[],
  options: StorageOptions,
): Effect[] {
  if (options.patterns.length === 0) {
    return [];
  }

  const chains = chainsIn(calls);
  const calleeKeys = chains
    .map((chain) => field(chain.root, "function"))
    .filter((callee): callee is PyNode => callee !== null)
    .map((callee) => nodeId(options.filePath, callee));
  resolveCalls(options.facts, calleeKeys);

  const effects: Effect[] = [];
  for (const chain of chains) {
    const callee = field(chain.root, "function");
    if (callee === null) {
      continue;
    }
    const resolved = options.facts
      .facts("wantedResolves")
      .filter((row) => String(row[0]) === nodeId(options.filePath, callee))
      .map((row) => String(row[1]));
    const settled = resolved.length === 1 ? resolved[0] : undefined;
    if (settled === undefined) {
      continue;
    }

    const typeName = returnTypeName(options.definitionAt(settled));
    if (typeName === null) {
      continue;
    }
    const pattern = options.patterns.find(
      (candidate) =>
        candidate.queryTypes.includes(typeName) &&
        options.facts
          .facts("pyImport")
          .some(
            (row) =>
              String(row[0]) === fileOf(settled) &&
              String(row[1]) === candidate.module,
          ),
    );
    if (pattern === undefined) {
      continue;
    }

    effects.push({
      type: "interaction",
      binding: storageRelationalBinding({
        recognition: "python-storage",
        storageSystem: pattern.storageSystem,
        scope: pattern.module,
        table: chain.subject,
      }),
      callee: chain.last.text,
      interaction: {
        class: "storage-access",
        kind: pattern.writes.includes(chain.operation) ? "write" : "read",
        fields: [],
        operation: chain.operation,
      },
    });
  }
  return effects;
}
