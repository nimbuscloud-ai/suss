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

import type { BehavioralSummary, Input } from "@suss/behavioral-ir";

/** True when the sender's whole value arrives through this input. */
export type CarriesPayload = (input: Input) => boolean;

/** Why the rule declined to compare. */
export type StandDown =
  | "no-reads"
  | "rest-parameter"
  | "payload-used-whole"
  | "sender-opaque"
  | "different-object";

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

  const payloadInputs = new Set(
    summary.inputs.flatMap((input) =>
      carriesPayload(input) ? [nameOf(input)] : [],
    ),
  );
  // Reads record the binding's name; the sender's word is the role,
  // which is where a destructure rename keeps the name it was passed.
  const roleByBinding = new Map(
    summary.inputs.flatMap((input) =>
      input.type === "parameter"
        ? [[input.name, input.role ?? input.name]]
        : [],
    ),
  );

  const paths: string[][] = [];
  let rootedAtPayload = true;
  for (const read of reads) {
    if (payloadInputs.has(read.input)) {
      if (read.path.length === 0) {
        // The payload is used whole somewhere, so it can be forwarded
        // and every field of it read out of sight of this summary.
        return { read: false, reason: "payload-used-whole" };
      }
      paths.push([...read.path]);
      rootedAtPayload = false;
      continue;
    }
    const role = roleByBinding.get(read.input);
    if (role !== undefined) {
      paths.push([role, ...read.path]);
    }
  }
  if (paths.length === 0) {
    return { read: false, reason: "no-reads" };
  }
  return { read: true, reads: { paths, rootedAtPayload } };
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
