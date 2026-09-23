/**
 * Finds methods that call out over the network. Each becomes a client of
 * the boundary its call reaches.
 *
 * A pack says which constant the library's request calls are made on,
 * which method names send which request method, and where the URL is
 * written. This module reads the calls in each method body, evaluates the
 * URL the same way a route's path is evaluated, and reports the enclosing
 * method as a client of that method and path. A call at the top level of
 * a file has no unit to belong to, and a call whose URL does not settle
 * on a string is skipped. A request object passed in place of a URL is
 * read through the value facts, so a run without facts sees only request
 * objects built in the call itself.
 */

import { hasNameHole, namesNothing, restBinding } from "@suss/behavioral-ir";
import { pathOf } from "@suss/values";

import { field, rangeOf, readCallArgs, spanOf } from "./ast.js";
import { invocationEffects } from "./paths/effects.js";
import { returnPathBranches } from "./responseStatus.js";
import { compoundName } from "./scope.js";
import {
  askWrittenValues,
  constructionSitesOf,
  evaluatedValue,
  writtenNodeOf,
} from "./values/evaluator.js";

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
      for (const request of requestCalls(call, pattern, options)) {
        units.push(clientUnit(method, name, request, pattern, pack, options));
      }
    }
  }
  return units;
}

/**
 * Settles what this file's request calls read, before any one of them is
 * read on its own. Each question runs the rules again, so asking per call
 * site is slow on a large project.
 *
 * It asks in two rounds. The first settles which receivers the library
 * built, since that decides which calls have a URL to read.
 */
export function askClientCallReads(
  root: RbNode,
  patterns: readonly RbClientCall[],
  options: ClientCallOptions,
): void {
  const facts = options.facts;
  if (facts === undefined || patterns.length === 0) {
    return;
  }
  const calls: RbNode[] = [];
  for (const method of methodDefinitions(root)) {
    calls.push(...callsUnder(method));
  }
  if (patterns.some((pattern) => (pattern.receiverBuilders ?? []).length > 0)) {
    askWrittenValues(receiversOf(calls), facts);
  }
  askWrittenValues(requestArguments(calls, patterns, options), facts);
}

function receiversOf(calls: readonly RbNode[]): RbNode[] {
  const found: RbNode[] = [];
  for (const call of calls) {
    const receiver = field(call, "receiver");
    if (receiver !== null) {
      found.push(receiver);
    }
  }
  return found;
}

/** The URL, or the request object, each call on the library was given. */
function requestArguments(
  calls: readonly RbNode[],
  patterns: readonly RbClientCall[],
  options: ClientCallOptions,
): RbNode[] {
  const found: RbNode[] = [];
  for (const call of calls) {
    const receiver = field(call, "receiver");
    const called = field(call, "method")?.text;
    if (receiver === null || called === undefined) {
      continue;
    }
    for (const pattern of patterns) {
      if (!isLibraryReceiver(receiver, pattern, options)) {
        continue;
      }
      const argument = requestArgument(call, called, pattern);
      if (argument !== undefined) {
        found.push(argument);
      }
    }
  }
  return found;
}

/** The URL a request method was given, or the request object a sending call was given. */
function requestArgument(
  call: RbNode,
  called: string,
  pattern: RbClientCall,
): RbNode | undefined {
  const args = readCallArgs(field(call, "arguments"));
  if (pattern.verbMethodNames[called] !== undefined) {
    return urlNodeIn(args, pattern);
  }
  return pattern.requestObject?.attribute === called
    ? args.positional[0]
    : undefined;
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

/**
 * The requests this call makes, one per boundary. A URL the enclosing
 * class takes in `initialize` can differ per construction, so each
 * construction gives a request of its own.
 */
function requestCalls(
  call: RbNode,
  pattern: RbClientCall,
  options: ClientCallOptions,
): RequestCall[] {
  const receiver = field(call, "receiver");
  const called = field(call, "method")?.text;
  if (
    receiver === null ||
    called === undefined ||
    !isLibraryReceiver(receiver, pattern, options)
  ) {
    return [];
  }
  const read = (site?: string): RequestCall | null =>
    requestCall(
      call,
      called,
      receiverPrefix(receiver, pattern, options, site),
      pattern,
      options,
      site,
    );

  const plain = read();
  if (plain !== null && !hasNameHole(plain.path)) {
    return [plain];
  }

  // Two constructions that give the same request count as one call,
  // since nothing at the boundary tells them apart.
  const byBoundary = new Map<string, RequestCall>();
  for (const site of constructionSitesOf(call, options.facts)) {
    const stated = read(site);
    if (stated !== null) {
      byBoundary.set(`${stated.method} ${stated.path}`, stated);
    }
  }
  if (byBoundary.size > 0) {
    return [...byBoundary.values()];
  }
  return plain === null ? [] : [plain];
}

/** The request this call makes, or null when it cannot be read. */
function requestCall(
  call: RbNode,
  called: string,
  prefix: string,
  pattern: RbClientCall,
  options: ClientCallOptions,
  site?: string,
): RequestCall | null {
  const args = readCallArgs(field(call, "arguments"));

  const verb = pattern.verbMethodNames[called];
  if (verb !== undefined) {
    const path = urlIn(args, pattern, options, site);
    return path === null ? null : { method: verb, path: prefix + path };
  }

  const sent = pattern.requestObject;
  if (sent === undefined || sent.attribute !== called) {
    return null;
  }
  const built = requestBuilt(args.positional[0], sent, options, site);
  if (built === null) {
    return null;
  }
  const path = pathAt(built.url, options, site);
  return path === null ? null : { method: built.method, path: prefix + path };
}

/**
 * The request object a call was given: what the facts say the argument
 * was written as, or the argument itself. The facts leave out a value
 * written as itself, which is the case for a request built in the call.
 */
function requestBuilt(
  argument: RbNode | undefined,
  sent: NonNullable<RbClientCall["requestObject"]>,
  options: ClientCallOptions,
  site?: string,
): { method: string; url: RbNode | undefined } | null {
  if (argument === undefined) {
    return null;
  }
  const written = writtenNodeOf(argument, options.facts, site) ?? argument;
  if (written.type !== "call") {
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

/** Whether a call on this receiver is a call on something the library gave the project. */
function isLibraryReceiver(
  receiver: RbNode,
  pattern: RbClientCall,
  options: ClientCallOptions,
): boolean {
  return (
    namesConstant(receiver, pattern.constantName) ||
    builderCallBehind(receiver, pattern, options.facts) !== null
  );
}

/**
 * The path that goes in front of a call's own path. It is empty for a
 * call on the library's constant, and the builder's base URL for a call
 * on what a builder returned.
 */
function receiverPrefix(
  receiver: RbNode,
  pattern: RbClientCall,
  options: ClientCallOptions,
  site?: string,
): string {
  const built = builderCallBehind(receiver, pattern, options.facts);
  if (built === null) {
    return "";
  }
  const args = readCallArgs(field(built, "arguments"));
  const keyword = pattern.builderUrlKeyword;
  // `Faraday.new(url: "...")` and `Faraday.new("...")` give the same base URL.
  const base =
    (keyword === undefined ? undefined : args.keyword[keyword]) ??
    args.positional[0];
  const path =
    base === undefined
      ? null
      : pathOf(evaluatedValue(base, options.facts, undefined, site));
  return path === undefined || path === null ? "" : trimmed(path);
}

/** A trailing slash on the base would double the one the call's own path starts with. */
function trimmed(path: string): string {
  return path === "/" ? "" : path.replace(/\/+$/, "");
}

/** Whether this receiver is the constant the pack declared, such as `Faraday` or `Net::HTTP`. */
function namesConstant(receiver: RbNode, constantName: string): boolean {
  if (receiver.type === "constant") {
    return receiver.text === constantName;
  }
  return (
    receiver.type === "scope_resolution" &&
    compoundName(receiver) === constantName
  );
}

/**
 * The library's own builder call behind whatever a request was called
 * on. The receiver can be anything the facts settle: a local, an instance
 * variable, or a method that returns the class's one connection.
 */
function builderCallBehind(
  receiver: RbNode,
  pattern: RbClientCall,
  facts: Database | undefined,
): RbNode | null {
  const builders = pattern.receiverBuilders ?? [];
  if (builders.length === 0) {
    return null;
  }

  const written = writtenNodeOf(receiver, facts);
  if (
    written === null ||
    written.type !== "call" ||
    !builders.includes(field(written, "method")?.text ?? "")
  ) {
    return null;
  }
  const constant = field(written, "receiver");
  return constant !== null && namesConstant(constant, pattern.constantName)
    ? written
    : null;
}

/** The path the URL argument states, or null when it does not settle on one. */
function urlIn(
  args: CallArgs,
  pattern: RbClientCall,
  options: ClientCallOptions,
  site?: string,
): string | null {
  return pathAt(urlNodeIn(args, pattern), options, site);
}

/** The URL argument, under the pack's keyword when it gives one and at the pack's position otherwise. */
function urlNodeIn(args: CallArgs, pattern: RbClientCall): RbNode | undefined {
  const keyword = pattern.url.keyword;
  return (
    (keyword === undefined ? undefined : args.keyword[keyword]) ??
    args.positional[pattern.url.position]
  );
}

/**
 * The path one node gives. A URL passed as an object instead of a
 * string, such as `URI("...")`, comes back from the value tables as the
 * string it was built from, so nothing here needs to unwrap it.
 */
function pathAt(
  written: RbNode | undefined,
  options: ClientCallOptions,
  site?: string,
): string | null {
  if (written === undefined) {
    return null;
  }
  // A URL passed in whole evaluates to a single hole. That path cannot
  // match any route, so it is dropped.
  const path = pathOf(evaluatedValue(written, options.facts, undefined, site));
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
    branches: callerBranches(method, range, options.facts),
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
function callerBranches(
  method: RbNode,
  range: Range,
  facts: Database | undefined,
): RawBranch[] {
  const effects = invocationEffects(method, undefined, undefined, facts);
  return returnPathBranches(method, effects) ?? [returnBranch(range, effects)];
}

/** The response members the pack declares for the body, the status and the success flag. */
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
