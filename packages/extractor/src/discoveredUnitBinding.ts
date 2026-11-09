/**
 * The boundary binding a discovered unit gets from what its pack stated
 * about it: a route, a GraphQL field, a message channel, the deployed
 * unit, or nothing, in which case it is a function other code calls.
 * Every adapter builds a pack's units through these, so one unit spec
 * gives one binding in every language.
 */

import {
  functionCallBinding,
  graphqlResolverBinding,
  messageBusBinding,
  restBinding,
  unitInvocationBinding,
} from "@suss/behavioral-ir";

import type { BoundaryBinding } from "@suss/behavioral-ir";
import type { DiscoveredCustomUnit } from "./framework.js";

/** What a pack can state about the boundary a unit serves. A resolver's type is null where the source never says it. */
export interface StatedBoundary
  extends Pick<
    DiscoveredCustomUnit,
    "routeInfo" | "channelInfo" | "invocationInfo" | "functionCallInfo"
  > {
  readonly resolverInfo?: {
    readonly typeName: string | null;
    readonly fieldName: string;
    readonly transport?: string;
  };
}

/** The pack a unit is recognized under, and the protocol its bindings default to. */
export interface BindingPack {
  readonly name: string;
  readonly protocol: string;
}

/**
 * The binding for the boundary the unit states, or null when it states
 * none. A resolver field is read first, since AppSync can route a field
 * to a handler that also serves a route.
 */
export function bindingOfDiscoveredUnit(
  unit: StatedBoundary,
  pack: BindingPack,
): BoundaryBinding | null {
  if (unit.resolverInfo !== undefined) {
    return graphqlResolverBinding({
      transport: unit.resolverInfo.transport ?? pack.protocol,
      recognition: pack.name,
      typeName: unit.resolverInfo.typeName,
      fieldName: unit.resolverInfo.fieldName,
    });
  }
  if (unit.routeInfo !== undefined) {
    return restBinding({
      transport: pack.protocol,
      recognition: pack.name,
      method: unit.routeInfo.method,
      path: unit.routeInfo.path,
    });
  }
  if (unit.channelInfo !== undefined) {
    return messageBusBinding({
      recognition: pack.name,
      messageBus: unit.channelInfo.messageBus,
      channel: unit.channelInfo.channel,
    });
  }
  if (unit.invocationInfo !== undefined) {
    return unitInvocationBinding({
      recognition: pack.name,
      deploymentTarget: unit.invocationInfo.deploymentTarget,
      instanceName: unit.invocationInfo.instanceName,
    });
  }
  return null;
}

/** A unit that states no boundary is a function other code calls, keyed by its module when the pack says which. */
export function functionCallBindingOfDiscoveredUnit(
  unit: StatedBoundary,
  pack: BindingPack,
): BoundaryBinding {
  return functionCallBinding({
    transport: pack.protocol,
    recognition: pack.name,
    ...(unit.functionCallInfo !== undefined
      ? {
          module: unit.functionCallInfo.module,
          exportName: unit.functionCallInfo.exportName,
        }
      : {}),
  });
}
