// storage.ts: which calls in a body talk to the database, and what each does.
// A pack says which query types its library defines, and a call matches when
// the method behind it says it returns one. The README says why.

import { storageBinding } from "@suss/ir-core";

import {
  bodyStatements,
  children,
  enclosingFunction,
  field,
  parameterNameAndType,
  stringLiteralValue,
} from "./ast.js";
import { resolveCalls } from "./facts/resolve.js";
import { readKey } from "./facts/values.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawSqlPattern, StoragePattern } from "./pack.js";
import type { PyNode } from "./parser.js";

/** One call chain, from the call that starts it to the call that ends it. */
interface Chain {
  readonly root: PyNode;
  readonly last: PyNode;
  /** What the chain was called on, `AccessPoints` in `AccessPoints.query()`. */
  readonly subject: string;
  /** The method the last call says, which is what tells a read from a write. */
  readonly operation: string;
  /** The calls between the first and the last, where `filter_by(id=x)` picks rows. */
  readonly between: readonly PyNode[];
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
      between: calls.filter(
        (other) =>
          other !== call &&
          other !== last &&
          other.startIndex >= call.startIndex &&
          other.endIndex <= last.endIndex,
      ),
    });
  }
  return chains;
}

/**
 * The pattern a chain matches because it starts at a function the library
 * exports and the file imported, rather than at a method on a project class.
 * SQLAlchemy 2.0 writes `select(...)` that way, and no project method comes
 * between the call site and the library for its return to be read.
 */
function importedQueryFunction(
  options: StorageOptions,
  chain: Chain,
): StoragePattern | undefined {
  const callee = field(chain.root, "function");
  if (callee === null || callee.type !== "identifier") {
    return undefined;
  }
  const from = options.facts
    .facts("pyImportedName")
    .find((row) => String(row[0]) === `${options.filePath}#${callee.text}`);
  if (from === undefined) {
    return undefined;
  }
  return options.patterns.find(
    (pattern) =>
      String(from[1]) === pattern.module &&
      (pattern.queryFunctions ?? []).includes(String(from[2])),
  );
}

/** The name a chain's first call is read off, `db` in `db.add(order)`, or null when it starts anywhere else. */
function receiverName(chain: Chain): string | null {
  const callee = field(chain.root, "function");
  if (callee === null || callee.type !== "attribute") {
    return null;
  }
  const object = field(callee, "object");
  return object !== null && object.type === "identifier" ? object.text : null;
}

/** The class an annotation refers to, read through the quotes of a forward reference and the first argument of an `Annotated` or `Optional`. */
function typeNameOf(annotation: PyNode): string | null {
  // The grammar wraps every annotation in a `type` node.
  if (annotation.type === "type" && annotation.namedChildren[0]) {
    return typeNameOf(annotation.namedChildren[0]);
  }
  if (annotation.type === "identifier") {
    return annotation.text;
  }
  const quoted = stringLiteralValue(annotation);
  if (quoted !== null) {
    return quoted;
  }
  if (annotation.type === "subscript") {
    const outer = field(annotation, "value")?.text;
    const first = annotation.childrenForFieldName("subscript")[0];
    if ((outer === "Annotated" || outer === "Optional") && first) {
      return typeNameOf(first);
    }
  }
  return null;
}

/** The class a statement gives a name: an annotation on the assignment, the callee it constructs with, or the call a `with ... as name` opens. */
function typeGivenBy(statement: PyNode, name: string): string | null {
  if (statement.type === "assignment") {
    if (field(statement, "left")?.text !== name) {
      return null;
    }
    const annotation = field(statement, "type");
    if (annotation !== null) {
      return typeNameOf(annotation);
    }
    const right = field(statement, "right");
    const callee = right?.type === "call" ? field(right, "function") : null;
    return callee?.type === "identifier" ? callee.text : null;
  }
  if (statement.type === "as_pattern") {
    const alias = field(statement, "alias");
    // The grammar gives the alias a field and leaves the value bare.
    const value = statement.namedChildren[0] ?? null;
    const callee = value?.type === "call" ? field(value, "function") : null;
    return alias?.text === name && callee?.type === "identifier"
      ? callee.text
      : null;
  }
  return null;
}

/**
 * The class the enclosing function says a name is: the annotation on a
 * parameter of that name, or what the body binds it to. Null at module
 * level or when the function never says.
 */
function declaredTypeName(name: string, from: PyNode): string | null {
  const fn = enclosingFunction(from);
  if (fn === null) {
    return null;
  }
  const params = field(fn, "parameters");
  for (const param of params === null ? [] : children(params)) {
    const info = parameterNameAndType(param);
    if (info?.name === name && info.typeNode !== null) {
      return typeNameOf(info.typeNode);
    }
  }
  const visit = (node: PyNode): string | null => {
    const given = typeGivenBy(node, name);
    if (given !== null) {
      return given;
    }
    for (const child of children(node)) {
      if (child.type === "function_definition" || child.type === "lambda") {
        continue;
      }
      const found = visit(child);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };
  const body = field(fn, "body");
  for (const statement of body === null ? [] : bodyStatements(body)) {
    const found = visit(statement);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * The pattern a chain matches because the name it starts on is declared,
 * where the chain is written, as one of the library's own query types:
 * `db: Session` on the handler, or `session = Session()` in its body.
 * The name has to have come from the pattern's module for the class to be
 * the library's rather than a project's of the same name.
 */
function typedReceiverPattern(
  options: StorageOptions,
  chain: Chain,
): StoragePattern | undefined {
  const receiver = receiverName(chain);
  if (receiver === null) {
    return undefined;
  }
  const typeName = declaredTypeName(receiver, chain.root);
  if (typeName === null) {
    return undefined;
  }
  const from = options.facts
    .facts("pyImportedName")
    .find((row) => String(row[0]) === `${options.filePath}#${typeName}`);
  if (from === undefined) {
    return undefined;
  }
  return options.patterns.find(
    (pattern) =>
      String(from[1]) === pattern.module &&
      pattern.queryTypes.includes(String(from[2])),
  );
}

/** The columns a chain says it wants, as written. */
function fieldsOf(chain: Chain, valueMethods: readonly string[]): string[] {
  const args = field(chain.root, "arguments");
  const named: string[] = [];
  for (const argument of args === null ? [] : children(args)) {
    if (argument.type === "keyword_argument") {
      const name = field(argument, "name");
      if (name !== null) {
        named.push(name.text);
      }
      continue;
    }
    // `User.id` in `select(User.id)` says the column, and a bare name does not.
    if (argument.type === "attribute") {
      const property = field(argument, "attribute");
      if (property !== null) {
        named.push(property.text);
      }
    }
  }
  for (const call of laterCalls(chain)) {
    if (valueMethods.includes(methodNameOf(call))) {
      named.push(...keywordNames(call));
    }
  }
  return [...new Set(named)];
}

/** The calls after the root, in source order. */
function laterCalls(chain: Chain): PyNode[] {
  return [...chain.between, chain.last].filter((call) => call !== chain.root);
}

function methodNameOf(call: PyNode): string {
  const callee = field(call, "function");
  return callee?.type === "attribute"
    ? (field(callee, "attribute")?.text ?? "")
    : (callee?.text ?? "");
}

function keywordNames(call: PyNode): string[] {
  const args = field(call, "arguments");
  const picked: string[] = [];
  for (const argument of args === null ? [] : children(args)) {
    if (argument.type === "keyword_argument") {
      const name = field(argument, "name");
      if (name !== null) {
        picked.push(name.text);
      }
    }
  }
  return picked;
}

/** What the calls after the root were given to pick rows by. A call that supplies values is not one of them. */
function selectorOf(chain: Chain, valueMethods: readonly string[]): string[] {
  return [
    ...new Set(
      laterCalls(chain)
        .filter((call) => !valueMethods.includes(methodNameOf(call)))
        .flatMap(keywordNames),
    ),
  ];
}

/**
 * One effect for a chain. `operation` is the call that says what the chain
 * does to the database: the last one for a query built up by methods, and
 * the first one for a statement function, since `update(...).values(...)`
 * is an update whatever it ends with.
 */
function effectFor(
  pattern: StoragePattern,
  chain: Chain,
  operation: string,
): Effect {
  const valueMethods = pattern.valueMethods ?? [];
  const picked = selectorOf(chain, valueMethods);
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: "python-storage",
      storageSystem: pattern.storageSystem,
      scope: pattern.module,
      container: chain.subject,
    }),
    callee: chain.last.text,
    interaction: {
      class: "storage-access",
      kind: pattern.writes.includes(operation) ? "write" : "read",
      fields: fieldsOf(chain, valueMethods),
      operation,
      ...(picked.length > 0 ? { selector: picked } : {}),
    },
  };
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
}

/**
 * What discovery uses for one file. `factsPath` is the path the facts were
 * keyed under, which is the absolute one, while a summary shows the short one.
 */
export interface StorageLookup {
  readonly facts: Database;
  readonly factsPath: string;
  readonly patterns: readonly StoragePattern[];
  readonly definitionAt: (key: string) => PyNode | undefined;
  readonly couldMatch: ReadonlySet<string>;
  /** What a pack says about statements a project writes as SQL itself. */
  readonly rawSql?: readonly RawSqlPattern[];
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
    .map((callee) => readKey(filePath, callee, enclosingFunction(callee)));
}

/** The pattern a chain matches by resolving its first call to a project method whose annotation says it returns a query type. */
function resolvedMethodPattern(
  options: StorageOptions,
  callee: PyNode,
): StoragePattern | undefined {
  const resolved = options.facts
    .facts("wantedResolves")
    .filter(
      (row) =>
        String(row[0]) ===
        readKey(options.filePath, callee, enclosingFunction(callee)),
    )
    .map((row) => String(row[1]));
  const settled = resolved.length === 1 ? resolved[0] : undefined;
  if (settled === undefined) {
    return undefined;
  }
  const typeName = returnTypeName(options.definitionAt(settled));
  if (typeName === null) {
    return undefined;
  }
  return options.patterns.find(
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
}

/** A chain the patterns claim, with the call in it that says what it does. `operation` is null for a call that touches no rows of its own. */
interface MatchedChain {
  readonly chain: Chain;
  readonly pattern: StoragePattern;
  readonly operation: string | null;
}

/**
 * Every chain in a body some pattern claims. A chain starts at a function
 * the library exports and the file imported, at a name the enclosing
 * function declares as one of the library's query types, or at a project
 * method whose annotation says it returns one; nothing else can start a
 * query. Empty when no pack declares a storage pattern.
 */
function matchedChains(
  calls: readonly PyNode[],
  options: StorageOptions,
): MatchedChain[] {
  if (options.patterns.length === 0) {
    return [];
  }

  const named = new Set(
    options.patterns.flatMap((pattern) => pattern.queryFunctions ?? []),
  );
  const chains = chainsIn(calls).filter(
    (chain) =>
      options.couldMatch.has(methodName(chain.root)) ||
      named.has(methodName(chain.root)) ||
      typedReceiverPattern(options, chain) !== undefined,
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

  const matched: MatchedChain[] = [];
  for (const chain of chains) {
    const callee = field(chain.root, "function");
    if (callee === null) {
      continue;
    }
    const imported = importedQueryFunction(options, chain);
    if (imported !== undefined) {
      matched.push({
        chain,
        pattern: imported,
        operation: methodName(chain.root),
      });
      continue;
    }
    const typed = typedReceiverPattern(options, chain);
    if (typed !== undefined) {
      // `db.execute(stmt).all()` is silent for what it calls on `db`,
      // whatever it does with the result.
      const silent = (typed.recordsNothing ?? []).includes(
        methodName(chain.root),
      );
      matched.push({
        chain,
        pattern: typed,
        operation: silent ? null : chain.operation,
      });
      continue;
    }
    const pattern = resolvedMethodPattern(options, callee);
    if (pattern !== undefined) {
      matched.push({ chain, pattern, operation: chain.operation });
    }
  }
  return matched;
}

/**
 * The calls a body makes that start a chain the patterns claim, by node id.
 * The reach walk cannot step into any of them, since the library is outside
 * the run, and it asks here so as not to report a call it already knows
 * the meaning of as one it lost.
 */
export function storageCallIds(
  calls: readonly PyNode[],
  options: StorageOptions,
): Set<number> {
  return new Set(
    matchedChains(calls, options).map(({ chain }) => chain.root.id),
  );
}

/**
 * The database work a body does itself, one effect per chain. Work inside a
 * function the body calls goes on that function's own summary, and the call
 * links to it, so nothing here follows a call. Empty when no pack declares a
 * storage pattern, or when nothing in the body settles on one.
 */
export function storageEffects(
  calls: readonly PyNode[],
  options: StorageOptions,
): Effect[] {
  return matchedChains(calls, options).flatMap(
    ({ chain, pattern, operation }) =>
      operation === null ? [] : [effectFor(pattern, chain, operation)],
  );
}
