/**
 * What a unit reads off the value it was handed, compared against what
 * the senders to it supply.
 *
 * One rule covers every protocol. A React child reads a prop, a queue
 * consumer reads a field of a message body, and an HTTP handler reads a
 * field of a request. In each case the receiver asks for a path and the
 * sender supplies a shape, and the question is whether the shape has
 * anything at that path. The protocol determines which input the
 * sender's value arrives through, and how paths are written.
 *
 * Both sides are partial readings, so the rule declines to compare
 * instead of guessing. `StandDown` lists each reason it declines.
 */

import { readRequestSpellingMetadata } from "../metadata.js";

import type {
  BoundaryBinding,
  MessageBusTechnology,
  Semantics,
} from "@suss/ir-core";
import type {
  BehavioralSummary,
  Input,
  RequestSectionSpelling,
  RequestSpellingMetadata,
  ValueRef,
} from "../index.js";

/** True when the sender's whole value arrives through this input. */
export type CarriesPayload = (input: Input) => boolean;

/**
 * Why the rule declined to compare.
 *
 * - `no-reads`: the receiver was not seen reading any path.
 * - `rest-parameter`: a rest parameter could consume anything without a recorded read.
 * - `payload-used-whole`: the payload is used whole, so any field could be read out of sight.
 * - `sender-opaque`: some sender's value cannot be inspected.
 * - `different-object`: the reads share no outermost field with any sender's value.
 * - `platform-envelope`: the handler reads the platform's envelope, not the message body.
 * - `unmapped-protocol`: the protocol does not say which input the sender's value arrives through.
 */
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
 * reason the list could be missing some of what it reads.
 *
 * A read through the payload input gives the path from the payload's
 * root. A read through any other named parameter gives that
 * parameter's role as the first segment, since a destructure rename
 * keeps the sender's name in the role.
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
    // Reads record the local binding name, and a destructure rename
    // keeps the sender's name in the role.
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
 * Which path off the unit's input a value reference points at, in the
 * same form `readSetOf` gives a read, so a guard on a value and a read
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

/** `readSetOf` followed by `compareSupplied`, for a caller that has the receiver's summary. */
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
 * envelope, and its paths are not body fields, so the rule stands down
 * instead of comparing them against what a producer sent.
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

/** Per protocol, which input the caller's value arrives through. */
const PAYLOAD_INPUT: Record<Semantics["name"], CarriesPayload | null> = {
  "function-call": EVERY_PARAMETER,
  "message-bus": isTheMessageParameter,
  rest: null,
  storage: null,
  "unit-invocation": null,
  "graphql-resolver": null,
  "graphql-operation": null,
  "runtime-config": null,
  metric: null,
};

/**
 * Which of a unit's inputs its caller sends the value through, so a
 * guard on that value and a read of it come out in the same form. Null
 * for a protocol that does not say which input that is.
 */
export function carriesPayloadFor(
  binding: BoundaryBinding,
): CarriesPayload | null {
  return PAYLOAD_INPUT[binding.semantics.name];
}

/** The parts of a request an author declares under `receives`. */
type RequestSection = "headers" | "query" | "params" | "body";

type DeclaredSection = [RequestSection, RequestSectionSpelling];

/** The request sections the handler's pack declared a path for. */
function sectionsOf(spelling: RequestSpellingMetadata): DeclaredSection[] {
  // Spelled out one section at a time, rather than looped over the
  // names, because `check:metadata-wiring` finds a reader by reading
  // these accesses and a computed key hides all four from it.
  const declared: Array<[RequestSection, RequestSectionSpelling | undefined]> =
    [
      ["headers", spelling.headers],
      ["query", spelling.query],
      ["params", spelling.params],
      ["body", spelling.body],
    ];
  return declared.flatMap(([section, how]) =>
    how === undefined ? [] : [[section, how] as DeclaredSection],
  );
}

/** Which part of the request a read went to, and which field of it. */
interface SectionRead {
  section: RequestSection;
  /** Empty when the read said no field, which is the section taken whole. */
  field: string[];
}

/** Which section a read path falls under, or null when it falls under none. */
function underSection(
  path: readonly string[],
  sections: readonly DeclaredSection[],
): SectionRead | null {
  for (const [section, how] of sections) {
    if (!startsWith(path, how.path)) {
      continue;
    }
    const field = path.slice(how.path.length);
    return {
      section,
      field: how.saysWhichField ? field : [],
    };
  }
  return null;
}

function spell(read: SectionRead): string[] {
  return [read.section, ...read.field];
}

function startsWith(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    path.length >= prefix.length &&
    prefix.every((segment, index) => path[index] === segment)
  );
}

/**
 * What a route and the middleware around it read off the request, in
 * the words an author writes under `receives`. A read outside every
 * section is dropped, because a handler reading `request.user` is
 * reading what middleware put there, which is not part of the request.
 *
 * A section read bare, with no field of it read by name, was taken
 * whole, as in `schema.parse(req.body)`. A destructure records a bare
 * read next to the named one, and the named read is the one that
 * counts.
 */
function requestReadSet(
  handler: BehavioralSummary,
  sections: readonly DeclaredSection[],
  alsoRead: readonly BehavioralSummary[],
): ReadSetResult {
  const own = readSetOf(handler, EVERY_PARAMETER);
  // A rest parameter on the route hides reads from every side of this.
  // A wrapper that stands down only removes its own reads.
  if (!own.read && own.reason !== "no-reads") {
    return own;
  }

  const reads = [own, ...alsoRead.map((w) => readSetOf(w, EVERY_PARAMETER))]
    .flatMap((result) => (result.read ? result.reads.paths : []))
    .flatMap((path) => underSection(path, sections) ?? []);

  const named = reads.filter((read) => read.field.length > 0);
  const sawField = new Set(named.map((read) => read.section));
  const whole = [...new Set(reads.map((read) => read.section))]
    .filter((section) => !sawField.has(section))
    .map((section) => [section]);

  const paths = [...named.map(spell), ...whole];
  if (paths.length === 0) {
    return { read: false, reason: "no-reads" };
  }
  return { read: true, reads: { paths, rootedAtPayload: true } };
}

/**
 * How one protocol spells what a unit reads off the value it is
 * handed, so a read and a guard on the same field come out alike.
 */
interface InputSpelling {
  /**
   * Every path the unit was seen asking for, or why the list could be
   * short. `alsoRead` are units that read the same value without being
   * the boundary: the middleware around a route.
   */
  reads: (alsoRead: readonly BehavioralSummary[]) => ReadSetResult;
  /** One value reference, spelled the way `reads` spells a read. */
  pathOf: (ref: ValueRef) => string[] | null;
}

/** Reads nothing, for a protocol that has not said which input the caller's value arrives through. */
const UNMAPPED = (): InputSpelling => ({
  reads: () => ({ read: false, reason: "unmapped-protocol" }),
  pathOf: () => null,
});

/** The spelling for a protocol whose value arrives through named inputs, where one predicate picks the payload input. */
function through(
  summary: BehavioralSummary,
  carriesPayload: CarriesPayload,
): InputSpelling {
  return {
    reads: () => readSetOf(summary, carriesPayload),
    pathOf: (ref) => readPathOf(summary, ref, carriesPayload),
  };
}

/**
 * A request is split across headers, query, path and body, and which
 * part a handler's read goes to depends on the framework. The pack that
 * recognized the handler records that at extract time. A summary from a
 * pack that does not record it gets `unmapped-protocol`.
 */
function restSpelling(summary: BehavioralSummary): InputSpelling {
  const spelling = readRequestSpellingMetadata(summary);
  if (spelling === undefined) {
    return UNMAPPED();
  }
  const sections = sectionsOf(spelling);
  return {
    reads: (alsoRead) => requestReadSet(summary, sections, alsoRead),
    pathOf: (ref) => {
      const path = readPathOf(summary, ref, EVERY_PARAMETER);
      const read = path === null ? null : underSection(path, sections);
      return read === null ? null : spell(read);
    },
  };
}

type BoundaryInputSpellings = {
  [K in Semantics["name"]]: (
    summary: BehavioralSummary,
    semantics: Extract<Semantics, { name: K }>,
  ) => InputSpelling;
};

const BOUNDARY_INPUT_SPELLINGS: BoundaryInputSpellings = {
  // A read of one argument already comes back under that parameter's
  // name, which is the word a declared field is written under.
  "function-call": (summary) => through(summary, EVERY_PARAMETER),
  "message-bus": (summary, semantics) => ({
    reads: () => messageBodyReadSet(summary, semantics.messageBus),
    pathOf: (ref) => readPathOf(summary, ref, isTheMessageParameter),
  }),
  rest: (summary) => restSpelling(summary),
  storage: UNMAPPED,
  "unit-invocation": UNMAPPED,
  "graphql-resolver": UNMAPPED,
  "graphql-operation": UNMAPPED,
  "runtime-config": UNMAPPED,
  metric: UNMAPPED,
};

function spellingFor(
  summary: BehavioralSummary,
  binding: BoundaryBinding,
): InputSpelling {
  // The table narrows per protocol and a lookup by name cannot, so the
  // cast happens once here, as in `dispatchByType`.
  const spelling = BOUNDARY_INPUT_SPELLINGS[binding.semantics.name] as (
    summary: BehavioralSummary,
    semantics: Semantics,
  ) => InputSpelling;
  return spelling(summary, binding.semantics);
}

/**
 * What a unit reads off the value its boundary hands it, for the
 * protocols that have said which input that value arrives through.
 * `alsoRead` are units reading the same value beside it, which for a
 * route is the middleware registered around it.
 */
export function boundaryInputReads(
  summary: BehavioralSummary,
  binding: BoundaryBinding,
  alsoRead: readonly BehavioralSummary[] = [],
): ReadSetResult {
  return spellingFor(summary, binding).reads(alsoRead);
}

/**
 * Which path off that value a reference points at, spelled the way
 * `boundaryInputReads` spells a read, so a guard on a field and a read
 * of it compare. Null when the reference is not one this rule follows.
 */
export function boundaryInputPathOf(
  summary: BehavioralSummary,
  binding: BoundaryBinding,
  ref: ValueRef,
): string[] | null {
  return spellingFor(summary, binding).pathOf(ref);
}

/**
 * Whether the receiver is walking something other than the sender's
 * value. Reads that begin at a handler parameter may be walking the
 * platform's envelope, and one shared outermost name shows that the two
 * sides are about the same object.
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
 * Whether a supplied value has something at this path. A value that
 * cannot be inspected, such as a variable or a call, returns true,
 * since it could contain anything.
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
