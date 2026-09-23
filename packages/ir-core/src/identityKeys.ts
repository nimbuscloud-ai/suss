// Builders for the identity-key strings. Each key type is branded, so
// a hand-written literal fails to compile and a key missing its prefix
// cannot be built (#155, #167).

import type { DeployableUnit } from "./deployableUnit.js";
import type { MessageBusSemantics } from "./semantics/messageBus.js";

declare const IdentityKeyBrand: unique symbol;

/** `gql:Type.field`, the boundary key both GraphQL sides pair on. */
export type GqlIdentityKey = `gql:${string}.${string}` & {
  readonly [IdentityKeyBrand]: "gql";
};

export function gqlIdentityKey(
  typeName: string,
  fieldName: string,
): GqlIdentityKey {
  return `gql:${typeName}.${fieldName}` as GqlIdentityKey;
}

/** `fn:package::export.path`, the key a package-export boundary pairs on. */
export type FnIdentityKey = `fn:${string}::${string}` & {
  readonly [IdentityKeyBrand]: "fn";
};

export function fnIdentityKey(
  packageName: string,
  exportPath: readonly string[],
): FnIdentityKey {
  return `fn:${packageName}::${exportPath.join(".")}` as FnIdentityKey;
}

/** `bus:technology subject`, where the technology is one the message-bus schema allows. */
export type BusIdentityKey =
  `bus:${MessageBusSemantics["messageBus"]} ${string}` & {
    readonly [IdentityKeyBrand]: "bus";
  };

export function busIdentityKey(
  messageBus: MessageBusSemantics["messageBus"],
  subject: string,
): BusIdentityKey {
  return `bus:${messageBus} ${subject}` as BusIdentityKey;
}

/**
 * `unit:platform name`, the key an invoker and the unit it invokes pair
 * on. The platform stays in because two clouds can each deploy
 * something called `Worker` and they are not the same thing.
 */
export type UnitIdentityKey =
  `unit:${DeployableUnit["deploymentTarget"]} ${string}` & {
    readonly [IdentityKeyBrand]: "unit";
  };

export function unitIdentityKey(
  deploymentTarget: DeployableUnit["deploymentTarget"],
  instanceName: string,
): UnitIdentityKey {
  return `unit:${deploymentTarget} ${instanceName}` as UnitIdentityKey;
}

/** `metric:system type`, the key both sides of a metric pair on. */
export type MetricIdentityKey = `metric:${string} ${string}` & {
  readonly [IdentityKeyBrand]: "metric";
};

export function metricIdentityKey(
  metricSystem: string,
  metricType: string,
): MetricIdentityKey {
  return `metric:${metricSystem} ${metricType}` as MetricIdentityKey;
}
