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
  const verb = pattern.verbMethodNames[called];
  if (verb === undefined) {
    return null;
  }

  const prefix = receiverPrefix(receiver, method, pattern, options);
  if (prefix === null) {
    return null;
  }
  const args = readCallArgs(field(call, "arguments"));
  const path = urlIn(args, pattern, options);
  return path === null ? null : { method: verb, path: prefix + path };
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
  const body = field(method, "body");
  if (body === null || builders.length === 0) {
    return null;
  }
  for (const statement of runStatements(body)) {
    if (statement.type !== "assignment") {
      continue;
    }
    const target = field(statement, "left");
    const value = field(statement, "right");
    if (
      target?.text !== name ||
      value === null ||
      value.type !== "call" ||
      !builders.includes(field(value, "method")?.text ?? "")
    ) {
      continue;
    }
    const receiver = field(value, "receiver");
    if (receiver !== null && namesConstant(receiver, pattern.constantName)) {
      return value;
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
  if (written === undefined) {
    return null;
  }
  return pathOf(evaluatedValue(written, options.facts)) ?? null;
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
