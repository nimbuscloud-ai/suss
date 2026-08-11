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
  /** Method names a file importing the library declares, the only ones that can match. */
  readonly couldMatch: ReadonlySet<string>;
  /** Names of functions that reach the database, so a walk follows only those. */
  readonly leadsToStorage: ReadonlySet<string>;
}

/**
 * What discovery uses for one file. `factsPath` is the path the facts were
 * keyed under, which is the absolute one, while a summary shows the short one.
 */
/** Every call in a body, so a walk can follow the ones that lead somewhere. */
function callsIn(node: PyNode, found: PyNode[] = []): PyNode[] {
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "call") {
      found.push(child);
    }
    callsIn(child, found);
  }
  return found;
}

/**
 * The database work a body does, its own and whatever it reaches by calling
 * something. A handler that hands off to a service function did the work that
 * function does, so stopping at the handler's own body reports almost none of
 * it on a codebase written that way.
 */
export function storageEffects(
  calls: readonly PyNode[],
  options: StorageOptions,
): Effect[] {
  const seen = new Set<string>();
  // Built once. Rebuilding it inside the walk reads every question asked so
  // far at every step, which is most of the cost of walking at all.
  const asked = new Set(
    options.facts.facts("wanted").map((row) => String(row[0])),
  );
  const gather = (inCalls: readonly PyNode[], filePath: string): Effect[] => {
    const found = [...directStorageEffects(inCalls, { ...options, filePath })];
    resolveCalls(
      options.facts,
      inCalls
        .filter((call) => options.leadsToStorage.has(methodName(call)))
        .map((call) => field(call, "function"))
        .filter((callee): callee is PyNode => callee !== null)
        .map((callee) => calleeKeyOf(filePath, callee))
        .filter((key) => {
          const fresh = !asked.has(key);
          asked.add(key);
          return fresh;
        }),
    );
    for (const call of inCalls) {
      const callee = field(call, "function");
      if (callee === null || !options.leadsToStorage.has(methodName(call))) {
        continue;
      }
      const key = resolvedOnce(options, calleeKeyOf(filePath, callee));
      const body = key === undefined ? undefined : options.definitionAt(key);
      if (key === undefined || body === undefined || seen.has(key)) {
        continue;
      }
      seen.add(key);
      found.push(...gather(callsIn(body), fileOf(key)));
    }
    return found;
  };
  return gather(calls, options.filePath);
}

/**
 * The key the facts gave a callee. A bare name joins on the name, the way the
 * fact emitter keys one; anything else joins on its own node.
 */
function calleeKeyOf(filePath: string, callee: PyNode): string {
  return callee.type === "identifier"
    ? `${filePath}#${callee.text}`
    : nodeId(filePath, callee);
}

/** What a callee settled on, when the rules settled it on one thing. */
function resolvedOnce(
  options: StorageOptions,
  calleeKey: string,
): string | undefined {
  const resolved = options.facts
    .facts("wantedResolves")
    .filter((row) => String(row[0]) === calleeKey)
    .map((row) => String(row[1]));
  return resolved.length === 1 ? resolved[0] : undefined;
}

export interface StorageLookup {
  readonly facts: Database;
  readonly factsPath: string;
  readonly patterns: readonly StoragePattern[];
  readonly definitionAt: (key: string) => PyNode | undefined;
  readonly couldMatch: ReadonlySet<string>;
  readonly leadsToStorage: ReadonlySet<string>;
}

/**
 * Every callee a chain in this file starts at. Asking about all of them at
 * once costs one derivation for the project rather than one per route.
 */
export function storageCallees(
  calls: readonly PyNode[],
  filePath: string,
  couldMatch: ReadonlySet<string>,
): string[] {
  return chainsIn(calls)
    .filter((chain) => couldMatch.has(methodName(chain.root)))
    .map((chain) => field(chain.root, "function"))
    .filter((callee): callee is PyNode => callee !== null)
    .map((callee) => nodeId(filePath, callee));
}

/**
 * The database work a body does, one effect per chain. Empty when no pack
 * declares a storage pattern, or when nothing in the body settles on one.
 */
function directStorageEffects(
  calls: readonly PyNode[],
  options: StorageOptions,
): Effect[] {
  if (options.patterns.length === 0) {
    return [];
  }

  const chains = chainsIn(calls).filter((chain) =>
    options.couldMatch.has(methodName(chain.root)),
  );
  if (chains.length === 0) {
    return [];
  }
  // Anything already asked about was derived when the run asked, so asking
  // again would rerun the rules for an answer that is already there.
  const alreadyAsked = new Set(
    options.facts.facts("wanted").map((row) => String(row[0])),
  );
  resolveCalls(
    options.facts,
    storageCallees(calls, options.filePath, options.couldMatch).filter(
      (key) => !alreadyAsked.has(key),
    ),
  );

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
