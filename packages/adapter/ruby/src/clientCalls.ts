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
 * string says nothing. The request object a library takes in place of a
 * URL is read from the value facts, so a run without them sees only the
 * request objects built in the call itself.
 */

import { hasNameHole, namesNothing, restBinding } from "@suss/behavioral-ir";
import { pathOf } from "@suss/values";

import { field, rangeOf, readCallArgs, spanOf } from "./ast.js";
import { invocationEffects } from "./paths/effects.js";
import { returnPathBranches } from "./responseStatus.js";
import { compoundName } from "./scope.js";
import {
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
 * What this call says about the boundary, once per boundary it states.
 * A URL the enclosing class takes in `initialize` says something
 * different per construction, so each of those is a request of its own.
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

  // Two constructions that state the same request are one call, since
  // nothing about the crossing tells them apart.
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

/** What this call says about the boundary, or null when it says nothing readable. */
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
 * The request object a call was handed: whatever the facts say the
 * argument was written as, or the argument itself, because the facts
 * drop a value's match against itself and a request class built in the
 * call is that match.
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
 * The path in front of a call's own, which is empty for a call on the
 * library's constant and whatever base URL a builder was given for a
 * call on what it built.
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
  // `Faraday.new(url: "...")` and `Faraday.new("...")` say the same thing.
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

/** Whether this receiver is the constant the pack named, `Faraday` or `Net::HTTP`. */
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
 * on. The receiver can be spelled any way the facts settle: a local, an
 * instance variable, or a method the class keeps its one connection in.
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
  const keyword = pattern.url.keyword;
  const written =
    (keyword === undefined ? undefined : args.keyword[keyword]) ??
    args.positional[pattern.url.position];
  return pathAt(written, options, site);
}

/**
 * The path one node states. A URL a library takes as an object rather
 * than a string, `URI("...")` in Ruby, comes back from the value tables
 * as the string it was built from, so nothing here unwraps anything.
 */
function pathAt(
  written: RbNode | undefined,
  options: ClientCallOptions,
  site?: string,
): string | null {
  if (written === undefined) {
    return null;
  }
  // A URL handed in whole evaluates to one hole and nothing else, and
  // a path like that matches no route and pairs with nothing.
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
