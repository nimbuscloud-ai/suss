/**
 * Naming the calls a walk stops at.
 *
 * An adapter follows a call by resolving its callee to a function with
 * a body. When that fails the edge is dropped, and a unit whose body is
 * full of dropped edges produces the same empty summary as a unit that
 * does nothing. The reasons here say which kind of stop a call site
 * is, and which kinds are worth leaving a gap for, in words every
 * adapter shares. How a stop is classified is each language's own
 * business and stays in its adapter.
 */

import type { Gap } from "./index.js";

/**
 * Why the walk stopped.
 *
 * `noBody` states a shape and nothing else, an interface method say.
 * `unsettledValue` is declared as something other than a function,
 * with something in it that could not be read. `multipleSources`
 * reaches two different functions, so no single body can be followed.
 * `outsideRun` is a declaration in a dependency, whose source this run
 * never read. `noDeclaration` is a callee nothing declares.
 * `callerSupplied` is a parameter of the function being scanned, so the
 * call runs whatever its caller handed in. `multipleReceivers` is a
 * registration whose receiver comes down to more than one thing, and
 * `unresolvedWrapper` one whose function the run could not settle on.
 */
export type UnfollowedReason =
  | "noBody"
  | "unsettledValue"
  | "multipleSources"
  | "outsideRun"
  | "noDeclaration"
  | "callerSupplied"
  | "multipleReceivers"
  | "unboundParameter"
  | "unresolvedWrapper";

/** One call the walk met and could not follow. */
export interface UnfollowedCall {
  /** The callee as the source writes it, `this.dao.getEditions` say. */
  readonly callee: string;
  readonly reason: UnfollowedReason;
  /** How many things the walk reached where it needed one. */
  readonly candidates?: number;
}

/**
 * Whether a stop of this kind leaves a gap. The three that are left out
 * fail the same test: nothing about any of them says the callee is code
 * the project owns, so a gap on them buys volume rather than a place to
 * look. The run already describes a call into a dependency, as a
 * boundary crossing; a call on an untyped value could go anywhere; and a
 * call on a parameter runs whichever function each caller passes.
 */
const RECORDED: Record<UnfollowedReason, boolean> = {
  noBody: true,
  unsettledValue: true,
  multipleSources: true,
  outsideRun: false,
  noDeclaration: false,
  callerSupplied: false,
  multipleReceivers: true,
  unboundParameter: true,
  unresolvedWrapper: true,
};

export function worthRecording(reason: UnfollowedReason): boolean {
  return RECORDED[reason];
}

const STOP_SENTENCE: Record<
  UnfollowedReason,
  (stop: UnfollowedCall) => string
> = {
  noBody: ({ callee }) =>
    `The call to ${callee} lands on a declaration with no body, so whatever runs there is missing from this summary`,
  unsettledValue: ({ callee }) =>
    `The call to ${callee} goes through a value this run could not settle, so whatever runs there is missing from this summary`,
  multipleSources: ({ callee }) =>
    `The call to ${callee} reaches a value with more than one possible source, so whatever runs there is missing from this summary`,
  outsideRun: ({ callee }) =>
    `The call to ${callee} lands in a package whose source is not in this run, so whatever runs there is missing from this summary`,
  noDeclaration: ({ callee }) =>
    `The call to ${callee} has no declaration this run could find, so whatever runs there is missing from this summary`,
  callerSupplied: ({ callee }) =>
    `The call to ${callee} runs the function this unit's caller passed in, so what happens there is decided at the call site`,
  multipleReceivers: ({ callee, candidates }) =>
    `The call to ${callee} is made on a receiver this run reads as ${candidates ?? "several"} different values, so nothing says which one it registers on and the registration is left out`,
  unboundParameter: ({ callee }) =>
    `The call to ${callee} runs through a parameter, and no caller in this run passes it a function by name, so whatever runs there is missing from this summary`,
  unresolvedWrapper: ({ callee }) =>
    `The call to ${callee} registers middleware this run could not follow to one function, so whatever it does around this route is missing from this summary`,
};

export function unfollowedCallGap(stop: UnfollowedCall): Gap {
  return {
    type: "unfollowedCall",
    conditions: [],
    consequence: "unknown",
    description: STOP_SENTENCE[stop.reason](stop),
    callee: stop.callee,
  };
}
