/**
 * clientCalls.ts: a method that calls out over the network is a client
 * of the boundary that call states.
 *
 * A pack says which constant the library's request calls hang on, which
 * method names state the request method, and where the URL is written.
 * This reads the calls in each method body, evaluates the URL the same
 * way a route's path is evaluated, and reports the enclosing method as
 * a client of that method and path. A call at the top level of a file
 * has no unit to belong to, and one whose URL does not settle on a
 * string says nothing.
 */

import { restBinding } from "@suss/behavioral-ir";
import { pathOf } from "@suss/values";

import { field, rangeOf, readCallArgs, runStatements, spanOf } from "./ast.js";
import { invocationEffects } from "./paths/effects.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { RawCodeStructure } from "@suss/extractor";
import type { CallArgs, Range } from "./ast.js";
import type { RbClientCall, RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";

/** What one request call states about the boundary it reaches. */
interface RequestCall {
  method: string;
  path: string;
}

export interface ClientCallOptions {
  filePath: string;
  facts?: Database | undefined;
}

/**
 * One unit per request call a method in this file makes. A method that
 * makes two calls is a client of both boundaries, so it gets two.
 */
export function clientCallUnits(
  root: RbNode,
  pack: RubyPack,
  pattern: RbClientCall,
  options: ClientCallOptions,
): RawCodeStructure[] {
  const units: RawCodeStructure[] = [];
  for (const method of methodDefinitions(root)) {
    const name = field(method, "name")?.text;
    if (name === undefined) {
      continue;
    }
    for (const call of callsUnder(method)) {
      const request = requestCall(call, method, pattern, options);
      if (request === null) {
        continue;
      }
      units.push(clientUnit(method, name, request, pack, options));
    }
  }
  return units;
}

/** Every method this file defines, in a class or outside one. */
function methodDefinitions(node: RbNode, found: RbNode[] = []): RbNode[] {
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "method" || child.type === "singleton_method") {
      found.push(child);
    }
    methodDefinitions(child, found);
  }
  return found;
}

/** Every call written under a node. */
function callsUnder(node: RbNode, found: RbNode[] = []): RbNode[] {
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "call") {
      found.push(child);
    }
    callsUnder(child, found);
  }
  return found;
}

/** What this call says about the boundary, or null when it is not one of the library's. */
function requestCall(
  call: RbNode,
  method: RbNode,
  pattern: RbClientCall,
  options: ClientCallOptions,
): RequestCall | null {
  const receiver = field(call, "receiver");
  const called = field(call, "method")?.text;
  if (receiver === null || called === undefined) {
    return null;
  }
  const prefix = receiverPrefix(receiver, method, pattern, options);
  if (prefix === null) {
    return null;
  }
  const args = readCallArgs(field(call, "arguments"));

  const verb = pattern.verbMethodNames[called];
  if (verb !== undefined) {
    const path = urlIn(args, method, pattern, options);
    return path === null ? null : { method: verb, path: prefix + path };
  }

  const sent = pattern.requestObject;
  if (sent === undefined || sent.attribute !== called) {
    return null;
  }
  const built = requestBuilt(args.positional[0], method, sent);
  if (built === null) {
    return null;
  }
  const path = pathAt(built.url, method, pattern, options);
  return path === null ? null : { method: built.method, path: prefix + path };
}

/**
 * The request object a call was handed: one of the library's request
 * classes built in the call itself, or a local name assigned from one.
 */
function requestBuilt(
  argument: RbNode | undefined,
  method: RbNode,
  sent: NonNullable<RbClientCall["requestObject"]>,
): { method: string; url: RbNode | undefined } | null {
  const written =
    argument === undefined
      ? null
      : (assignedCall(argument, method) ?? argument);
  if (written === null || written.type !== "call") {
    return null;
  }
  const requestClass = field(written, "receiver")?.text;
  const verb =
    requestClass === undefined ? undefined : sent.constructors[requestClass];
  if (verb === undefined) {
    return null;
  }
  const args = readCallArgs(field(written, "arguments"));
  return { method: verb, url: args.positional[sent.urlPosition] };
}

/** The call a local name was assigned from in this method, or null for anything else. */
function assignedCall(node: RbNode, method: RbNode): RbNode | null {
  if (node.type !== "identifier") {
    return null;
  }
  const value = assignedValue(node.text, method);
  return value !== null && value.type === "call" ? value : null;
}

/**
 * The path in front of a call's own, which is empty for a call on the
 * library's constant and whatever base URL a builder was given for a
 * call on what it built. Null when the receiver is neither.
 */
function receiverPrefix(
  receiver: RbNode,
  method: RbNode,
  pattern: RbClientCall,
  options: ClientCallOptions,
): string | null {
  if (namesConstant(receiver, pattern.constantName)) {
    return "";
  }
  if (receiver.type !== "identifier") {
    return null;
  }
  const built = builtBy(receiver.text, method, pattern);
  if (built === null) {
    return null;
  }
  const keyword = pattern.builderUrlKeyword;
  if (keyword === undefined) {
    return "";
  }
  const base = readCallArgs(field(built, "arguments")).keyword[keyword];
  const path =
    base === undefined ? null : pathOf(evaluatedValue(base, options.facts));
  return path === undefined || path === null ? "" : trimmed(path);
}

/** A trailing slash on the base would double the one the call's own path starts with. */
function trimmed(path: string): string {
  return path === "/" ? "" : path.replace(/\/+$/, "");
}

/** Whether this receiver is the constant the pack named, `Faraday` or `Net::HTTP`. */
function namesConstant(receiver: RbNode, constantName: string): boolean {
  return (
    (receiver.type === "constant" || receiver.type === "scope_resolution") &&
    receiver.text === constantName
  );
}

/**
 * The call a local name was assigned from, when the library's own
 * builder made it. One assignment back and no further, the same one-hop
 * limit the other readers take.
 */
function builtBy(
  name: string,
  method: RbNode,
  pattern: RbClientCall,
): RbNode | null {
  const builders = pattern.receiverBuilders ?? [];
  const value = builders.length === 0 ? null : assignedValue(name, method);
  if (
    value === null ||
    value.type !== "call" ||
    !builders.includes(field(value, "method")?.text ?? "")
  ) {
    return null;
  }
  const receiver = field(value, "receiver");
  return receiver !== null && namesConstant(receiver, pattern.constantName)
    ? value
    : null;
}

/** What a local name was assigned in this method body, one assignment back and no further. */
function assignedValue(name: string, method: RbNode): RbNode | null {
  const body = field(method, "body");
  if (body === null) {
    return null;
  }
  for (const statement of runStatements(body)) {
    if (statement.type !== "assignment") {
      continue;
    }
    if (field(statement, "left")?.text === name) {
      return field(statement, "right");
    }
  }
  return null;
}

/** The path the URL argument states, or null when it does not settle on one. */
function urlIn(
  args: CallArgs,
  method: RbNode,
  pattern: RbClientCall,
  options: ClientCallOptions,
): string | null {
  const keyword = pattern.url.keyword;
  const written =
    (keyword === undefined ? undefined : args.keyword[keyword]) ??
    args.positional[pattern.url.position];
  return pathAt(written, method, pattern, options);
}

/**
 * The path one node states. A library that takes a URL object rather
 * than a string is given the calls that build one, and a local name is
 * followed one assignment back, which is where the URL of a request
 * built in several steps is written.
 */
function pathAt(
  written: RbNode | undefined,
  method: RbNode,
  pattern: RbClientCall,
  options: ClientCallOptions,
): string | null {
  if (written === undefined) {
    return null;
  }
  const stated = unwrapped(written, method, pattern);
  return pathOf(evaluatedValue(stated, options.facts)) ?? null;
}

/** The node the URL is actually written in, past a name and past a wrapper call. */
function unwrapped(
  written: RbNode,
  method: RbNode,
  pattern: RbClientCall,
): RbNode {
  const wrappers = pattern.urlWrappers ?? [];
  if (wrappers.length === 0) {
    return written;
  }
  const call =
    written.type === "call" ? written : assignedCall(written, method);
  if (call === null || !wrappers.includes(calleeName(call))) {
    return written;
  }
  return readCallArgs(field(call, "arguments")).positional[0] ?? written;
}

/** The name a call states, `URI` for `URI(...)` and `URI.parse` for the other spelling. */
function calleeName(call: RbNode): string {
  const receiver = field(call, "receiver");
  const named = field(call, "method")?.text ?? "";
  return receiver === null ? named : `${receiver.text}.${named}`;
}

/** The unit for the method the call is written in. */
function clientUnit(
  method: RbNode,
  name: string,
  request: RequestCall,
  pack: RubyPack,
  options: ClientCallOptions,
): RawCodeStructure {
  const range = rangeOf(method);
  return {
    identity: {
      name,
      nameKind: "binding",
      kind: "client",
      file: options.filePath,
      range,
      span: spanOf(method),
      exportName: name,
      exportPath: [name],
    },
    boundaryBinding: restBinding({
      transport: pack.protocol,
      method: request.method,
      path: request.path,
      recognition: pack.name,
    }),
    parameters: [],
    branches: [returnBranch(range, invocationEffects(method))],
    bodyContent: "statements",
    dependencyCalls: [],
    declaredContract: null,
  };
}

function returnBranch(
  range: Range,
  effects: ReturnType<typeof invocationEffects>,
): RawCodeStructure["branches"][number] {
  return {
    conditions: [],
    terminal: {
      kind: "return",
      statusCode: null,
      body: null,
      exceptionType: null,
      message: null,
      component: null,
      renderTree: null,
      delegateTarget: null,
      emitEvent: null,
      location: range,
    },
    effects,
    location: range,
    isDefault: true,
  };
}
