// relationalPairing.ts — pair storage-relational provider summaries
// (Prisma model declarations, Drizzle pgTable() declarations, raw
// SQL DDL) against `interaction(class: "storage-access")` effects
// on code summaries.
//
// Four field-existence findings ship in v0, all on the generic
// boundaryField* enum so cross-domain tooling sees one vocabulary:
//   boundaryFieldUnknown  aspect=read   error    code reads X, schema doesn't declare X
//   boundaryFieldUnknown  aspect=write  error    code writes X, schema doesn't declare X
//   boundaryFieldUnused   (no aspect)   warning  schema declares X, no code reads or writes
//   boundaryFieldUnused   aspect=read   warning  schema declares X, code writes but never reads
//
// Future-reserved value-constraint findings (storage type / nullable
// / length / enum / selector-index) will use boundaryShapeMismatch
// and boundarySelectorMismatch with appropriate aspects when emitters
// land.
//
// Pairing key: (storageSystem, scope, table) — pulled from the
// effect's `binding.semantics` (StorageRelationalSemantics), same as
// the provider's. Multi-attribution is intentional — a shared util
// file's storage access pairs against every provider whose key
// matches, just like runtime-config did for env vars.

import { makeSide } from "../coverage/responseMatch.js";
import {
  buildInteractionIndex,
  type InteractionIndex,
  type InteractionRecord,
  interactionsOf,
  providersOf,
} from "../interactions/dispatcher.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  StorageRelationalSemantics,
} from "@suss/behavioral-ir";

interface StorageContractMetadata {
  columns?: Array<{
    name: string;
    type?: string;
    nullable?: boolean;
    primary?: boolean;
    unique?: boolean;
  }>;
  indexes?: Array<{ fields: string[]; unique: boolean }>;
}

type StorageAccessRecord = InteractionRecord<"storage-access"> & {
  /**
   * Cached storage-relational semantics from the effect's binding —
   * carries the (storageSystem, scope, table) pairing key. Pulled
   * out so the inner-loop in-scope filter doesn't repeat the type
   * narrow.
   */
  semantics: StorageRelationalSemantics;
};

/** Wildcard convention for default-shape reads (no explicit `select`). */
const ALL_FIELDS = "*";

/**
 * Run the relational-storage pairing pass over every summary in the
 * set. Provider summaries (schema-derived) pair against in-scope
 * code accesses; findings record the boundary the provider exposes
 * and the consumer summary the access lives in.
 */
export function checkRelationalStorage(
  summaries: BehavioralSummary[],
  index?: InteractionIndex,
): Finding[] {
  const findings: Finding[] = [];
  const idx = index ?? buildInteractionIndex(summaries);

  const providers = providersOf(idx, "storage-relational");
  const accesses: StorageAccessRecord[] = interactionsOf(
    idx,
    "storage-access",
    "storage-relational",
  ).map((record) => ({
    ...record,
    semantics: record.effect.binding.semantics as StorageRelationalSemantics,
  }));

  for (const provider of providers) {
    const binding = provider.identity.boundaryBinding;
    if (binding === null) {
      // Defensive: filter above guarantees one. Skip rather than crash.
      continue;
    }
    const semantics = binding.semantics as StorageRelationalSemantics;
    const contract = readStorageContract(provider);
    const declaredColumns = new Set(
      (contract.columns ?? []).map((c) => c.name),
    );

    // In-scope accesses: same storageSystem + scope + table.
    const inScope = accesses.filter(
      (a) =>
        a.semantics.storageSystem === semantics.storageSystem &&
        a.semantics.scope === semantics.scope &&
        a.semantics.table === semantics.table,
    );

    // Track field usage across all in-scope accesses for the
    // unused / write-only checks below. Two flags per declared
    // column: was it read by any access; was it written.
    const readNames = new Set<string>();
    const writtenNames = new Set<string>();
    let anyDefaultShapeRead = false;

    for (const access of inScope) {
      const fields = access.effect.interaction.fields;
      const kind = access.effect.interaction.kind;
      const wildcards = fields.includes(ALL_FIELDS);

      // Field-existence checks per access. Wildcards skip per-field
      // matching (the access reads "everything the schema declares,"
      // so by definition no field can be unknown).
      if (!wildcards) {
        for (const field of fields) {
          if (declaredColumns.has(field)) {
            continue;
          }
          findings.push(
            makeFieldUnknownFinding(provider, binding, access, field),
          );
        }
      }

      // Aggregate usage for the unused / write-only checks.
      if (kind === "read") {
        if (wildcards) {
          anyDefaultShapeRead = true;
        } else {
          for (const field of fields) {
            readNames.add(field);
          }
        }
      } else {
        if (wildcards) {
          // A wildcard write isn't a meaningful Prisma / Drizzle
          // pattern (you can't `create` without naming columns), but
          // future packs might emit it. Treat as "wrote everything"
          // — symmetric with default-shape reads.
          for (const col of declaredColumns) {
            writtenNames.add(col);
          }
        } else {
          for (const field of fields) {
            writtenNames.add(field);
          }
        }
      }
    }

    // Unused / write-only checks per declared column. Skip the
    // unused check entirely when ANY caller used a default-shape
    // read on this table — we can't tell whether the unused-looking
    // column is actually consumed by a default-shape caller.
    if (!anyDefaultShapeRead) {
      for (const column of contract.columns ?? []) {
        const isRead = readNames.has(column.name);
        const isWritten = writtenNames.has(column.name);
        if (!isRead && !isWritten) {
          findings.push(makeFieldUnusedFinding(provider, binding, column.name));
        } else if (isWritten && !isRead) {
          findings.push(makeWriteOnlyFinding(provider, binding, column.name));
        }
      }
    }
  }

  return findings;
}

function readStorageContract(
  summary: BehavioralSummary,
): StorageContractMetadata {
  return (summary.metadata?.storageContract ?? {}) as StorageContractMetadata;
}

// ---------------------------------------------------------------------------
// Finding builders
// ---------------------------------------------------------------------------

function tableLabel(semantics: StorageRelationalSemantics): string {
  // `(scope, table)` for default-scope users collapses to just the
  // table; non-default scopes keep the disambiguation visible.
  if (semantics.scope === "default") {
    return semantics.table;
  }
  return `${semantics.scope}/${semantics.table}`;
}

function makeFieldUnknownFinding(
  provider: BehavioralSummary,
  binding: BoundaryBinding,
  access: StorageAccessRecord,
  field: string,
): Finding {
  const semantics = binding.semantics as StorageRelationalSemantics;
  const accessKind = access.effect.interaction.kind;
  const verb = accessKind === "read" ? "selects" : "writes";
  return {
    kind: "boundaryFieldUnknown",
    aspect: accessKind,
    boundary: binding,
    provider: makeSide(provider),
    consumer: makeSide(access.summary, access.transitionId),
    description: `${access.summary.identity.name} ${verb} "${field}" on ${tableLabel(semantics)} (${semantics.storageSystem}) but the schema declares no ${field} column. At runtime this resolves to undefined on ${accessKind === "read" ? "reads" : "writes silently dropped"}, changing which execution paths the function takes downstream.`,
    severity: "error",
  };
}

function makeFieldUnusedFinding(
  provider: BehavioralSummary,
  binding: BoundaryBinding,
  column: string,
): Finding {
  const semantics = binding.semantics as StorageRelationalSemantics;
  return {
    kind: "boundaryFieldUnused",
    boundary: binding,
    provider: makeSide(provider),
    consumer: makeSide(provider),
    description: `${tableLabel(semantics)} declares column "${column}" but no code in the project reads or writes it. Likely dead config left over from a removed feature, or a renamed column the schema still references.`,
    severity: "warning",
  };
}

function makeWriteOnlyFinding(
  provider: BehavioralSummary,
  binding: BoundaryBinding,
  column: string,
): Finding {
  const semantics = binding.semantics as StorageRelationalSemantics;
  return {
    kind: "boundaryFieldUnused",
    aspect: "read",
    boundary: binding,
    provider: makeSide(provider),
    consumer: makeSide(provider),
    description: `${tableLabel(semantics)} declares column "${column}" and code writes it, but no code in the project reads it. Likely useless data — the application stores values nothing downstream consumes.`,
    severity: "warning",
  };
}
