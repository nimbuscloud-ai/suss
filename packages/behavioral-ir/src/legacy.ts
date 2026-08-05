// legacy.ts: reading summaries written before the format said what it
// meant.
//
// Version 1 artifacts (everything up to 0.3.x, and any summary with no
// `schemaVersion`) spell "the source did not name this identity" as an
// empty string in a binding's identity fields. Version 2 spells it
// null and rejects the empty string. Published artifacts do not get
// rewritten, so every parse entry point runs this normalization first
// and old summaries keep reading correctly for as long as anyone holds
// one.

/**
 * The summary format version this build writes. Absent on an artifact
 * means version 1.
 *
 * 2: identity fields a source can fail to name are null, the empty
 *    string is invalid, and `"*"` is the REST method wildcard.
 */
export const SUMMARY_SCHEMA_VERSION = 2;

type LooseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The identity fields each semantics variant could leave empty in v1. */
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
 * Rewrite a version-1 summary's empty identity fields to null, in the
 * summary's own untyped form, before validation sees it. A summary
 * already at the current version passes through untouched. Mutates and
 * returns its input: parse boundaries own the object they are decoding.
 */
export function normalizeLegacySummary(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  const version =
    typeof input.schemaVersion === "number" ? input.schemaVersion : 1;
  if (version >= SUMMARY_SCHEMA_VERSION) {
    return input;
  }

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
