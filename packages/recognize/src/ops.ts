/**
 * The small builders a pack writes its origins with, and the vocabulary
 * they produce.
 *
 * The types live in `@suss/extractor` because an adapter implements them
 * and never calls any of this. They are re-exported here so a pack
 * author has one import.
 */

export type {
  AstCapableOps,
  CallOps,
  ConstructedFrom,
  DeclaredBy,
  OpsCarrier,
  ReceiverOrigin,
  UnsettledName,
  ValueEntry,
  ValueOps,
} from "@suss/extractor";

import type {
  CallOps,
  ConstructedFrom,
  DeclaredBy,
  OpsCarrier,
} from "@suss/extractor";

/**
 * A receiver whose method one of these modules declared. Pass every
 * module that ships the same client, the way three packages all speak
 * one wire protocol.
 */
export function declaredBy(...importedFrom: readonly string[]): DeclaredBy {
  return { origin: "declaredBy", importedFrom };
}

/** A client made from one of these modules' exports. */
export function constructedFrom(
  ...importedFrom: readonly string[]
): ConstructedFrom;
/** A client made from named exports of those modules. */
export function constructedFrom(spec: {
  from: readonly string[];
  named: readonly string[];
}): ConstructedFrom;
export function constructedFrom(
  ...args:
    | readonly string[]
    | [{ from: readonly string[]; named: readonly string[] }]
): ConstructedFrom {
  const [first] = args;
  if (typeof first === "object") {
    return {
      origin: "constructed",
      importedFrom: first.from,
      named: first.named,
    };
  }
  return { origin: "constructed", importedFrom: args as readonly string[] };
}

/** The ops in a recognizer context, or null when the adapter has none. */
export function opsIn(ctx: unknown): CallOps | null {
  const carrier = ctx as OpsCarrier | null | undefined;
  return carrier?.ops ?? null;
}
