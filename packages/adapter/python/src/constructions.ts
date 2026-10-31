/**
 * The calls that make one of the project's classes, and what each passes
 * into a field its constructor stores.
 *
 * A repository class every model gets one of stores its model in
 * `__init__`, as `self.model = sql_model`, and a method reads it back.
 * The model a construction gives is the argument it passes at that
 * parameter. A subclass whose own `__init__` hands the parameter on with
 * `super().__init__(...)` is followed through that call. This reads the
 * constructors themselves and asks the rules only what each argument and
 * each base class name comes to, in one batched question. Asking the rules
 * for the field under each construction cost tens of millions of rows per
 * construction on a FastAPI app with forty repositories.
 */

import { answersFor } from "@suss/resolution";

import {
  children,
  classBases,
  enclosingFunction,
  field,
  parameterIdentifier,
} from "./ast.js";
import { resolveCalls } from "./facts/resolve.js";
import { nodeAt, readKey } from "./facts/values.js";

import type { Database } from "@suss/datalog";
import type { PyNode } from "./parser.js";
import type { BoundPythonFile } from "./routers.js";

type Files = ReadonlyMap<string, BoundPythonFile>;

/**
 * A construction the way a summary records it, `file:line:column`. The
 * file is absolute here, and the CLI rewrites it relative to the project
 * the way it rewrites the unit's own. Null for a construction in a file
 * the run did not read.
 */
export function constructionRef(siteKey: string, files: Files): string | null {
  const node = nodeOfKey(siteKey, files);
  if (node === null) {
    return null;
  }
  const { row, column } = node.startPosition;
  return `${fileOfKey(siteKey)}:${row + 1}:${column + 1}`;
}

/** The project class each of these calls makes, by the call's key, for the calls that make one. */
export function constructedClasses(
  calls: readonly string[],
  facts: Database,
  files: Files,
): Map<string, PyNode> {
  const callees = new Map(
    calls.flatMap((call) => {
      const [row] = facts.lookup("call", 0, call);
      return row === undefined ? [] : [[call, String(row[1])] as const];
    }),
  );
  const classes = classesNamed([...callees.values()], facts, files);
  const made = new Map<string, PyNode>();
  for (const [call, callee] of callees) {
    const cls = classes.get(callee);
    if (cls !== undefined) {
      made.set(call, cls);
    }
  }
  return made;
}

/**
 * The one project class each of these value keys comes to, for the keys
 * that come to exactly one, asked about together.
 */
export function classesNamed(
  keys: readonly string[],
  facts: Database,
  files: Files,
): Map<string, PyNode> {
  const asked = [...new Set(keys)];
  if (asked.length === 0) {
    return new Map();
  }
  resolveCalls(facts, asked);
  const found = new Map<string, PyNode>();
  for (const key of asked) {
    const classes = answersFor(facts, "wantedComesTo", key).flatMap(
      (answer) => {
        const node = nodeOfKey(answer, files);
        return node?.type === "class_definition" ? [node] : [];
      },
    );
    const [only] = classes;
    if (classes.length === 1 && only !== undefined) {
      found.set(key, only);
    }
  }
  return found;
}

/** The class's name, as written. */
export function classNameOf(cls: PyNode): string | null {
  return field(cls, "name")?.text ?? null;
}

/**
 * The value each construction puts in the field `name` its class's
 * constructor stores from one of its parameters, as the key to ask what
 * it comes to, by the construction's key. A construction whose
 * constructor stores the field some other way, or that leaves the
 * argument out, is left out.
 */
export function fieldArguments(
  name: string,
  sites: readonly string[],
  facts: Database,
  files: Files,
): Map<string, string> {
  const made = constructedClasses(sites, facts, files);
  const found = new Map<string, string>();
  for (const [site, cls] of made) {
    const call = nodeOfKey(site, files);
    const source = fieldSource(cls, name, facts, files, new Set());
    const argument =
      call === null || source === null ? null : valueGiven(call, source);
    const file = argument === null ? null : fileContaining(argument, files);
    if (argument !== null && file !== null) {
      found.set(site, readKey(file, argument, enclosingFunction(argument)));
    }
  }
  return found;
}

/** A constructor parameter by its position among the ones a caller fills, and its name. */
interface Parameter {
  index: number;
  name: string;
}

/** The value a construction puts in a field, from the argument it passes or from a subclass's own. */
function valueGiven(
  call: PyNode,
  source: Parameter | { fixed: PyNode },
): PyNode | null {
  if ("fixed" in source) {
    return source.fixed;
  }
  return argumentFor(call, source);
}

/**
 * Where the field `name` gets its value when `cls` is constructed: the
 * constructor parameter its body, or a base constructor it hands the
 * parameter to, stores there, or the argument a `super().__init__(...)`
 * call passes for it whatever the caller passed.
 */
function fieldSource(
  cls: PyNode,
  name: string,
  facts: Database,
  files: Files,
  seen: Set<number>,
): Parameter | { fixed: PyNode } | null {
  if (seen.has(cls.id)) {
    return null;
  }
  seen.add(cls.id);
  const init = ownInit(cls);
  if (init === null) {
    // A class without its own constructor runs its base class's.
    const [base] = baseClasses(cls, facts, files);
    return base === undefined
      ? null
      : fieldSource(base, name, facts, files, seen);
  }
  const params = constructorParameters(init);
  const stored = storedParameter(init, name, params);
  if (stored !== null) {
    return stored;
  }
  const handedOn = superInitCall(init);
  const [base] = baseClasses(cls, facts, files);
  if (handedOn === null || base === undefined) {
    return null;
  }
  const baseSource = fieldSource(base, name, facts, files, seen);
  if (baseSource === null || "fixed" in baseSource) {
    return baseSource;
  }
  const passed = argumentFor(handedOn, baseSource);
  const param =
    passed?.type === "identifier"
      ? params.find((one) => one.name === passed.text)
      : undefined;
  if (param !== undefined) {
    return param;
  }
  return passed === null ? null : { fixed: passed };
}

/** The `__init__` a class body defines itself, or null. A decorated one is left out, since its decorator can change what it takes. */
function ownInit(cls: PyNode): PyNode | null {
  return (
    children(field(cls, "body")).find(
      (statement) =>
        statement.type === "function_definition" &&
        field(statement, "name")?.text === "__init__",
    ) ?? null
  );
}

/** The classes a class's bases come to, first base first. */
function baseClasses(cls: PyNode, facts: Database, files: Files): PyNode[] {
  const file = fileContaining(cls, files);
  if (file === null) {
    return [];
  }
  const keys = classBases(cls).flatMap((base) =>
    base.type === "identifier" || base.type === "attribute"
      ? [readKey(file, base, enclosingFunction(base))]
      : [],
  );
  const named = classesNamed(keys, facts, files);
  return keys.flatMap((key) => named.get(key) ?? []);
}

/** A constructor's parameters a caller fills by position, after `self`. */
function constructorParameters(init: PyNode): Parameter[] {
  const names = children(field(init, "parameters")).flatMap((param) => {
    const name = parameterIdentifier(param);
    return name === null ? [] : [name.text];
  });
  return names.slice(1).map((name, index) => ({ index, name }));
}

/** The parameter `self.<name> = <parameter>` writes, in the constructor's own body. */
function storedParameter(
  init: PyNode,
  name: string,
  params: readonly Parameter[],
): Parameter | null {
  const receiver = constructorReceiver(init);
  const assignments = ownNodes(field(init, "body")).filter(
    (node) => node.type === "assignment",
  );
  for (const assignment of assignments) {
    const left = field(assignment, "left");
    const right = field(assignment, "right");
    if (
      left?.type === "attribute" &&
      field(left, "object")?.text === receiver &&
      field(left, "attribute")?.text === name &&
      right?.type === "identifier"
    ) {
      return params.find((param) => param.name === right.text) ?? null;
    }
  }
  return null;
}

function constructorReceiver(init: PyNode): string | null {
  const [first] = children(field(init, "parameters"));
  return first === undefined
    ? null
    : (parameterIdentifier(first)?.text ?? null);
}

/** Every node written in a body, branches included. Functions and classes defined inside it are left out. */
function ownNodes(body: PyNode | null): PyNode[] {
  const found: PyNode[] = [];
  const visit = (node: PyNode): void => {
    for (const child of children(node)) {
      if (
        child.type !== "function_definition" &&
        child.type !== "class_definition"
      ) {
        found.push(child);
        visit(child);
      }
    }
  };
  if (body !== null) {
    visit(body);
  }
  return found;
}

/** The `super().__init__(...)` call a constructor makes, or null. */
function superInitCall(init: PyNode): PyNode | null {
  return ownNodes(field(init, "body")).find(isSuperInit) ?? null;
}

function isSuperInit(node: PyNode): boolean {
  const callee = node.type === "call" ? field(node, "function") : null;
  if (
    callee?.type !== "attribute" ||
    field(callee, "attribute")?.text !== "__init__"
  ) {
    return false;
  }
  const object = field(callee, "object");
  return object?.type === "call" && field(object, "function")?.text === "super";
}

/** The argument a call passes at a parameter, by keyword or by position. */
function argumentFor(call: PyNode, param: Parameter): PyNode | null {
  const args = children(field(call, "arguments"));
  const named = args.find(
    (arg) =>
      arg.type === "keyword_argument" &&
      field(arg, "name")?.text === param.name,
  );
  if (named !== undefined) {
    return field(named, "value");
  }
  // A splat shifts every position after it by an amount the source does
  // not say, so only the arguments written before one are counted.
  const splat = args.findIndex((arg) => arg.type === "list_splat");
  const positional = args
    .slice(0, splat === -1 ? args.length : splat)
    .filter(
      (arg) =>
        arg.type !== "keyword_argument" && arg.type !== "dictionary_splat",
    );
  return positional[param.index] ?? null;
}

function fileOfKey(key: string): string {
  return key.slice(0, key.lastIndexOf(":"));
}

function nodeOfKey(key: string, files: Files): PyNode | null {
  const file = fileOfKey(key);
  const bound = files.get(file);
  return bound === undefined ? null : nodeAt(file, bound.root, key);
}

function fileContaining(node: PyNode, files: Files): string | null {
  let root = node;
  while (root.parent !== null) {
    root = root.parent;
  }
  for (const [file, bound] of files) {
    if (bound.root === root) {
      return file;
    }
  }
  return null;
}
