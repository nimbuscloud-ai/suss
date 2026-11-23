/**
 * Finds methods that call out over the network. Each becomes a client of
 * the boundary its call reaches.
 *
 * A pack declares the requests its library sends with `@suss/recognize`,
 * and this module hands every call in each method body to those hooks,
 * with the ops over the run's facts. Each request a hook finds makes the
 * enclosing method a client of that method and path, so a method that
 * makes two calls gets two units. A call at the top level of a file has
 * no unit to belong to. A URL that says nothing about where it goes
 * gives a client with no path. What the caller does with the response is
 * read off the method's body here.
 */

import { restBinding, statusMembersOf, testsStatus } from "@suss/behavioral-ir";
import {
  requestBindingFrom,
  runPackHook,
  sharedGatingConditions,
} from "@suss/extractor";
import { factCallOps } from "@suss/recognize/ops";
import { writtenLiteralOf } from "@suss/values";

import { children, field, rangeOf, spanOf } from "./ast.js";
import { callsUnder, claimedIn, claimsNamedAfter } from "./claims.js";
import { factSourceOf } from "./factSource.js";
import { nodeId } from "./facts/values.js";
import { invocationSites, pathsToCall } from "./paths/effects.js";
import { operandsOf, predicateOf } from "./paths/predicates.js";
import {
  askSourcesOfValues,
  guardInputs,
  sourcesOfValues,
} from "./provenance.js";
import { positionalParameters } from "./reach/closure.js";
import {
  type HandOffOptions,
  raiseEndings,
  throughResponseHelpers,
} from "./responseHandOff.js";
import { type ResponseReads, withResponseReads } from "./responseReads.js";
import { returnPathBranches } from "./responseStatus.js";
import {
  askWrittenValues,
  evaluatedValue,
  parameterDefaults,
} from "./values/evaluator.js";

import type { StatusMembers } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  CallOps,
  ClientResponse,
  ConditionInfo,
  PackTally,
  RawBranch,
  RawCodeStructure,
  RawCondition,
  RawEffect,
  RequestClaim,
  RequestRecognizer,
  ValueOps,
} from "@suss/extractor";
import type { Range } from "./ast.js";
import type { RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";

export interface ClientCallOptions {
  filePath: string;
  /** The path the facts key this file's nodes under, when it differs from `filePath`. */
  factsPath?: string | undefined;
  facts?: Database | undefined;
  /** Each pack's tally, which a hook that throws is charged to. */
  tallies?: ReadonlyMap<string, PackTally> | undefined;
}

/** One pack's request hooks, with the units its hooks found so far. */
interface Requesting {
  readonly pack: RubyPack;
  readonly hooks: readonly RequestRecognizer[];
  readonly units: FoundUnit[];
}

/**
 * One unit per request a method in this file makes. A request in a
 * block a pack claims is made by that block, so the block is the
 * client, under the name its own unit has. Each pack's units come
 * together, in pack order, with each in the order the file writes it.
 */
export function clientCallUnits(
  root: RbNode,
  packs: readonly RubyPack[],
  options: ClientCallOptions,
): RawCodeStructure[] {
  const { facts } = options;
  const requesting: Requesting[] = packs.flatMap((pack) => {
    const hooks = pack.requestRecognizers ?? [];
    return hooks.length === 0 ? [] : [{ pack, hooks, units: [] }];
  });
  if (facts === undefined || requesting.length === 0) {
    return [];
  }
  const source = factSourceOf(facts);
  const factsPath = options.factsPath ?? options.filePath;
  const requestsBy = (caller: RbNode, name: string, calls: RbNode[]) => {
    for (const call of calls) {
      const ops = factCallOps(nodeId(factsPath, call), source);
      if (ops === null) {
        continue;
      }
      for (const { pack, hooks, units } of requesting) {
        for (const hook of hooks) {
          for (const claim of claimsAt(hook, call, ops, pack, options)) {
            units.push({
              caller,
              name,
              request: { claim, call },
              response: hook.response,
              pack,
            });
          }
        }
      }
    }
  };
  for (const method of methodDefinitions(root)) {
    const name = field(method, "name")?.text;
    if (name === undefined) {
      continue;
    }
    const claimed = claimedIn(method, facts);
    requestsBy(method, name, callsUnder(method, claimed));
    for (const claim of claimsNamedAfter(method, name, facts)) {
      requestsBy(claim.node, claim.name, callsUnder(claim.node, claimed));
    }
  }
  const found = requesting.flatMap(({ units }) => units);
  askRequestSources(
    found.flatMap((one) =>
      takesParameters(one.caller)
        ? [
            {
              unit: one.caller,
              call: one.request.call,
              claim: one.request.claim,
            },
          ]
        : [],
    ),
    facts,
  );
  return found.map((one) =>
    clientUnit(one.caller, one.name, one.request, one.response, one.pack, {
      ...options,
      facts,
    }),
  );
}

/** A request a hook found, before its unit is built. */
interface FoundUnit {
  readonly caller: RbNode;
  readonly name: string;
  readonly request: FoundRequest;
  readonly response: ClientResponse;
  readonly pack: RubyPack;
}

/** Only a method with parameters can take its request's method or host from one. */
function takesParameters(method: RbNode): boolean {
  return positionalParameters(method).length > 0;
}

/**
 * Asks where every request's values and the subjects of its conditions
 * came from, in one question each, so building each unit finds them
 * settled.
 */
function askRequestSources(
  requests: ReadonlyArray<{ unit: RbNode; call: RbNode; claim: RequestClaim }>,
  facts: Database,
): void {
  const stated = requests.flatMap(({ claim }) =>
    [claim.read.stated?.method, claim.read.stated?.host?.value].filter(
      (value): value is ValueOps => value !== undefined,
    ),
  );
  const operands = requests.flatMap(({ unit, call }) =>
    gateOperands(pathsToCall(unit, call, facts) ?? []),
  );
  askSourcesOfValues(stated, operands, facts);
}

function gateOperands(
  paths: readonly (readonly ConditionInfo<RbNode>[])[],
): RbNode[] {
  return paths.flatMap((path) =>
    path.flatMap((condition) =>
      condition.expression === null ? [] : operandsOf(condition.expression),
    ),
  );
}

/** The requests one hook reads at the call. A hook that throws is charged to its pack, and the call makes none. */
function claimsAt(
  hook: RequestRecognizer,
  call: RbNode,
  ops: CallOps,
  pack: RubyPack,
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
 * Settles what the receivers of this file's calls were written as,
 * before any request is read. Each question runs the rules again, so
 * asking per call site is slow on a large project, and a receiver's
 * origin is read off what it was written as.
 */
export function askClientCallReads(
  root: RbNode,
  facts: Database | undefined,
): void {
  if (facts === undefined) {
    return;
  }
  const receivers: RbNode[] = [];
  for (const method of methodDefinitions(root)) {
    // A request in a claimed block is read for the block's own unit.
    for (const call of callsUnder(method, undefined)) {
      const receiver = field(call, "receiver");
      if (receiver !== null) {
        receivers.push(receiver);
      }
    }
  }
  askWrittenValues(receivers, facts);
}

/** Every method this file defines, in a class or outside one. */
function methodDefinitions(node: RbNode, found: RbNode[] = []): RbNode[] {
  for (const child of children(node)) {
    if (child.type === "method" || child.type === "singleton_method") {
      found.push(child);
    }
    methodDefinitions(child, found);
  }
  return found;
}

/** One request a hook found, and the call that makes it. */
interface FoundRequest {
  readonly claim: RequestClaim;
  readonly call: RbNode;
}

/** The unit for the method the call is written in. */
function clientUnit(
  method: RbNode,
  name: string,
  request: FoundRequest,
  response: ClientResponse,
  pack: RubyPack,
  options: ClientCallOptions & { facts: Database },
): RawCodeStructure {
  const range = rangeOf(method);
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
    reads: {
      request: request.call,
      bodyMembers: accessors.bodyAccessors ?? [],
      statusMembers,
      facts: options.facts,
    },
  };
  const { claim } = request;
  const bindingFrom = takesParameters(method)
    ? requestBindingFrom(
        claim.read.stated,
        requestGate(method, request.call, options.facts),
        sourcesOfValues({ facts: options.facts, unit: method }),
      )
    : undefined;
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
      method: claim.method,
      path: claim.path,
      host: claim.host,
      recognition: pack.name,
    }),
    // `bindingFrom` points at parameters by name, so the unit lists them.
    ...(bindingFrom === undefined
      ? { parameters: [] }
      : {
          bindingFrom,
          parameters: positionalParameters(
            method,
            parameterDefaults(method, options.facts),
          ),
        }),
    branches: callerBranches(method, reading),
    ...accessors,
    ...(claim.redirectDelivery === undefined
      ? {}
      : { redirectDelivery: claim.redirectDelivery }),
    bodyContent: "statements",
    dependencyCalls: [],
    declaredContract: null,
  };
}

/**
 * One branch per path the caller takes after the call, so a test it
 * writes on the response says which statuses it handles. Each arm of a
 * test on a status member stays a branch of its own, even when neither
 * arm returns.
 */
/**
 * The conditions every path to the request passes, with a subject that
 * is a parameter read as that input and a written value read as the
 * literal it comes to, `:post` included, so a caller's argument can
 * settle them.
 */
function requestGate(
  method: RbNode,
  call: RbNode,
  facts: Database,
): RawCondition[] {
  const paths = pathsToCall(method, call, facts) ?? [];
  const operands = gateOperands(paths);
  if (operands.length === 0) {
    return sharedGatingConditions(paths);
  }
  const read = new Map(guardInputs(operands, { facts, unit: method }));
  for (const operand of operands) {
    // Read without the facts, which a literal does not need.
    const literal = writtenLiteralOf(evaluatedValue(operand));
    if (!read.has(operand.id) && literal !== undefined) {
      read.set(operand.id, { type: "literal", value: literal });
    }
  }
  return sharedGatingConditions(paths, (condition) =>
    predicateOf(condition, read),
  );
}

function callerBranches(method: RbNode, reading: CallerReading): RawBranch[] {
  const sites = invocationSites(method, undefined, undefined, reading.facts);
  const effects = sites.map((site) => site.effect);
  const keepsArms = (condition: RbNode): boolean =>
    testsStatus(predicateOf(condition), reading.statusMembers);
  const paths = returnPathBranches(
    method,
    sites,
    [],
    reading.facts,
    keepsArms,
    raiseEndings(method, reading.facts),
  ) ?? [returnBranch(rangeOf(method), effects)];
  const found =
    reading.reads === undefined
      ? paths
      : withResponseReads(paths, method, reading.reads);
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
  /** Unset for a helper, which reads what it was handed rather than the response. */
  reads?: ResponseReads;
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

function returnBranch(
  range: Range,
  effects: RawEffect[],
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
