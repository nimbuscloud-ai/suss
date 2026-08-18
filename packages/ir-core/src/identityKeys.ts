// identityKeys.ts: the minted identity-key formats, typed so a wrong
// literal refuses to compile. The mint is the only constructor, which
// is how a dropped prefix stops shipping again (#155, #167).

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

/** `bus:technology subject`, with the technology closed off the schema. */
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
