/**
 * Reading summaries written before the format said what it meant.
 *
 * Version 1 is everything up to 0.3.x, plus any summary with no
 * `schemaVersion` at all. It writes "the source did not say what this
 * identity is" as an empty string in a binding's identity fields, and
 * version 2 writes null there and rejects the empty string. Nobody
 * rewrites a published artifact, so every parse entry point runs the
 * normalization here first and an old summary still reads.
 *
 * The same boundary catches a summary whose identity never got an id.
 * Those read back with an id computed from the fields they do have, by
 * the same formula a full run would have arrived at.
 */

import { summaryIdFromParts } from "./summaryId.js";

/**
 * The summary format version this build writes. Absent means version 1.
 *
 * 1: an identity field a source did not name is the empty string.
 * 2: those fields are null instead, the empty string is invalid, and
 *    `"*"` is the REST method wildcard.
 * 3: a parameter input's `role` is null where nobody could read it.
 *    Older artifacts all name one, so nothing is rewritten on the way
 *    in and the bump only marks that null as allowed.
 * 4: one `storage` variant replaces `storage-relational`.
 * 5: a store and a bus go by the name OpenTelemetry's semantic
 *    conventions give them, so a summary and a span spell the same
 *    boundary the same way.
 */
export const SUMMARY_SCHEMA_VERSION = 5;

/** An empty identity field at or above this version is invalid, not legacy. */
const NULL_IDENTITY_VERSION = 2;

/** A storage binding at or above this version is already layered. */
const STORAGE_LAYERS_VERSION = 4;

/** Below this version a store and a bus go by suss's own names. */
const SEMCONV_NAMES_VERSION = 5;

/**
 * What each protocol used to call its technology, and what the
 * conventions call it. A name both already spelled the same way is
 * absent.
 */
const SEMCONV_RENAMES: Record<
  string,
  { field: string; values: Record<string, string> }
> = {
  storage: {
    field: "storageSystem",
    values: { postgres: "postgresql", dynamodb: "aws.dynamodb" },
  },
  "message-bus": {
    field: "messageBus",
    values: { sqs: "aws_sqs", sns: "aws.sns" },
  },
};

type LooseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const V1_EMPTY_IDENTITY_FIELDS: Record<string, readonly string[]> = {
  rest: ["method", "path"],
  "graphql-resolver": ["typeName"],
  "message-bus": ["channel"],
};

function normalizeBindingInPlace(binding: unknown): void {
  if (!isRecord(binding) || !isRecord(binding.semantics)) {
    return;
  }
  const semantics = binding.semantics;
  const fields =
    typeof semantics.name === "string"
      ? V1_EMPTY_IDENTITY_FIELDS[semantics.name]
      : undefined;
  if (fields === undefined) {
    return;
  }
  for (const field of fields) {
    if (semantics[field] === "") {
      semantics[field] = null;
    }
  }
}

/**
 * A storage-relational binding becomes a storage one. The table is the
 * container, and there is no secondary way in to record, since the
 * variant that wrote this could not express one.
 */
function relayerStorageBindingInPlace(binding: unknown): void {
  if (!isRecord(binding) || !isRecord(binding.semantics)) {
    return;
  }
  const semantics = binding.semantics;
  if (semantics.name !== "storage-relational") {
    return;
  }
  semantics.name = "storage";
  semantics.container = semantics.table ?? null;
  semantics.accessPath = null;
  delete semantics.table;
}

/**
 * A storage contract written as SQL columns. Every relational reader
 * that shipped before the layered variant declared each column a table
 * has, so its contract is exhaustive.
 */
function relayerStorageContractInPlace(input: LooseRecord): void {
  const metadata = input.metadata;
  if (!isRecord(metadata) || !isRecord(metadata.storageContract)) {
    return;
  }
  const contract = metadata.storageContract;
  if (!Array.isArray(contract.columns)) {
    return;
  }
  contract.fields = contract.columns;
  delete contract.columns;
  contract.fieldSet = "exhaustive";
}

/** A store or a bus written before the conventions settled its name. */
function renameToSemconvInPlace(binding: unknown): void {
  if (!isRecord(binding) || !isRecord(binding.semantics)) {
    return;
  }
  const semantics = binding.semantics;
  const rename =
    typeof semantics.name === "string"
      ? SEMCONV_RENAMES[semantics.name]
      : undefined;
  if (rename === undefined) {
    return;
  }
  const value = semantics[rename.field];
  if (typeof value !== "string") {
    return;
  }
  const renamed = rename.values[value];
  if (renamed !== undefined) {
    semantics[rename.field] = renamed;
  }
}

/** The queue an SNS subscription delivers through goes by it too. */
function renameDeliveryToSemconvInPlace(input: LooseRecord): void {
  const metadata = input.metadata;
  if (!isRecord(metadata) || !isRecord(metadata.messageBus)) {
    return;
  }
  const messageBus = metadata.messageBus;
  if (messageBus.deliveredThrough === "sqs") {
    messageBus.deliveredThrough = "aws_sqs";
  }
}

/** A summary missing the fields the formula needs fails validation next. */
function backfillIdentityId(input: LooseRecord): boolean {
  const identity = input.identity;
  if (!isRecord(identity) || typeof identity.id === "string") {
    return false;
  }
  const name = typeof identity.name === "string" ? identity.name : undefined;
  const location = input.location;
  const file =
    isRecord(location) && typeof location.file === "string"
      ? location.file
      : undefined;
  if (name === undefined || file === undefined) {
    return false;
  }
  const exportPath = Array.isArray(identity.exportPath)
    ? identity.exportPath.filter((p): p is string => typeof p === "string")
    : null;
  const workspace =
    isRecord(location) && typeof location.workspace === "string"
      ? location.workspace
      : undefined;
  identity.id = summaryIdFromParts({ workspace, file, name, exportPath });
  return true;
}

/**
 * Normalize every element and say whether any id was backfilled. A
 * per-summary backfill can mint one id for two summaries of the same
 * function, so the parse boundary settles the collisions afterward,
 * and only then: an artifact that wrote its own ids keeps them.
 */
export function normalizeLegacyArray(input: unknown): {
  value: unknown;
  anyIdBackfilled: boolean;
} {
  if (!Array.isArray(input)) {
    return { value: input, anyIdBackfilled: false };
  }
  let anyIdBackfilled = false;
  const value = input.map((element) => {
    const { value: normalized, idBackfilled } = normalizeOne(element);
    anyIdBackfilled = anyIdBackfilled || idBackfilled;
    return normalized;
  });
  return { value, anyIdBackfilled };
}

/** Mutates and returns its input, which a parse boundary owns. */
export function normalizeLegacySummary(input: unknown): unknown {
  return normalizeOne(input).value;
}

function normalizeOne(input: unknown): {
  value: unknown;
  idBackfilled: boolean;
} {
  if (!isRecord(input)) {
    return { value: input, idBackfilled: false };
  }
  const version =
    typeof input.schemaVersion === "number" ? input.schemaVersion : 1;
  if (version >= SUMMARY_SCHEMA_VERSION) {
    return { value: input, idBackfilled: false };
  }

  const idBackfilled =
    version < NULL_IDENTITY_VERSION ? backfillIdentityId(input) : false;

  forEachBinding(input, (binding) => {
    if (version < NULL_IDENTITY_VERSION) {
      normalizeBindingInPlace(binding);
    }
    if (version < STORAGE_LAYERS_VERSION) {
      relayerStorageBindingInPlace(binding);
    }
    if (version < SEMCONV_NAMES_VERSION) {
      renameToSemconvInPlace(binding);
    }
  });

  if (version < STORAGE_LAYERS_VERSION) {
    relayerStorageContractInPlace(input);
  }

  if (version < SEMCONV_NAMES_VERSION) {
    renameDeliveryToSemconvInPlace(input);
  }

  return { value: input, idBackfilled };
}

/** The summary's own binding, then the binding on every effect. */
function forEachBinding(
  input: LooseRecord,
  visit: (binding: unknown) => void,
): void {
  const identity = input.identity;
  if (isRecord(identity)) {
    visit(identity.boundaryBinding);
  }
  if (!Array.isArray(input.transitions)) {
    return;
  }
  for (const transition of input.transitions) {
    if (!isRecord(transition) || !Array.isArray(transition.effects)) {
      continue;
    }
    for (const effect of transition.effects) {
      if (isRecord(effect)) {
        visit(effect.binding);
      }
    }
  }
}
