/**
 * Named reasons for the calls a walk stops at.
 *
 * An adapter follows a call by resolving its callee to a function with
 * a body. When that fails the edge is dropped, and a unit whose body is
 * full of dropped edges produces the same empty summary as a unit that
 * does nothing. The reasons here give each kind of stop a name every
 * adapter shares, and say which kinds leave a gap in the summary. Each
 * adapter classifies stops in its own language.
 */

import type { Gap } from "./index.js";

/**
 * Why the walk stopped.
 *
 * `noBody`: a declaration without a body, such as an interface method.
 * `unsettledValue`: a value declared as something other than a function, with a part that could not be read.
 * `multipleSources`: the callee reaches two functions, so no single body can be followed.
 * `outsideRun`: declared in a dependency this run never read.
 * `noDeclaration`: nothing declares the callee.
 * `callerSupplied`: a parameter, so the call runs whatever the caller passed in.
 * `multipleReceivers`: a registration whose receiver resolves to more than one value.
 * `unboundParameter`: a parameter that no caller in the run passes a function to by name.
 * `unresolvedWrapper`: a registration whose function the run could not resolve.
 * `definedAtLoadTime`: a method the project defines while the file loads.
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
  | "unresolvedWrapper"
  | "definedAtLoadTime";

/** One call the walk met and could not follow. */
export interface UnfollowedCall {
  /** The callee as the source writes it, such as `this.dao.getEditions`. */
  readonly callee: string;
  readonly reason: UnfollowedReason;
  /** How many candidates the walk reached where it needed exactly one. */
  readonly candidates?: number;
}

/**
 * Whether a stop of this kind leaves a gap. Three kinds do not, because
 * nothing about them suggests the callee is the project's own code, and
 * a gap would add noise without pointing anywhere useful. The run
 * already describes a call into a dependency as a boundary crossing. A
 * call on an untyped value could go anywhere. A call on a parameter
 * runs whichever function each caller passes.
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
  definedAtLoadTime: true,
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
  definedAtLoadTime: ({ callee }) =>
    `The call to ${callee} lands on a method the project defines with define_method, which this reader does not follow, so whatever runs there is missing from this summary`,
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
