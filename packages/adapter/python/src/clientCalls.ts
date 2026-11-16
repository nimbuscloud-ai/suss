/**
 * Makes a function that calls out over the network a client of the
 * method and path that call states.
 *
 * A pack declares the requests its library sends with `@suss/recognize`,
 * and this module hands every call in each function body to those hooks,
 * with the ops over the run's facts. Each request a hook finds makes the
 * enclosing function a client of that method and path, so a function
 * that makes two calls gets two units. A call at module level has no
 * function to belong to, so it is skipped. A URL that says nothing about
 * where it goes makes its function a client with no path, which pairs
 * with nothing. What the caller does with the response is read off the
 * function's body here.
 */

import { restBinding, statusMembersOf, testsStatus } from "@suss/behavioral-ir";
import { runPackHook } from "@suss/extractor";
import { factCallOps } from "@suss/recognize/ops";

import { children, field, isFunction, rangeOf, spanOf } from "./ast.js";
import { packRequestHooks } from "./declaredClients.js";
import { factSourceOf } from "./factSource.js";
import { nodeId } from "./facts/values.js";
import { claimsNamedAfter } from "./lambdaClaims.js";
import { bodyTerminals, enumerateBodyBranches } from "./paths/bodyBranches.js";
import {
  bodyCalls,
  expressionInvocationEffects,
  invocationSites,
  ownBodyCalls,
} from "./paths/effects.js";
import { predicateOf } from "./paths/predicates.js";
import { raisesIn } from "./paths/raisedResponses.js";
import {
  type HandOffOptions,
  throughResponseHelpers,
} from "./responseHandOff.js";
import { moduleOf } from "./values/evaluator.js";
import { originOf } from "./values/origin.js";

import type { StatusMembers } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  ClientResponse,
  PackTally,
  RawBranch,
  RawCodeStructure,
  RawEffect,
  RequestClaim,
  RequestRecognizer,
} from "@suss/extractor";
import type { PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { TerminalBranch } from "./paths/bodyBranches.js";
import type { ModuleBinding } from "./scope.js";

export interface ClientCallOptions {
  filePath: string;
  /** The path the facts key this file's nodes under, when it differs from `filePath`. */
  factsPath?: string | undefined;
  facts?: Database | undefined;
  /** Each pack's tally, which a hook that throws is charged to. */
  tallies?: ReadonlyMap<string, PackTally> | undefined;
}

/** One pack's request hooks, each with the units it found so far. */
interface Requesting {
  readonly pack: PythonPack;
  readonly hooks: readonly {
    readonly hook: RequestRecognizer;
    readonly units: RawCodeStructure[];
  }[];
}

/**
 * One unit per request a function in this file makes. A request in a
 * lambda a pack claims is made by that lambda, so the lambda is the
 * client, under the name its own unit has. Each hook's units come
 * together, in pack order, with each in the order the file writes it.
 */
export function clientCallUnits(
  root: PyNode,
  packs: readonly PythonPack[],
  options: ClientCallOptions,
): RawCodeStructure[] {
  const { facts } = options;
  const requesting: Requesting[] = packs.flatMap((pack) => {
    const hooks = packRequestHooks(pack);
    return hooks.length === 0
      ? []
      : [{ pack, hooks: hooks.map((hook) => ({ hook, units: [] })) }];
  });
  if (facts === undefined || requesting.length === 0) {
    return [];
  }
  const source = factSourceOf(facts);
  const factsPath = options.factsPath ?? options.filePath;
  const requestsBy = (caller: PyNode, name: string, calls: PyNode[]) => {
    for (const call of calls) {
      const ops = factCallOps(nodeId(factsPath, call), source);
      if (ops === null) {
        continue;
      }
      for (const { pack, hooks } of requesting) {
        for (const { hook, units } of hooks) {
          for (const claim of claimsAt(hook, call, ops, pack, options)) {
            units.push(
              clientUnit(caller, name, { claim, call }, hook.response, pack, {
                ...options,
                facts,
              }),
            );
          }
        }
      }
    }
  };
  for (const definition of functionDefinitions(root)) {
    const name = field(definition, "name")?.text;
    if (name === undefined) {
      continue;
    }
    requestsBy(definition, name, bodyCalls(definition, facts));
    for (const claim of claimsNamedAfter(definition, name, facts)) {
      requestsBy(claim.lambda, claim.name, ownBodyCalls(claim.lambda, facts));
    }
  }
  return requesting.flatMap(({ hooks }) => hooks.flatMap(({ units }) => units));
}

/** The requests one hook reads at the call. A hook that throws is charged to its pack, and the call makes none. */
function claimsAt(
  hook: RequestRecognizer,
  call: PyNode,
  ops: NonNullable<ReturnType<typeof factCallOps>>,
  pack: PythonPack,
  options: ClientCallOptions,
): readonly RequestClaim[] {
  return (
    runPackHook(
      options.tallies?.get(pack.name),
      {
        pack: pack.name,
        hook: "requestRecognizers",
        file: options.filePath,
        line: rangeOf(call).start,
      },
      () => hook(call, { ops }),
      null,
    ) ?? []
  );
}

/**
 * Every receiver in this file's functions whose origin the request hooks
 * may ask about. A caller settles what each was written as in one round
 * before reading any, because each round runs over the whole project's
 * facts. The receivers do not depend on the pack, so one walk covers
 * every pack in the run.
 */
export function clientCallReceivers(
  root: PyNode,
  module: ModuleBinding,
): PyNode[] {
  const found: PyNode[] = [];
  for (const definition of functionDefinitions(root)) {
    // Without facts the walk keeps a claimed lambda's requests, which its
    // own client unit asks about, and runs no pack's hook this early.
    for (const call of bodyCalls(definition, undefined)) {
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
  // A lambda is one expression, so it takes one path and has no
  // statement to test a status in.
  if (definition.type === "lambda") {
    return [
      handsBack(
        range,
        expressionInvocationEffects(
          ownBodyCalls(definition, reading.facts),
          reading.facts,
        ),
      ),
    ];
  }
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
    effects: sites,
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
  statusMembers: StatusMembers;
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
function responseAccessors(response: ClientResponse): {
  bodyAccessors?: string[];
  statusAccessors?: string[];
  successAccessors?: string[];
  failureDelivery?: "response" | "exception";
  redirectDelivery?: "followed" | "response";
} {
  return {
    ...(response.body === undefined
      ? {}
      : { bodyAccessors: [...response.body] }),
    ...(response.statusCode === undefined
      ? {}
      : { statusAccessors: [...response.statusCode] }),
    ...(response.success === undefined
      ? {}
      : { successAccessors: [...response.success] }),
    ...(response.failureDelivery === undefined
      ? {}
      : { failureDelivery: response.failureDelivery }),
    ...(response.redirectDelivery === undefined
      ? {}
      : { redirectDelivery: response.redirectDelivery }),
  };
}

/** One request a hook found, and the call that makes it. */
interface FoundRequest {
  readonly claim: RequestClaim;
  readonly call: PyNode;
}

/** The unit for the function the call is written in. */
function clientUnit(
  definition: PyNode,
  name: string,
  request: FoundRequest,
  response: ClientResponse,
  pack: PythonPack,
  options: ClientCallOptions & { facts: Database },
): RawCodeStructure {
  const range = rangeOf(definition);
  const accessors = responseAccessors(response);
  const statusMembers = statusMembersOf(accessors);
  const reading: CallerReading = {
    facts: options.facts,
    statusMembers,
    handOff: {
      request: request.call,
      bodyMethods: accessors.bodyAccessors ?? [],
      facts: options.facts,
      readHelper: (helper) =>
        callerBranches(helper, { facts: options.facts, statusMembers }),
    },
  };
  const { claim } = request;
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
      method: claim.method,
      path: claim.path,
      host: claim.host,
      recognition: pack.name,
    }),
    parameters: [],
    branches: callerBranches(definition, reading),
    ...accessors,
    ...(claim.redirectDelivery === undefined
      ? {}
      : { redirectDelivery: claim.redirectDelivery }),
    bodyContent: "statements",
    dependencyCalls: [],
    declaredContract: null,
  };
}
