/**
 * clientCalls.ts: a function that calls out over the network is a
 * client of the boundary that call states.
 *
 * A pack says which callables its library gives a project for making a
 * request, where each one states the method, and where it states the
 * URL. This reads the calls in each function body, evaluates the URL
 * the same way a route's path is evaluated, and reports the enclosing
 * function as a client of that method and path. A call written at
 * module level has no unit to belong to and is left alone, and so is
 * one whose URL does not settle on a string.
 */

import { restBinding } from "@suss/behavioral-ir";
import { pathOf } from "@suss/values";

import {
  children,
  field,
  isFunction,
  rangeOf,
  spanOf,
  stringLiteralValue,
} from "./ast.js";
import { bodyTerminals, enumerateBodyBranches } from "./paths/bodyBranches.js";
import { bodyCalls, invocationEffects } from "./paths/effects.js";
import { constructorCalled } from "./routers.js";
import { resolveName, scopeAt } from "./scope.js";
import { evaluatedValue } from "./values/evaluator.js";
import { originOf } from "./values/origin.js";

import type { Database } from "@suss/datalog";
import type { RawBranch, RawCodeStructure } from "@suss/extractor";
import type { PyClientCall, PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { TerminalBranch } from "./paths/bodyBranches.js";
import type { ModuleBinding } from "./scope.js";

/** What one request call states about the boundary it reaches. */
interface RequestCall {
  method: string;
  path: string;
  range: ReturnType<typeof rangeOf>;
}

export interface ClientCallOptions {
  filePath: string;
  facts?: Database | undefined;
}

/**
 * One unit per request call a function in this file makes. A function
 * that makes two calls is a client of both boundaries, so it gets two.
 */
export function clientCallUnits(
  root: PyNode,
  module: ModuleBinding,
  pack: PythonPack,
  pattern: PyClientCall,
  options: ClientCallOptions,
): RawCodeStructure[] {
  const units: RawCodeStructure[] = [];
  for (const definition of functionDefinitions(root)) {
    const name = field(definition, "name")?.text;
    if (name === undefined) {
      continue;
    }
    for (const call of bodyCalls(definition)) {
      const request = requestCall(call, pattern, module, options);
      if (request === null) {
        continue;
      }
      units.push(clientUnit(definition, name, request, pattern, pack, options));
    }
  }
  return units;
}

/** Every function this file defines, methods included, outermost first. */
function functionDefinitions(node: PyNode, found: PyNode[] = []): PyNode[] {
  for (const child of children(node)) {
    if (isFunction(child)) {
      found.push(child);
    }
    functionDefinitions(child, found);
  }
  return found;
}

/** What this call says about the boundary, or null when it is not one of the library's. */
function requestCall(
  call: PyNode,
  pattern: PyClientCall,
  module: ModuleBinding,
  options: ClientCallOptions,
): RequestCall | null {
  const callee = field(call, "function");
  if (callee === null) {
    return null;
  }
  const attribute = calledAttribute(callee, pattern, module);
  if (attribute === null) {
    return null;
  }

  const verb = pattern.verbAttributeNames[attribute];
  if (verb !== undefined) {
    const path = urlAt(
      call,
      pattern.url.position,
      pattern.url.keyword,
      options,
    );
    return path === null ? null : { method: verb, path, range: rangeOf(call) };
  }

  const methodCall = pattern.methodCall;
  if (methodCall === undefined || methodCall.attribute !== attribute) {
    return null;
  }
  const stated = argumentAt(
    call,
    methodCall.methodPosition,
    methodCall.methodKeyword,
  );
  const method = stated === null ? null : stringLiteralValue(stated);
  if (method === null) {
    return null;
  }
  const path = urlAt(
    call,
    methodCall.urlPosition,
    pattern.url.keyword,
    options,
  );
  return path === null
    ? null
    : { method: method.toUpperCase(), path, range: rangeOf(call) };
}

/**
 * The attribute a call names on one of the library's callables:
 * `requests.get`, a bare `get` imported from it, or `session.get` on a
 * value the library's own constructor built.
 */
function calledAttribute(
  callee: PyNode,
  pattern: PyClientCall,
  module: ModuleBinding,
): string | null {
  const origin = originOf(callee, module);
  if (origin !== null) {
    return pattern.importModule.includes(origin.module) ? origin.name : null;
  }

  const object = field(callee, "object");
  const attribute = field(callee, "attribute")?.text;
  if (
    object === null ||
    object.type !== "identifier" ||
    attribute === undefined
  ) {
    return null;
  }
  const constructorName = receiverConstructor(
    object,
    module,
    pattern.importModule,
  );
  const constructors = pattern.receiverConstructors ?? [];
  return constructorName !== null && constructors.includes(constructorName)
    ? attribute
    : null;
}

/**
 * The constructor a receiver was built by, read off the scope binding
 * because the value facts leave an as-pattern without a value and
 * `with httpx.Client() as client` is how a project opens one.
 */
function receiverConstructor(
  object: PyNode,
  module: ModuleBinding,
  importModule: readonly string[],
): string | null {
  const binding = resolveName(scopeAt(object, module), object.text);
  if (binding?.kind !== "assignment" || binding.value?.type !== "call") {
    return null;
  }
  return constructorCalled(binding.value, module, importModule);
}

/** The path the URL argument states, or null when it does not settle on one. */
function urlAt(
  call: PyNode,
  position: number,
  keyword: string,
  options: ClientCallOptions,
): string | null {
  const argument = argumentAt(call, position, keyword);
  if (argument === null) {
    return null;
  }
  return pathOf(evaluatedValue(argument, options.facts)) ?? null;
}

/** The argument at a position, or the one written under a keyword. */
function argumentAt(
  call: PyNode,
  position: number,
  keyword?: string,
): PyNode | null {
  const args = field(call, "arguments");
  if (args === null) {
    return null;
  }
  const positional: PyNode[] = [];
  for (const child of children(args)) {
    if (child.type === "keyword_argument") {
      const name = field(child, "name")?.text;
      if (keyword !== undefined && name === keyword) {
        return field(child, "value");
      }
      continue;
    }
    positional.push(child);
  }
  return positional[position] ?? null;
}

/**
 * One branch per path the caller takes after the call, so a test on the
 * response says which statuses this caller handles. The conditions come
 * out of the same walk a route's do, which is where their structure,
 * and with it the status a guard names, comes from.
 */
function callerBranches(
  definition: PyNode,
  range: ReturnType<typeof rangeOf>,
  facts: Database | undefined,
): RawBranch[] {
  const body = field(definition, "body");
  const effects = invocationEffects(definition, facts);
  const terminals = bodyTerminals(body, []);
  if (body === null || terminals.length === 0) {
    return [handsBack(range, effects)];
  }
  const branches = enumerateBodyBranches({
    body,
    terminals,
    raised: [],
    effects,
    branchOf: (found) =>
      found.type === "raise"
        ? { terminal: found.terminal, location: rangeOf(found.statement) }
        : handsBackAt(rangeOf(found.statement)),
    fallthrough: handsBackAt(range),
    facts,
  });
  return branches.length === 0 ? [handsBack(range, effects)] : branches;
}

/** What a caller does at the end of a path: it hands back whatever it got. */
function handsBackAt(range: ReturnType<typeof rangeOf>): TerminalBranch {
  return {
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
    location: range,
  };
}

/** The one branch of a caller whose body writes no exit of its own. */
function handsBack(
  range: ReturnType<typeof rangeOf>,
  effects: ReturnType<typeof invocationEffects>,
): RawBranch {
  return {
    ...handsBackAt(range),
    conditions: [],
    effects,
    isDefault: true,
  };
}

/** The members of the response the pack said mean each thing. */
function responseAccessors(pattern: PyClientCall): {
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

/** The unit for the function the call is written in. */
function clientUnit(
  definition: PyNode,
  name: string,
  request: RequestCall,
  pattern: PyClientCall,
  pack: PythonPack,
  options: ClientCallOptions,
): RawCodeStructure {
  const range = rangeOf(definition);
  return {
    identity: {
      name,
      nameKind: "binding",
      kind: "client",
      file: options.filePath,
      range,
      span: spanOf(definition),
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
    branches: callerBranches(definition, range, options.facts),
    ...responseAccessors(pattern),
    bodyContent: "statements",
    dependencyCalls: [],
    declaredContract: null,
  };
}
