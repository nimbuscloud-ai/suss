/**
 * Makes a function that calls out over the network a client of the
 * method and path that call states.
 *
 * A pack lists the callables its library provides for making a request,
 * and where each one takes the method and the URL. This module reads the
 * calls in each function body, evaluates the URL the same way a route's
 * path is evaluated, and reports the enclosing function as a client of
 * that method and path. A call at module level has no function to belong
 * to, and a call whose URL does not settle on a string claims no path.
 * Both are skipped here.
 */

import {
  hasNameHole,
  restBinding,
  statusMembersOf,
  testsStatus,
} from "@suss/behavioral-ir";
import { redirectDeliveryWhenSet } from "@suss/extractor";
import { pathOf, scalarOf } from "@suss/values";

import {
  children,
  field,
  isFunction,
  rangeOf,
  spanOf,
  stringLiteralValue,
} from "./ast.js";
import { bodyTerminals, enumerateBodyBranches } from "./paths/bodyBranches.js";
import { bodyCalls, invocationSites } from "./paths/effects.js";
import { predicateOf } from "./paths/predicates.js";
import { raisesIn } from "./paths/raisedResponses.js";
import {
  type HandOffOptions,
  throughResponseHelpers,
} from "./responseHandOff.js";
import {
  constructionBehind,
  constructionSitesOf,
  evaluatedValue,
  moduleOf,
} from "./values/evaluator.js";
import { originOf } from "./values/origin.js";

import type { Database } from "@suss/datalog";
import type {
  RawBranch,
  RawCodeStructure,
  RawEffect,
  RedirectDelivery,
} from "@suss/extractor";
import type { PyClientCall, PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { TerminalBranch } from "./paths/bodyBranches.js";
import type { ModuleBinding } from "./scope.js";

/** What one request call states about the boundary it reaches. */
interface RequestCall {
  method: string;
  path: string;
  range: ReturnType<typeof rangeOf>;
  /** The call itself, so a helper the caller hands the response to can be told apart. */
  node: PyNode;
  /** What this call does with a redirect, when it passes the pack's option. */
  redirectDelivery?: RedirectDelivery;
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
      for (const request of requestCalls(call, pattern, module, options)) {
        units.push(
          clientUnit(definition, name, request, pattern, pack, options),
        );
      }
    }
  }
  return units;
}

/**
 * Every receiver in this file's functions that `calledAttribute` will ask
 * the rules about. A caller settles them all in one round before reading
 * any, because each round runs over the whole project's facts.
 *
 * The receivers do not depend on the pattern, so one walk covers every
 * pack in the run.
 */
export function clientCallReceivers(
  root: PyNode,
  module: ModuleBinding,
): PyNode[] {
  const found: PyNode[] = [];
  for (const definition of functionDefinitions(root)) {
    for (const call of bodyCalls(definition)) {
      const callee = field(call, "function");
      if (callee === null || originOf(callee, module) !== null) {
        continue;
      }
      const object = field(callee, "object");
      if (object !== null && field(callee, "attribute") !== null) {
        found.push(object);
      }
    }
  }
  return found;
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

/**
 * The request this call makes, once per method and path it can reach. A
 * URL the enclosing class takes in `__init__` can differ between
 * constructions, so each construction gives a request of its own.
 */
function requestCalls(
  call: PyNode,
  pattern: PyClientCall,
  module: ModuleBinding,
  options: ClientCallOptions,
): RequestCall[] {
  const callee = field(call, "function");
  const attribute =
    callee === null
      ? null
      : calledAttribute(callee, pattern, module, options.facts);
  if (attribute === null) {
    return [];
  }
  const plain = requestCall(call, attribute, pattern, options);
  if (plain !== null && !hasNameHole(plain.path)) {
    return [plain];
  }

  // Two constructions with the same method and path give one request,
  // since the boundary is the same for both.
  const byBoundary = new Map<string, RequestCall>();
  for (const site of constructionSitesOf(call, options.facts)) {
    const stated = requestCall(call, attribute, pattern, options, site);
    if (stated === null) {
      continue;
    }
    const key = `${stated.method} ${stated.path}`;
    if (!byBoundary.has(key)) {
      byBoundary.set(key, stated);
    }
  }
  if (byBoundary.size > 0) {
    return [...byBoundary.values()];
  }
  return plain === null ? [] : [plain];
}

/** The method and path this call states, or null when either cannot be read. */
function requestCall(
  call: PyNode,
  attribute: string,
  pattern: PyClientCall,
  options: ClientCallOptions,
  site?: string,
): RequestCall | null {
  const stated = methodAndPath(call, attribute, pattern, options, site);
  if (stated === null) {
    return null;
  }
  const redirectDelivery = redirectDeliveryAt(call, pattern, options, site);
  return redirectDelivery === undefined
    ? stated
    : { ...stated, redirectDelivery };
}

/**
 * What the call does with a redirect when it passes the pack's redirect
 * option with a value the evaluator settles, as `allow_redirects=False`
 * does. Undefined leaves the pack's default.
 */
function redirectDeliveryAt(
  call: PyNode,
  pattern: PyClientCall,
  options: ClientCallOptions,
  site?: string,
): RedirectDelivery | undefined {
  const option = pattern.response?.redirectOption;
  const argument =
    option === undefined ? null : argumentAt(call, null, option.name);
  if (option === undefined || argument === null) {
    return undefined;
  }
  const value = scalarOf(evaluatedValue(argument, options.facts, site));
  return value === null ? undefined : redirectDeliveryWhenSet(option, value);
}

function methodAndPath(
  call: PyNode,
  attribute: string,
  pattern: PyClientCall,
  options: ClientCallOptions,
  site?: string,
): RequestCall | null {
  const verb = pattern.verbAttributeNames[attribute];
  if (verb !== undefined) {
    const path = urlAt(
      call,
      pattern.url.position,
      pattern.url.keyword,
      options,
      site,
    );
    return path === null
      ? null
      : { method: verb, path, range: rangeOf(call), node: call };
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
    site,
  );
  return path === null
    ? null
    : { method: method.toUpperCase(), path, range: rangeOf(call), node: call };
}

/**
 * The library callable a call reaches, by its attribute name:
 * `requests.get`, a bare `get` imported from it, or `session.get` on a
 * value the library's own constructor built.
 */
function calledAttribute(
  callee: PyNode,
  pattern: PyClientCall,
  module: ModuleBinding,
  facts: Database | undefined,
): string | null {
  const origin = originOf(callee, module);
  if (origin !== null) {
    return pattern.importModule.includes(origin.module) ? origin.name : null;
  }

  const object = field(callee, "object");
  const attribute = field(callee, "attribute")?.text;
  if (object === null || attribute === undefined) {
    return null;
  }
  const constructorName = receiverConstructor(
    object,
    pattern.importModule,
    facts,
  );
  const constructors = pattern.receiverConstructors ?? [];
  return constructorName !== null && constructors.includes(constructorName)
    ? attribute
    : null;
}

/** The constructor a receiver was built by, whether it was assigned or opened with `with`. */
function receiverConstructor(
  object: PyNode,
  importModule: readonly string[],
  facts: Database | undefined,
): string | null {
  const built = constructionBehind(object, facts);
  if (built.type !== "oneCall") {
    return null;
  }
  const { origin } = built.construction;
  return importModule.includes(origin.module) ? origin.name : null;
}

/** The path the URL argument states, or null when it does not settle on one. */
function urlAt(
  call: PyNode,
  position: number,
  keyword: string,
  options: ClientCallOptions,
  site?: string,
): string | null {
  const argument = argumentAt(call, position, keyword);
  if (argument === null) {
    return null;
  }
  return pathOf(evaluatedValue(argument, options.facts, site)) ?? null;
}

/**
 * The argument written under a keyword, or the one at a position. A null
 * position reads the keyword only.
 */
function argumentAt(
  call: PyNode,
  position: number | null,
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
  return position === null ? null : (positional[position] ?? null);
}

/**
 * One branch per path the caller takes after the call, so a test on the
 * response shows which statuses this caller handles. The conditions come
 * from the same walk as a route's, so the checker can read the status a
 * guard tests. Each arm of a test on a status member stays a branch of
 * its own, even in a body that never returns.
 */
function callerBranches(
  definition: PyNode,
  reading: CallerReading,
): RawBranch[] {
  const range = rangeOf(definition);
  const body = field(definition, "body");
  const sites = invocationSites(definition, reading.facts);
  const effects = sites.map((site) => site.effect);
  if (body === null) {
    return [handsBack(range, effects)];
  }
  const raised = raisesIn(body, {
    calls: [],
    module: moduleOf(definition),
    facts: reading.facts,
  });
  const branches = enumerateBodyBranches({
    body,
    terminals: bodyTerminals(body, raised),
    raised,
    effects,
    branchOf: (found) =>
      found.type === "raise"
        ? { terminal: found.terminal, location: rangeOf(found.statement) }
        : handsBackAt(rangeOf(found.statement)),
    fallthrough: handsBackAt(range),
    facts: reading.facts,
    keepsArms: (condition) =>
      testsStatus(predicateOf(condition, reading.facts), reading.statusMembers),
  });
  const found = branches.length === 0 ? [handsBack(range, effects)] : branches;
  return reading.handOff === undefined
    ? found
    : throughResponseHelpers(found, sites, reading.handOff);
}

/** What reading a caller's paths needs beyond its body. */
interface CallerReading {
  facts: Database | undefined;
  statusMembers: ReadonlySet<string>;
  /** Unset for a helper, whose own hand-offs are not followed. */
  handOff?: HandOffOptions;
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
  effects: RawEffect[],
): RawBranch {
  return {
    ...handsBackAt(range),
    conditions: [],
    effects,
    isDefault: true,
  };
}

/** The response members the pack declares for the body, the status and the success flag. */
function responseAccessors(pattern: PyClientCall): {
  bodyAccessors?: string[];
  statusAccessors?: string[];
  successAccessors?: string[];
  failureDelivery?: "response" | "exception";
  redirectDelivery?: "followed" | "response";
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
    ...(response.redirectDelivery === undefined
      ? {}
      : { redirectDelivery: response.redirectDelivery }),
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
  const accessors = responseAccessors(pattern);
  const statusMembers = statusMembersOf(accessors);
  const reading: CallerReading = {
    facts: options.facts,
    statusMembers,
    handOff: {
      request: request.node,
      bodyMethods: accessors.bodyAccessors ?? [],
      facts: options.facts,
      readHelper: (helper) =>
        callerBranches(helper, { facts: options.facts, statusMembers }),
    },
  };
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
    branches: callerBranches(definition, reading),
    ...accessors,
    ...(request.redirectDelivery === undefined
      ? {}
      : { redirectDelivery: request.redirectDelivery }),
    bodyContent: "statements",
    dependencyCalls: [],
    declaredContract: null,
  };
}
