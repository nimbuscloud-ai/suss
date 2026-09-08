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

import { namesNothing, restBinding } from "@suss/behavioral-ir";
import { pathOf } from "@suss/values";

import { field, rangeOf, readCallArgs, runStatements, spanOf } from "./ast.js";
import { invocationEffects } from "./paths/effects.js";
import { returnPathBranches } from "./responseStatus.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { RawBranch, RawCodeStructure } from "@suss/extractor";
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
      const request = requestCall(call, method, root, pattern, options);
      if (request === null) {
        continue;
      }
      units.push(clientUnit(method, name, request, pattern, pack, options));
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
  root: RbNode,
  pattern: RbClientCall,
  options: ClientCallOptions,
): RequestCall | null {
  const receiver = field(call, "receiver");
  const called = field(call, "method")?.text;
  if (receiver === null || called === undefined) {
    return null;
  }
  const prefix = receiverPrefix(receiver, method, root, pattern, options);
  if (prefix === null) {
    return null;
  }
  const args = readCallArgs(field(call, "arguments"));

  const verb = pattern.verbMethodNames[called];
  if (verb !== undefined) {
    const path = urlIn(args, pattern, options);
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
  const path = pathAt(built.url, options);
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
  root: RbNode,
  pattern: RbClientCall,
  options: ClientCallOptions,
): string | null {
  if (namesConstant(receiver, pattern.constantName)) {
    return "";
  }
  if (receiver.type !== "identifier") {
    return null;
  }
  const built = builtBy(receiver.text, method, root, pattern);
  if (built === null) {
    return null;
  }
  const args = readCallArgs(field(built, "arguments"));
  const keyword = pattern.builderUrlKeyword;
  // `Faraday.new(url: "...")` and `Faraday.new("...")` say the same thing.
  const base =
    (keyword === undefined ? undefined : args.keyword[keyword]) ??
    args.positional[0];
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
 * The call the library's own builder made, behind the name a request
 * was called on. A local assignment in the same method, or a method of
 * that name in the same file, which is where a service object keeps the
 * one connection its request methods share.
 */
function builtBy(
  name: string,
  method: RbNode,
  root: RbNode,
  pattern: RbClientCall,
): RbNode | null {
  const builders = pattern.receiverBuilders ?? [];
  if (builders.length === 0) {
    return null;
  }

  const value =
    assignedValue(name, method) ?? valueMethodNamedReturns(name, root);
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

/**
 * What a method of this name in the same file comes back with. Ruby
 * returns the last statement, and a method that keeps one connection
 * writes `@conn ||= ...`, so the value is on the right of that.
 */
function valueMethodNamedReturns(name: string, root: RbNode): RbNode | null {
  const defined = methodDefinitions(root).find(
    (candidate) => field(candidate, "name")?.text === name,
  );
  if (defined === undefined) {
    return null;
  }

  const body = field(defined, "body");
  const statements = body === null ? [] : body.namedChildren;
  const last = statements[statements.length - 1];
  if (last === undefined) {
    return null;
  }
  if (last.type === "operator_assignment" || last.type === "assignment") {
    return field(last, "right");
  }
  return last.type === "return" ? (last.namedChildren[0] ?? null) : last;
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
  pattern: RbClientCall,
  options: ClientCallOptions,
): string | null {
  const keyword = pattern.url.keyword;
  const written =
    (keyword === undefined ? undefined : args.keyword[keyword]) ??
    args.positional[pattern.url.position];
  return pathAt(written, options);
}

/**
 * The path one node states. A URL a library takes as an object rather
 * than a string, `URI("...")` in Ruby, comes back from the value tables
 * as the string it was built from, so nothing here unwraps anything.
 */
function pathAt(
  written: RbNode | undefined,
  options: ClientCallOptions,
): string | null {
  if (written === undefined) {
    return null;
  }
  // A path that is one hole and nothing else, which is what a URL
  // handed in whole gives, names no route and pairs with nothing.
  const path = pathOf(evaluatedValue(written, options.facts));
  return path === undefined || namesNothing(path) ? null : path;
}

/** The unit for the method the call is written in. */
function clientUnit(
  method: RbNode,
  name: string,
  request: RequestCall,
  pattern: RbClientCall,
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
    branches: callerBranches(method, range),
    ...responseAccessors(pattern),
    bodyContent: "statements",
    dependencyCalls: [],
    declaredContract: null,
  };
}

/**
 * One branch per path the caller takes after the call, so a test it
 * writes on the response says which statuses it handles.
 */
function callerBranches(method: RbNode, range: Range): RawBranch[] {
  const effects = invocationEffects(method);
  return returnPathBranches(method, effects) ?? [returnBranch(range, effects)];
}

/** The members of the response the pack said mean each thing. */
function responseAccessors(pattern: RbClientCall): {
  bodyAccessors?: string[];
  statusAccessors?: string[];
  successAccessors?: string[];
  failureDelivery?: "response" | "exception";
} {
  const response = pattern.response;
  if (response === undefined) {
    return {};
  }
  return {
    ...(response.body === undefined ? {} : { bodyAccessors: response.body }),
    ...(response.statusCode === undefined
      ? {}
      : { statusAccessors: response.statusCode }),
    ...(response.success === undefined
      ? {}
      : { successAccessors: response.success }),
    ...(response.failureDelivery === undefined
      ? {}
      : { failureDelivery: response.failureDelivery }),
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
