/**
 * The small builders a pack writes its origins with, and the vocabulary
 * they produce.
 *
 * The types live in `@suss/extractor` because an adapter implements them
 * and never calls any of this. They are re-exported here so a pack
 * author has one import.
 */

export type {
  AnyOf,
  AstCapableOps,
  CallOps,
  ClassOps,
  ConstructedFrom,
  DeclaredBy,
  OpsCarrier,
  ReceiverOrigin,
  ReturnedBy,
  UnsettledName,
  ValueEntry,
  ValueOps,
} from "@suss/extractor";

import { byOrigin } from "@suss/extractor";

import type {
  AnyOf,
  ByOrigin,
  CallOps,
  ConstructedFrom,
  DeclaredBy,
  OpsCarrier,
  ReceiverOrigin,
  ReturnedBy,
} from "@suss/extractor";

/**
 * A receiver whose method one of these modules declared. Pass every
 * module that ships the same client, for example several packages that
 * implement one wire protocol.
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

/** A receiver any one of these origins accepts, such as a client a program makes itself or gets from another client. */
export function anyOf(...of: readonly ReceiverOrigin[]): AnyOf {
  return { origin: "anyOf", of };
}

/** A receiver `method` returned, called on a receiver from `on`. */
export function returnedBy(method: string, on: ReceiverOrigin): ReturnedBy {
  return { origin: "returnedBy", method, on };
}

const MODULES: ByOrigin<readonly string[]> = {
  declaredBy: (origin) => origin.importedFrom,
  constructed: (origin) => origin.importedFrom,
  anyOf: (origin) => origin.of.flatMap((one) => modulesOf(one)),
  returnedBy: (origin) => modulesOf(origin.on),
};

/** Every module an origin mentions, which a file has to import before it can match. */
export function modulesOf(origin: ReceiverOrigin): readonly string[] {
  return byOrigin(MODULES, origin);
}

/** The ops in a recognizer context, or null when the adapter has none. */
export function opsIn(ctx: unknown): CallOps | null {
  const carrier = ctx as OpsCarrier | null | undefined;
  return carrier?.ops ?? null;
}
