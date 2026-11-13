/**
 * The runtime's timers, declared as `callbacks` chains: `setImmediate`,
 * `setTimeout`, `setInterval` and `queueMicrotask` as globals or
 * imported from Node's `timers` module under any name, and
 * `process.nextTick`.
 *
 * Each call records a `schedule` effect. A callback written in place
 * becomes a `scheduled-callback` unit of its own, named for the call
 * that scheduled it. A name the program binds itself is not the
 * runtime's timer, and `node:timers/promises` takes no callback, so
 * neither matches. The README has the spellings.
 */

import { callbacks, constructedFrom, global } from "@suss/recognize";

import type {
  CallbackMethod,
  ClaimMetadata,
  ScheduleUnread,
  SubUnitNamePart,
} from "@suss/recognize";

/** A timer that waits or repeats takes its delay after the callback. */
const WAITS: CallbackMethod = {
  callback: { written: "argument", at: 0 },
  delay: { at: 1 },
};

/** A timer that runs its callback as soon as it can takes no delay. */
const SOON: CallbackMethod = { callback: { written: "argument", at: 0 } };

const UNREAD: ScheduleUnread = {
  missing: "missing-callback-argument",
  other: "non-literal-callback",
};

const TIMERS: Readonly<Record<string, CallbackMethod>> = {
  setImmediate: SOON,
  setTimeout: WAITS,
  setInterval: WAITS,
  queueMicrotask: SOON,
};

/**
 * A callback written in place runs later, so it is a unit of its own,
 * named for the call that scheduled it, with the callee recorded as the
 * primitive that did.
 */
const CLAIM: {
  kind: "scheduled-callback";
  name: readonly SubUnitNamePart[];
  metadata: ClaimMetadata;
} = {
  kind: "scheduled-callback",
  name: ["parent", "callee", "countPerCallee"],
  metadata: { node: { schedulingPrimitive: { reads: "callee" } } },
};

const GLOBAL_TIMERS = callbacks({ client: global(...Object.keys(TIMERS)) })
  .methods(TIMERS)
  .schedules({ via: "asWritten", unread: UNREAD })
  .unitWhenInPlace(CLAIM)
  .example("setTimeout(() => flush(), 1000)");

/** The same timers imported from Node's `timers` module, under any name. */
const IMPORTED_TIMERS = callbacks({
  client: constructedFrom({
    from: ["timers", "node:timers"],
    named: Object.keys(TIMERS),
  }),
})
  .methods(TIMERS)
  .schedules({ via: "asWritten", unread: UNREAD })
  .unitWhenInPlace(CLAIM)
  .example("nodeSetTimeout(() => flush(), 5)");

const NEXT_TICK = callbacks({ client: global("process") })
  .methods({ nextTick: SOON })
  .schedules({ via: "asWritten", unread: UNREAD })
  .unitWhenInPlace(CLAIM)
  .example("process.nextTick(() => flush())");

/** The timer chains, in the order a call is tried against them. */
export const TIMER_MATCHES = [GLOBAL_TIMERS, IMPORTED_TIMERS, NEXT_TICK];
