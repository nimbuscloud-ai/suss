/**
 * What a unit reads off the value it was handed, compared against what
 * the senders to it supply.
 *
 * This is one rule for every protocol. A React child reads a prop, a
 * queue consumer reads a field of a message body, an HTTP handler
 * reads a field of a request. In all three the receiver asks for a
 * path and the sender supplies a shape, and the question is whether
 * the shape has anything at that path. The protocol decides which
 * input the sender's value arrives through, and the wording.
 *
 * Both sides are partial readings, so the rule declines to compare
 * rather than guess. The README lists every such case.
 */

import type {
  BoundaryBinding,
  MessageBusTechnology,
  Semantics,
} from "@suss/ir-core";
import type { BehavioralSummary, Input, ValueRef } from "../index.js";

/** True when the sender's whole value arrives through this input. */
export type CarriesPayload = (input: Input) => boolean;

/** Why the rule declined to compare. */
export type StandDown =
  | "no-reads"
  | "rest-parameter"
  | "payload-used-whole"
  | "sender-opaque"
  | "different-object"
  | "platform-envelope"
  | "unmapped-protocol";

export interface ReadSet {
  /** Each path the receiver asked for, outermost segment first. */
  paths: string[][];
  /**
   * Whether the paths start at the value the sender wrote. A
   * destructure of an already-parsed message does. A handler
   * parameter does not as far as `readSetOf` can tell, because the
   * platform's envelope arrives in the same position; a protocol that
   * knows its envelope settles this itself.
   */
  rootedAtPayload: boolean;
}

export type ReadSetResult =
  | { read: true; reads: ReadSet }
  | { read: false; reason: StandDown };

export type ComparisonResult =
  | { compared: true; unsupplied: string[][] }
  | { compared: false; reason: StandDown };

/**
 * The paths a unit was seen asking for through its inputs, or the
 * reason that list could be short of what it really reads.
 *
 * A read through the payload input gives the path from the payload's
 * root. A read through any other named parameter gives that
 * parameter's role as the first segment, which is where a destructure
 * rename keeps the name the sender used.
 */
export function readSetOf(
  summary: BehavioralSummary,
  carriesPayload: CarriesPayload,
): ReadSetResult {
  const reads = summary.inputReads;
  if (reads === undefined || reads.length === 0) {
    return { read: false, reason: "no-reads" };
  }

  // A rest binding collects whatever the caller passed, so anything
  // could be consumed through it without a read being recorded.
  const hasRest = summary.inputs.some(
    (input) => input.type === "parameter" && input.role === "rest",
  );
  if (hasRest) {
    return { read: false, reason: "rest-parameter" };
  }

  const words = wordsFor(summary, carriesPayload);

  const paths: string[][] = [];
  let rootedAtPayload = true;
  for (const read of reads) {
    if (words.payloadInputs.has(read.input)) {
      if (read.path.length === 0) {
        // The payload is used whole somewhere, so it can be forwarded
        // and every field of it read out of sight of this summary.
        return { read: false, reason: "payload-used-whole" };
      }
      paths.push([...read.path]);
      rootedAtPayload = false;
      continue;
    }
    const role = words.roleByBinding.get(read.input);
    if (role !== undefined) {
      paths.push([role, ...read.path]);
    }
  }
  if (paths.length === 0) {
    return { read: false, reason: "no-reads" };
  }
  return { read: true, reads: { paths, rootedAtPayload } };
}

/** Which inputs the sender's value arrives through, and the sender's word for each of the rest. */
interface InputWords {
  payloadInputs: Set<string>;
  roleByBinding: Map<string, string>;
}

function wordsFor(
  summary: BehavioralSummary,
  carriesPayload: CarriesPayload,
): InputWords {
  return {
    payloadInputs: new Set(
      summary.inputs.flatMap((input) =>
        carriesPayload(input) ? [nameOf(input)] : [],
      ),
    ),
    // Reads record the binding's name; the sender's word is the role,
    // which is where a destructure rename keeps the name it was passed.
    roleByBinding: new Map(
      summary.inputs.flatMap((input) =>
        input.type === "parameter"
          ? [[input.name, input.role ?? input.name]]
          : [],
      ),
    ),
  };
}

/**
 * Which path off the unit's input a value reference points at, spelled
 * the way `readSetOf` spells a read, so a guard on a value and a read
 * of it can be compared. Null for a reference to anything but an input
 * this rule follows, and for the payload taken whole.
 */
export function readPathOf(
  summary: BehavioralSummary,
  ref: ValueRef,
  carriesPayload: CarriesPayload,
): string[] | null {
  if (ref.type !== "input") {
    return null;
  }
  const words = wordsFor(summary, carriesPayload);
  if (words.payloadInputs.has(ref.inputRef)) {
    return ref.path.length === 0 ? null : [...ref.path];
  }
  const role = words.roleByBinding.get(ref.inputRef);
  if (role === undefined) {
    return null;
  }
  return [role, ...ref.path];
}

/**
 * The paths in the read set that no sender supplies. One sender that
 * sets a field is enough, because the receiver cannot tell which of
 * them sent the value it is handling.
 */
export function compareSupplied(
  reads: ReadSet,
  supplied: readonly unknown[],
): ComparisonResult {
  // A sender whose value cannot be read into could be setting any of
  // these paths, and a finding against it would be a guess.
  if (supplied.length === 0 || supplied.some((v) => fieldsOf(v) === null)) {
    return { compared: false, reason: "sender-opaque" };
  }

  const unsupplied = reads.paths.filter(
    (path) => !supplied.some((value) => supplies(value, path)),
  );
  if (readingSomethingElse(reads, unsupplied, supplied)) {
    return { compared: false, reason: "different-object" };
  }

  return { compared: true, unsupplied };
}

/** Both halves at once, for a caller that has the receiver to hand. */
export function checkReceivedInput(args: {
  receiver: BehavioralSummary;
  carriesPayload: CarriesPayload;
  supplied: readonly unknown[];
}): ComparisonResult {
  const result = readSetOf(args.receiver, args.carriesPayload);
  if (!result.read) {
    return { compared: false, reason: result.reason };
  }
  return compareSupplied(result.reads, args.supplied);
}

export function formatPath(path: readonly string[]): string {
  return path.join(".");
}

/**
 * A message arrives through the handler's event parameter. Every pack
 * that discovers a message handler gives that parameter this role.
 */
export const isTheMessageParameter: CarriesPayload = (input) =>
  input.type === "parameter" && input.role === "event";

/**
 * The fields at the top of Lambda's event, per bus, that a business
 * payload would not plausibly have. A handler reading one of these was
 * given the envelope; one reading none of them was given the parsed
 * message by a wrapper. EventBridge's `id`, `source` and `time` are
 * left out because a parsed detail often has fields spelled that way.
 */
const LAMBDA_ENVELOPE_FIELDS: Partial<
  Record<MessageBusTechnology, readonly string[]>
> = {
  aws_sqs: ["Records"],
  "aws.sns": ["Records"],
  s3: ["Records"],
  eventbridge: ["detail", "detail-type", "resources", "account", "region"],
};

/**
 * What a queue consumer reads off the message body. A handler that
 * reads one of the platform's own envelope fields was handed the
 * envelope, and its paths are not body fields at all, so the rule
 * reports nothing rather than compare them against what a producer sent.
 */
export function messageBodyReadSet(
  summary: BehavioralSummary,
  messageBus: MessageBusTechnology,
): ReadSetResult {
  const result = readSetOf(summary, isTheMessageParameter);
  if (!result.read) {
    return result;
  }
  const envelope = LAMBDA_ENVELOPE_FIELDS[messageBus];
  if (envelope === undefined) {
    return result;
  }

  if (result.reads.paths.some((path) => envelope.includes(path[0] ?? ""))) {
    return { read: false, reason: "platform-envelope" };
  }
  // A wrapper parsed the message out of the envelope before the
  // handler saw it, so these paths do start at what the sender wrote.
  return { read: true, reads: { ...result.reads, rootedAtPayload: true } };
}

/** Every parameter is part of what the caller sent, so none of them is the payload. */
const EVERY_PARAMETER: CarriesPayload = () => false;

/** Read nothing, for a protocol that has not said which input the caller's value arrives through. */
const UNMAPPED = (): ReadSetResult => ({
  read: false,
  reason: "unmapped-protocol",
});

/** Per protocol, which input the caller's value arrives through. */
type BoundaryInputReads = {
  [K in Semantics["name"]]: (
    summary: BehavioralSummary,
    semantics: Extract<Semantics, { name: K }>,
  ) => ReadSetResult;
};

const BOUNDARY_INPUT_READS: BoundaryInputReads = {
  // A read of one argument already comes back under that parameter's
  // name, which is the word a declared field is written under.
  "function-call": (summary) => readSetOf(summary, EVERY_PARAMETER),
  "message-bus": (summary, semantics) =>
    messageBodyReadSet(summary, semantics.messageBus),
  // A request is split across headers, query, path and body, and which
  // of a handler's reads is which part is the framework's vocabulary.
  rest: UNMAPPED,
  storage: UNMAPPED,
  "unit-invocation": UNMAPPED,
  "graphql-resolver": UNMAPPED,
  "graphql-operation": UNMAPPED,
  "runtime-config": UNMAPPED,
  metric: UNMAPPED,
};

/**
 * What a unit reads off the value its boundary hands it, for the
 * protocols that have said which input that value arrives through.
 */
export function boundaryInputReads(
  summary: BehavioralSummary,
  binding: BoundaryBinding,
): ReadSetResult {
  // The one cast joins the per-protocol table, which narrows, to the
  // runtime lookup, the same way dispatchByType does it.
  const reads = BOUNDARY_INPUT_READS[binding.semantics.name] as (
    summary: BehavioralSummary,
    semantics: Semantics,
  ) => ReadSetResult;
  return reads(summary, binding.semantics);
}

/**
 * Whether the receiver is walking something other than the sender's
 * value. Reads that begin at a handler parameter may be walking the
 * platform's envelope, and one shared outermost name is what tells us
 * the two sides are talking about the same object.
 */
function readingSomethingElse(
  reads: ReadSet,
  unsupplied: readonly string[][],
  supplied: readonly unknown[],
): boolean {
  if (reads.rootedAtPayload || unsupplied.length < reads.paths.length) {
    return false;
  }
  return !reads.paths.some((path) =>
    supplied.some((value) => supplies(value, path.slice(0, 1))),
  );
}

function nameOf(input: Input): string {
  if (input.type === "hookReturn") {
    return input.hook;
  }
  if (input.type === "contextValue") {
    return input.context;
  }
  return input.name;
}

/**
 * Whether a supplied value has something at this path. A value the
 * reader cannot see into, a variable or a call or an array whose
 * elements are indexed away, returns true: it could contain anything.
 */
function supplies(value: unknown, path: readonly string[]): boolean {
  let here = value;
  for (const segment of path) {
    const fields = fieldsOf(here);
    if (fields === null) {
      return true;
    }
    if (!(segment in fields)) {
      return false;
    }
    here = fields[segment];
  }
  return true;
}

/** The named fields of an object value, or null for anything else. */
function fieldsOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    kind?: string;
    fields?: Record<string, unknown>;
  };
  if (candidate.kind !== "object" || candidate.fields === undefined) {
    return null;
  }
  return candidate.fields;
}
