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
  Global,
  HandedBy,
  Imported,
  Inheriting,
  Inherits,
  OpsCarrier,
  ReceiverOrigin,
  ReturnedBy,
  Typed,
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
  Global,
  HandedBy,
  Imported,
  Inheriting,
  Inherits,
  OpsCarrier,
  ReceiverOrigin,
  ReturnedBy,
  Typed,
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

/**
 * A receiver the program declares as one of these modules' named types,
 * or as any type the modules declare when `named` is left out.
 */
export function typed(spec: {
  from: readonly string[];
  named?: readonly string[];
}): Typed {
  return {
    origin: "typed",
    importedFrom: spec.from,
    ...(spec.named === undefined ? {} : { named: spec.named }),
  };
}

/** A receiver that is one of a class whose ancestry reaches the base the spec lists. */
export function inherits(spec: Inherits): Inheriting {
  return { origin: "inherits", from: spec.from, named: spec.named };
}

/**
 * A receiver `method`, called on a receiver from `on`, hands its
 * callback as the parameter at `parameter`, as `$transaction` hands its
 * callback a client.
 */
export function handedBy(
  method: string,
  on: ReceiverOrigin,
  spec: { parameter: number },
): HandedBy {
  return { origin: "handedBy", method, on, parameter: spec.parameter };
}

/**
 * A value the file imported from one of these modules, under one of the
 * names in `named` when it is given. `*` is the module itself.
 */
export function imported(spec: {
  from: readonly string[];
  named?: readonly string[];
}): Imported {
  return {
    origin: "imported",
    importedFrom: spec.from,
    ...(spec.named === undefined ? {} : { named: spec.named }),
  };
}

/**
 * A receiver, or a call with no receiver, spelled as one of these paths:
 * `global("console")`, `global("print")`. A program spells the runtime's
 * own objects without importing them, so a chain that starts here gates
 * on no module.
 */
export function global(...paths: readonly string[]): Global {
  return { origin: "global", paths };
}

const MODULES: ByOrigin<readonly string[]> = {
  declaredBy: (origin) => origin.importedFrom,
  constructed: (origin) => origin.importedFrom,
  anyOf: (origin) => origin.of.flatMap((one) => modulesOf(one)),
  returnedBy: (origin) => modulesOf(origin.on),
  typed: (origin) => origin.importedFrom,
  inherits: (origin) => origin.from,
  handedBy: (origin) => modulesOf(origin.on),
  imported: (origin) => origin.importedFrom,
  global: () => [],
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
