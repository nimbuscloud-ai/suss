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
 */
export const SUMMARY_SCHEMA_VERSION = 3;

/** An empty identity field at or above this version is invalid, not legacy. */
const NULL_IDENTITY_VERSION = 2;

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

/** A summary missing the fields the formula needs fails validation next. */
function backfillIdentityId(input: LooseRecord): void {
  const identity = input.identity;
  if (!isRecord(identity) || typeof identity.id === "string") {
    return;
  }
  const name = typeof identity.name === "string" ? identity.name : undefined;
  const location = input.location;
  const file =
    isRecord(location) && typeof location.file === "string"
      ? location.file
      : undefined;
  if (name === undefined || file === undefined) {
    return;
  }
  const exportPath = Array.isArray(identity.exportPath)
    ? identity.exportPath.filter((p): p is string => typeof p === "string")
    : null;
  const workspace =
    isRecord(location) && typeof location.workspace === "string"
      ? location.workspace
      : undefined;
  identity.id = summaryIdFromParts({ workspace, file, name, exportPath });
}

/** Mutates and returns its input, which a parse boundary owns. */
export function normalizeLegacySummary(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  const version =
    typeof input.schemaVersion === "number" ? input.schemaVersion : 1;
  if (version >= NULL_IDENTITY_VERSION) {
    return input;
  }

  backfillIdentityId(input);

  const identity = input.identity;
  if (isRecord(identity)) {
    normalizeBindingInPlace(identity.boundaryBinding);
  }

  if (Array.isArray(input.transitions)) {
    for (const transition of input.transitions) {
      if (!isRecord(transition) || !Array.isArray(transition.effects)) {
        continue;
      }
      for (const effect of transition.effects) {
        if (isRecord(effect)) {
          normalizeBindingInPlace(effect.binding);
        }
      }
    }
  }

  return input;
}
