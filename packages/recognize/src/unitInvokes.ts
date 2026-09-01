/**
 * unitInvokes.ts: a pack that recognizes a call invoking one deployed
 * unit by name.
 *
 * The AWS SDK shape is the one this was written against, and it is the
 * same shape a send has: an operation is a command class and its
 * arguments are one object, so the pack says which command and which of
 * its properties says which unit the call reaches.
 *
 *   client.send(new InvokeCommand({ FunctionName, Payload }))
 */

import { chainStart } from "./chain.js";

import type { DeployableUnit } from "@suss/behavioral-ir";
import type {
  Chain,
  Link,
  UnitInvokeEnding,
  UnitInvokeMethod,
} from "./chain.js";
import type { ReceiverOrigin, UnsettledName } from "./ops.js";

export interface UnitInvokesSpec {
  /** The platform running the unit, in the IR's deployable-unit words. */
  platform: DeployableUnit["deploymentTarget"];
  /** The properties the call may name the unit on, tried in order. */
  named: readonly string[];
  /** The property the call states its payload on. */
  payload?: string;
  /**
   * What a reader gives back for a name nothing settles. Defaults to
   * keeping the reference, since a function name reaches the code
   * through an env var far more often than it is written out.
   */
  unsettledName?: UnsettledName;
  /** How the pack pins down the client its calls are on. */
  client?: ReceiverOrigin;
}

/** A chain over invokes, and the links that can still be added. */
export interface UnitInvokes {
  /** Which methods invoke, and where each one states its request. */
  methods(
    table: Readonly<Record<string, UnitInvokeMethod>>,
    options?: { ignoringCase?: boolean },
  ): UnitInvokes;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): UnitInvokes;
  /** The links and the ending, as data. */
  readonly declared: Chain<UnitInvokeMethod>;
}

/** A pack that recognizes a call invoking a deployed unit. */
export function unitInvokes(spec: UnitInvokesSpec): UnitInvokes {
  const ending: UnitInvokeEnding = {
    yields: "unitInvoke",
    platform: spec.platform,
    named: spec.named,
    ...(spec.payload === undefined ? {} : { payload: spec.payload }),
    unsettledName: spec.unsettledName ?? "reference",
  };
  return chainFrom({
    links: chainStart(spec.client),
    ending,
    example: null,
  });
}

/** The same chain with one more link, or with its example set. */
function chainFrom(declared: Chain<UnitInvokeMethod>): UnitInvokes {
  const adding = (link: Link<UnitInvokeMethod>): UnitInvokes =>
    chainFrom({ ...declared, links: [...declared.links, link] });

  return {
    declared,
    methods: (table, options) =>
      adding({
        asks: "methods",
        table,
        ignoringCase: options?.ignoringCase ?? false,
      }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
