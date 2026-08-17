// storagePairing.ts: pair storage provider summaries (Prisma model
// declarations, Drizzle pgTable() declarations, raw SQL DDL) against
// `interaction(class: "storage-access")` effects on code summaries.
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
// Pairing key: (storageSystem, scope, container, accessPath), pulled
// from the effect's `binding.semantics` (StorageSemantics), same as
// the provider's. Multi-attribution is intentional, a shared util
// file's storage access pairs against every provider whose key
// matches, just like runtime-config did for env vars.

import {
  namesAgree,
  namesNothing,
  readStorageContractMetadata,
} from "@suss/behavioral-ir";

import { makeSide } from "../coverage/responseMatch.js";
import {
  buildInteractionIndex,
  type InteractionIndex,
  type InteractionRecord,
  interactionsOf,
  providersOf,
} from "../interactions/dispatcher.js";
import { groundReferences } from "./grounding.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  StorageContractMetadata,
  StorageSemantics,
} from "@suss/behavioral-ir";

type StorageAccessRecord = InteractionRecord<"storage-access"> & {
  /**
   * Cached storage semantics from the effect's binding, which has the
   * pairing key on it. Pulled out so the inner-loop in-scope filter
   * doesn't repeat the type narrow.
   */
  semantics: StorageSemantics;
};

/** Wildcard convention for default-shape reads (no explicit `select`). */
const ALL_FIELDS = "*";

/**
 * Run the storage pairing pass over every summary in the set.
 * Provider summaries (schema-derived) pair against in-scope
 * code accesses; findings record the boundary the provider exposes
 * and the consumer summary the access lives in.
 */
export function checkStorage(
  summaries: BehavioralSummary[],
  index?: InteractionIndex,
  /**
   * Where to record what this pass compared. A report that counts only
   * the boundaries pairing matched says nothing was compared on a run
   * whose whole point was the stores.
   */
  compared?: Array<{ key: string; provider: string; consumer: string }>,
): Finding[] {
  const findings: Finding[] = [];
  const idx = index ?? buildInteractionIndex(summaries);
  const grounding = groundReferences(summaries);

  /**
   * The names one access reaches. A container that says only where to
   * look is asked about the callers, and an access nobody calls reaches
   * nothing rather than everything.
   */
  const namesReached = (access: StorageAccessRecord): string[] => {
    const container = access.semantics.container;
    if (container === null) {
      return [];
    }
    return namesNothing(container)
      ? grounding.namesFor(access.summary, container)
      : [container];
  };

  const providers = providersOf(idx, "storage");
  const accesses: StorageAccessRecord[] = interactionsOf(
    idx,
    "storage-access",
    "storage",
  ).map((record) => ({
    ...record,
    semantics: record.effect.binding.semantics as StorageSemantics,
  }));

  for (const provider of providers) {
    const binding = provider.identity.boundaryBinding;
    if (binding === null) {
      // Defensive: filter above guarantees one. Skip rather than crash.
      continue;
    }
    const semantics = binding.semantics as StorageSemantics;
    const contract = readStorageContract(provider);
    const declaredFields = new Set((contract.fields ?? []).map((f) => f.name));
    // Only a contract that declares every field an item has can call
    // a field it does not declare unknown.
    const fieldSetIsComplete = contract.fieldSet === "exhaustive";

    // In-scope accesses: same store, scope, and access path, with a
    // container agreeing with either declared name, the binding's own
    // (a Prisma model) or the physical name a template states.
    const containerNames = [semantics.container, contract.physicalTable].filter(
      (name): name is string => name !== undefined && name !== null,
    );
    // A provider whose container this reader could not settle claims no
    // accesses, rather than every access that spells it the same way.
    if (containerNames.length === 0) {
      continue;
    }
    const inScope = accesses.filter(
      (a) =>
        a.semantics.storageSystem === semantics.storageSystem &&
        a.semantics.scope === semantics.scope &&
        a.semantics.accessPath === semantics.accessPath &&
        namesReached(a).some((reached) =>
          containerNames.some((name) => namesAgree(name, reached)),
        ) &&
        sameService(provider, a.summary),
    );

    for (const access of inScope) {
      compared?.push({
        key: `${semantics.storageSystem}:${containerLabel(semantics)}`,
        provider: provider.identity.name,
        consumer: access.summary.identity.name,
      });
    }

    // Track field usage across all in-scope accesses for the
    // unused / write-only checks below. Two flags per declared
    // field: was it read by any access; was it written.
    const readNames = new Set<string>();
    const writtenNames = new Set<string>();
    let anyDefaultShapeRead = false;

    for (const access of inScope) {
      const fields = access.effect.interaction.fields;
      const kind = access.effect.interaction.kind;
      const wildcards = fields.includes(ALL_FIELDS);

      // A read that states no fields asks for the whole item. A way in
      // that copies part of one cannot serve that, and the store sends
      // what it has and reports no error, so the caller gets an item
      // with fields missing and nothing says so.
      if (
        wildcards &&
        kind === "read" &&
        fieldSetIsComplete &&
        semantics.accessPath !== null
      ) {
        findings.push(makeWholeItemFinding(provider, binding, access));
      }

      // Field-existence checks per access. Wildcards skip per-field
      // matching (the access reads "everything the schema declares,"
      // so by definition no field can be unknown).
      if (!wildcards && fieldSetIsComplete) {
        for (const field of fields) {
          if (declaredFields.has(field)) {
            continue;
          }
          findings.push(
            makeFieldUnknownFinding(provider, binding, access, field),
          );
        }
      }

      // A query that picks items by something the container does not key
      // on fails at the store, so it is worth saying before it runs.
      for (const field of selectorBeyondKey(contract, access)) {
        findings.push(
          makeSelectorMismatchFinding(provider, binding, access, field),
        );
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
          //, symmetric with default-shape reads.
          for (const col of declaredFields) {
            writtenNames.add(col);
          }
        } else {
          for (const field of fields) {
            writtenNames.add(field);
          }
        }
      }
    }

    // Unused / write-only checks per declared field. Skip the unused
    // check entirely when ANY caller used a default-shape read here: we
    // can't tell whether that caller consumes the unused-looking field.
    //
    // A store no code in this run reaches says nothing about any of
    // its fields. Reading a template on its own would otherwise give
    // one warning per field every table declares, and none of them
    // would mean what the words say.
    if (!anyDefaultShapeRead && inScope.length > 0) {
      for (const field of contract.fields ?? []) {
        const isRead = readNames.has(field.name);
        const isWritten = writtenNames.has(field.name);
        if (!isRead && !isWritten) {
          findings.push(makeFieldUnusedFinding(provider, binding, field.name));
        } else if (isWritten && !isRead) {
          findings.push(makeWriteOnlyFinding(provider, binding, field.name));
        }
      }
    }
  }

  return findings;
}

/**
 * Whether a schema and an access belong to one service. Two services
 * both keep a users table under the scope "default", so the key alone
 * puts them together and each gets checked against the other's schema
 * at error severity (#121). A summary that states no workspace is a
 * single-project run, where every summary belongs to the one service.
 */
function sameService(
  provider: BehavioralSummary,
  access: BehavioralSummary,
): boolean {
  const providerService = provider.location.workspace;
  const accessService = access.location.workspace;
  if (providerService === undefined || accessService === undefined) {
    return true;
  }
  return providerService === accessService;
}

/**
 * The attributes an access picks items by that the container does not
 * key on. A contract that does not say what identifies an item claims
 * nothing here, and neither does an access that states no selector.
 */
function selectorBeyondKey(
  contract: StorageContractMetadata,
  access: StorageAccessRecord,
): string[] {
  const identifies = contract.identifies;
  if (identifies === undefined || identifies.kind !== "keyFields") {
    return [];
  }
  const selector = access.effect.interaction.selector ?? [];
  return selector.filter((field) => !identifies.fields.includes(field));
}

function readStorageContract(
  summary: BehavioralSummary,
): StorageContractMetadata {
  return readStorageContractMetadata(summary) ?? {};
}

// ---------------------------------------------------------------------------
// Finding builders
// ---------------------------------------------------------------------------

function containerLabel(semantics: StorageSemantics): string {
  const container = semantics.container ?? "<unnamed container>";
  // A secondary way in gets written after the container it belongs to,
  // since a query through an index is a different access.
  const addressed =
    semantics.accessPath === null
      ? container
      : `${container}#${semantics.accessPath}`;
  // `(scope, container)` for default-scope users collapses to the bare
  // container; non-default scopes keep the disambiguation visible.
  if (semantics.scope === "default") {
    return addressed;
  }
  return `${semantics.scope}/${addressed}`;
}

function makeFieldUnknownFinding(
  provider: BehavioralSummary,
  binding: BoundaryBinding,
  access: StorageAccessRecord,
  field: string,
): Finding {
  const semantics = binding.semantics as StorageSemantics;
  const accessKind = access.effect.interaction.kind;
  const verb = accessKind === "read" ? "selects" : "writes";
  return {
    kind: "boundaryFieldUnknown",
    aspect: accessKind,
    boundary: binding,
    provider: makeSide(provider),
    consumer: makeSide(access.summary, access.transitionId),
    description: `${access.summary.identity.name} ${verb} "${field}" on ${containerLabel(semantics)} (${semantics.storageSystem}) but the contract declares no ${field} field.`,
    severity: "error",
  };
}

/** A read of a whole item through a way in that copies part of one. */
function makeWholeItemFinding(
  provider: BehavioralSummary,
  binding: BoundaryBinding,
  access: StorageAccessRecord,
): Finding {
  const semantics = binding.semantics as StorageSemantics;
  return {
    kind: "boundaryFieldUnknown",
    aspect: "read",
    boundary: binding,
    provider: makeSide(provider),
    consumer: makeSide(access.summary, access.transitionId),
    description: `${access.summary.identity.name} reads whole items through ${containerLabel(semantics)} (${semantics.storageSystem}), which copies only the fields it declares, so anything else comes back absent and no error says so.`,
    severity: "error",
  };
}

function makeSelectorMismatchFinding(
  provider: BehavioralSummary,
  binding: BoundaryBinding,
  access: StorageAccessRecord,
  field: string,
): Finding {
  const semantics = binding.semantics as StorageSemantics;
  const contract = readStorageContract(provider);
  const keys =
    contract.identifies?.kind === "keyFields"
      ? contract.identifies.fields.join(", ")
      : "";
  return {
    kind: "boundarySelectorMismatch",
    aspect: access.effect.interaction.kind,
    boundary: binding,
    provider: makeSide(provider),
    consumer: makeSide(access.summary, access.transitionId),
    description: `${access.summary.identity.name} picks items on ${containerLabel(semantics)} by "${field}", which is not one of its key attributes (${keys}). ${semantics.storageSystem} refuses a request keyed on anything else, so this fails when it runs.`,
    severity: "error",
  };
}

function makeFieldUnusedFinding(
  provider: BehavioralSummary,
  binding: BoundaryBinding,
  field: string,
): Finding {
  const semantics = binding.semantics as StorageSemantics;
  return {
    kind: "boundaryFieldUnused",
    boundary: binding,
    provider: makeSide(provider),
    consumer: makeSide(provider),
    description: `${containerLabel(semantics)} declares "${field}" but no code in the project reads or writes it. Likely dead config left over from a removed feature, or a field the contract still declares under its old name.`,
    severity: "warning",
  };
}

function makeWriteOnlyFinding(
  provider: BehavioralSummary,
  binding: BoundaryBinding,
  field: string,
): Finding {
  const semantics = binding.semantics as StorageSemantics;
  return {
    kind: "boundaryFieldUnused",
    aspect: "read",
    boundary: binding,
    provider: makeSide(provider),
    consumer: makeSide(provider),
    description: `${containerLabel(semantics)} declares "${field}" and code writes it, but no code in the project reads it. Likely useless data. The application stores values nothing downstream consumes.`,
    severity: "warning",
  };
}
