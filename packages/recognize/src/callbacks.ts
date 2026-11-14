/**
 * A pack that recognizes a call handing a callback to a library that
 * runs it later, such as a query hook or a timer:
 *
 *   useQuery({ queryKey: ["orders"], queryFn: fetchOrders })
 *
 * The pack says which methods take a callback and where each one states
 * it. The effect records which function runs, and a function written in
 * place can become a unit of its own, so what it does goes on its own
 * summary.
 */

import { chainStart } from "./chain.js";

import type { CodeUnitKind } from "@suss/behavioral-ir";
import type {
  CallbackMethod,
  Chain,
  ClaimMetadata,
  Link,
  ScheduleEnding,
  ScheduleUnread,
  SubUnitNamePart,
} from "./chain.js";
import type { ReceiverOrigin } from "./ops.js";

export interface CallbacksSpec {
  /** How the pack pins down the library the calls go to. */
  client?: ReceiverOrigin;
}

/** A chain over calls that take a callback, and the links that can still be added. */
export interface Callbacks {
  /** Which methods take a callback, and where each one states it. */
  methods(
    table: Readonly<Record<string, CallbackMethod>>,
    options?: { ignoringCase?: boolean },
  ): Callbacks;
  /**
   * What the effect records: the callee as the source writes it as
   * `via`, and the reasons it gives when the run cannot tell which
   * function the call runs.
   */
  schedules(spec: { via: "asWritten"; unread: ScheduleUnread }): Callbacks;
  /**
   * What a callback the call writes in place becomes: a unit of this
   * kind, named from these parts, whose summary records the metadata.
   */
  unitWhenInPlace(spec: {
    kind: CodeUnitKind;
    name: readonly SubUnitNamePart[];
    metadata?: ClaimMetadata;
  }): Callbacks;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): Callbacks;
  /** The links and the ending, as data. */
  readonly declared: Chain<CallbackMethod>;
}

/** Until a pack says otherwise, the reasons are the library-neutral ones. */
const UNREAD: ScheduleUnread = {
  missing: "missing-callback",
  other: "non-literal-callback",
};

/** A pack that recognizes calls taking a callback. */
export function callbacks(spec: CallbacksSpec): Callbacks {
  const ending: ScheduleEnding = {
    yields: "schedule",
    via: "asWritten",
    unread: UNREAD,
  };
  return chainFrom({
    links: chainStart(spec.client),
    ending,
    example: null,
  });
}

/** The same chain with one more link, or with its ending or example set. */
function chainFrom(declared: Chain<CallbackMethod>): Callbacks {
  const adding = (link: Link<CallbackMethod>): Callbacks =>
    chainFrom({ ...declared, links: [...declared.links, link] });

  return {
    declared,
    methods: (table, options) =>
      adding({
        asks: "methods",
        table,
        ignoringCase: options?.ignoringCase ?? false,
      }),
    schedules: ({ via, unread }) =>
      chainFrom({
        ...declared,
        ending: { yields: "schedule", via, unread },
      }),
    unitWhenInPlace: ({ kind, name, metadata }) =>
      adding({
        asks: "unitWhenInPlace",
        kind,
        name,
        ...(metadata === undefined ? {} : { metadata }),
      }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
