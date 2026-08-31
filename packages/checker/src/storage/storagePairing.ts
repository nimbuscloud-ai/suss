// storagePairing.ts: pair storage provider summaries (Prisma model
// declarations, Drizzle pgTable() declarations, raw SQL DDL) against
// `interaction(class: "storage-access")` effects on code summaries.
//
// Four field-existence findings ship in v0, all on the generic
// boundaryField* enum so cross-domain tooling sees one vocabulary:
//   boundaryFieldUnknown  aspect=read   error    code reads X, schema doesn't declare X
//   boundaryFieldUnknown  aspect=write  error    code writes X, schema doesn't declare X
//   boundaryFieldUnused   (no aspect)   warning  schema declares X, no query asks for or writes X
//   boundaryFieldUnused   aspect=read   warning  schema declares X, code writes X, no query asks for it
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
//
// An access written under a relation, the select inside a Prisma
// `include` or the `connectOrCreate` inside its `data`, arrives keyed
// to the container the query addressed and carrying `relationPath`.
// `withRelationAccessesPlaced` walks that path over the contracts and
// moves the access to the container it arrives at, before any of it is
// claimed.
//
// Two containers can be declared under names that both cover what one
// access reached, since a name built at deploy time has a hole in it.
// The access pairs with the more specific of the two, and with neither
// when they are equally specific: see `ambiguousProvider` below, and
// the README beside this file.

import {
  dispatchByType,
  fixedTextLength,
  namesAgree,
  parseBoundaryName,
  readStorageContractMetadata,
  referenceOf,
  summaryIdentifier,
} from "@suss/behavioral-ir";
import {
  EVERY_FIELD,
  storageContainerLabel,
  storageLabel,
} from "@suss/ir-core";

import { makeSide } from "../coverage/responseMatch.js";
import {
  buildInteractionIndex,
  type InteractionIndex,
  type InteractionRecord,
  interactionsOf,
  providersOf,
} from "../interactions/dispatcher.js";
import { mostSpecificName } from "../pairing/mostSpecificName.js";
import { type Grounding, groundReferences } from "./grounding.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  BoundaryName,
  Finding,
  Semantics,
  StorageContractMetadata,
  StorageSemantics,
} from "@suss/behavioral-ir";
import type { ComparedPair } from "../pairing/comparedPair.js";
import type { NameCandidate, NameChoice } from "../pairing/mostSpecificName.js";

type StorageAccessRecord = InteractionRecord<"storage-access"> & {
  /**
   * Cached storage semantics from the effect's binding, which has the
   * pairing key on it. Pulled out so the inner-loop in-scope filter
   * doesn't repeat the type narrow.
   */
  semantics: StorageSemantics;
};

const ALL_FIELDS = EVERY_FIELD;

/**
 * Run the storage pairing pass over every summary in the set.
 * Provider summaries (schema-derived) pair against in-scope
 * code accesses; findings record the boundary the provider exposes
 * and the consumer summary the access lives in.
 */
export function checkStorage(
  summaries: BehavioralSummary[],
  index?: InteractionIndex,
  /** Where to record what this pass compared; see `ComparedPair`. */
  compared?: ComparedPair[],
): Finding[] {
  const findings: Finding[] = [];
  const idx = index ?? buildInteractionIndex(summaries);
  const grounding = groundReferences(summaries);
  const containers = declaredContainers(providersOf(idx, "storage"));
  const reachedFor = reachedBy(grounding);
  const accesses = withRelationAccessesPlaced(
    containers,
    accessRecords(idx),
    reachedFor,
  );
  const claimed = claimAccesses(containers, accesses, reachedFor);
  findings.push(...claimed.findings);

  for (const container of containers) {
    const { summary: provider, binding, semantics, contract } = container;
    const declaredFields = new Set((contract.fields ?? []).map((f) => f.name));
    // Only a contract that declares every field an item has can call
    // a field it does not declare unknown.
    const fieldSetIsComplete = contract.fieldSet === "exhaustive";
    const inScope = claimed.byContainer.get(container) ?? [];

    for (const access of inScope) {
      compared?.push({
        key: keyOf(semantics),
        provider: summaryIdentifier(provider),
        consumer: summaryIdentifier(access.summary),
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
        // A field the store serves without keeping it has nobody to
        // write it, so both checks below would be about the wrong
        // thing.
        if (field.derived === true) {
          continue;
        }
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
 * A container somebody declared, with what the pass needs about it
 * worked out once. `names` are the two spellings it is declared under,
 * the binding's own (a Prisma model) and the physical one a template
 * states.
 */
interface DeclaredContainer {
  summary: BehavioralSummary;
  binding: BoundaryBinding;
  semantics: StorageSemantics;
  contract: StorageContractMetadata;
  names: string[];
}

/** Who supplied a grounded name, and which side of grounding it is. */
export interface GroundedBy {
  summary: BehavioralSummary;
  role: "runtime" | "caller";
}

/** A name an access reached, and who supplied it when grounding did. */
export interface ReachedName {
  name: string;
  groundedBy: GroundedBy | null;
}

interface Claims {
  byContainer: Map<DeclaredContainer, StorageAccessRecord[]>;
  findings: Finding[];
  links: ClaimLink[];
}

/** One provider claiming one access, and the name that matched. */
interface ClaimLink {
  container: DeclaredContainer;
  access: StorageAccessRecord;
  reached: ReachedName;
}

function accessRecords(idx: InteractionIndex): StorageAccessRecord[] {
  return interactionsOf(idx, "storage-access", "storage").map((record) => ({
    ...record,
    semantics: record.effect.binding.semantics as StorageSemantics,
  }));
}

/**
 * The names one access reaches. A container that says only where to
 * look is asked about the callers and the runtime's configuration, and
 * an access nobody grounds reaches nothing rather than everything.
 */
function reachedBy(
  grounding: Grounding,
): (access: StorageAccessRecord) => ReachedName[] {
  return (access) => {
    const container = access.semantics.container;
    if (container === null) {
      return [];
    }
    return dispatchByType<BoundaryName, ReachedName[]>(
      {
        literal: () => [{ name: container, groundedBy: null }],
        pattern: () => [{ name: container, groundedBy: null }],
        reference: (name) => {
          const seen = new Set<string>();
          const reached: ReachedName[] = [];
          for (const grounded of grounding.groundedNamesFor(
            access.summary,
            referenceOf(name),
          )) {
            if (seen.has(grounded.name)) {
              continue;
            }
            seen.add(grounded.name);
            reached.push({
              name: grounded.name,
              groundedBy: { summary: grounded.source, role: grounded.role },
            });
          }
          return reached;
        },
      },
      parseBoundaryName(container),
    );
  };
}

function declaredContainers(
  summaries: BehavioralSummary[],
): DeclaredContainer[] {
  const containers: DeclaredContainer[] = [];
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      // Defensive: the lookup above guarantees one. Skip rather than crash.
      continue;
    }
    const contract = readStorageContract(summary);
    const semantics = binding.semantics as StorageSemantics;
    const names = [semantics.container, contract.physicalTable].filter(
      (name): name is string => name !== undefined && name !== null,
    );
    // A container this reader could not settle claims no accesses,
    // rather than every access that spells it the same way.
    if (names.length === 0) {
      continue;
    }
    containers.push({ summary, binding, semantics, contract, names });
  }
  return containers;
}

/**
 * Which accesses each container is checked against. Every name an access
 * reaches is offered to every container declared under a name that
 * covers it, and the most specific of those takes it. An even contest
 * takes nothing and says so.
 */
function claimAccesses(
  containers: DeclaredContainer[],
  accesses: StorageAccessRecord[],
  reachedFor: (access: StorageAccessRecord) => ReachedName[],
): Claims {
  const byContainer = new Map<DeclaredContainer, StorageAccessRecord[]>();
  const findings: Finding[] = [];
  const links: ClaimLink[] = [];
  for (const access of accesses) {
    for (const reached of reachedFor(access)) {
      const choice = claimantsOf(containers, access, reached.name);
      if (choice.tied.length > 0) {
        findings.push(
          makeAmbiguousContainerFinding(access, reached.name, choice),
        );
        continue;
      }
      for (const container of choice.chosen) {
        claim(byContainer, container, access);
        links.push({ container, access, reached });
      }
    }
  }
  return { byContainer, findings, links };
}

/**
 * The containers that could claim what one access reached, with the
 * even contest reported rather than settled.
 */
function claimantsOf(
  containers: DeclaredContainer[],
  access: StorageAccessRecord,
  reached: string,
): NameChoice<DeclaredContainer> {
  const candidates: NameCandidate<DeclaredContainer>[] = [];
  for (const container of containers) {
    const name = nameCovering(container, access, reached);
    if (name !== null) {
      candidates.push({ subject: container, name });
    }
  }
  return mostSpecificName(candidates);
}

/**
 * Accesses, with every one written under a relation moved to the
 * container that relation arrives at. A call states the relation it
 * went through and never the container behind it, so the walk happens
 * here, over the contract of the container the call itself pairs
 * with. A relation nothing in the run declares drops the access:
 * leaving it on the container the call addressed would count a field
 * on the wrong store.
 */
function withRelationAccessesPlaced(
  containers: DeclaredContainer[],
  accesses: StorageAccessRecord[],
  reachedFor: (access: StorageAccessRecord) => ReachedName[],
): StorageAccessRecord[] {
  const placed: StorageAccessRecord[] = [];
  for (const access of accesses) {
    const path = access.effect.interaction.relationPath ?? [];
    if (path.length === 0) {
      placed.push(access);
      continue;
    }
    if (access.effect.interaction.relationKey === true) {
      placed.push(...keyWrites(containers, access, reachedFor(access), path));
      continue;
    }
    for (const target of relationTargets(
      containers,
      access,
      reachedFor(access),
      path,
    )) {
      placed.push(movedTo(access, target));
    }
  }
  return placed;
}

/**
 * A write that moves a join, placed as a write of the foreign key.
 * Every hop but the last arrives at the container that declares the
 * relation, and the last hop is the relation whose key changes there.
 * So this write stays on the near side of the relation, where a nested
 * `create` under that same relation crosses to the far side.
 */
function keyWrites(
  containers: DeclaredContainer[],
  access: StorageAccessRecord,
  reached: ReachedName[],
  path: string[],
): StorageAccessRecord[] {
  const relation = path[path.length - 1];
  const written: StorageAccessRecord[] = [];
  const seen = new Set<string>();
  for (const name of reached) {
    for (const start of claimantsOf(containers, access, name.name).chosen) {
      const owner = followRelations(containers, start, path.slice(0, -1));
      if (owner === null) {
        continue;
      }
      const columns = keyColumnsOf(containers, owner.container, relation);
      const key = `${owner.name ?? ""}:${columns.join(",")}`;
      if (columns.length === 0 || seen.has(key)) {
        continue;
      }
      seen.add(key);
      written.push(withFields(placedOn(access, owner), columns));
    }
  }
  return written;
}

/**
 * The columns a write through one field of a container fills. A
 * relation that declares a foreign key fills it, and one whose key
 * lives on the far side or in a join table fills nothing here. A field
 * the contract does not call a relation is taken at its word as a
 * column, so the unknown-field check still reports one nobody declared.
 */
function keyColumnsOf(
  containers: DeclaredContainer[],
  container: DeclaredContainer,
  field: string,
): string[] {
  const declared = (container.contract.fields ?? []).find(
    (candidate) => candidate.name === field,
  );
  if (declared === undefined) {
    return [field];
  }
  if (declared.relationKey !== undefined) {
    return declared.relationKey;
  }
  if (relationTargetOf(containers, container, field) !== undefined) {
    return [];
  }
  return [field];
}

/** The access, addressed to the container a walk of the path arrived at. */
function placedOn(
  access: StorageAccessRecord,
  hop: RelationHop,
): StorageAccessRecord {
  if (hop.name === null) {
    return access;
  }
  return movedTo(access, hop.name);
}

/** The same access, over the columns the contract worked out for it. */
function withFields(
  access: StorageAccessRecord,
  fields: string[],
): StorageAccessRecord {
  return {
    ...access,
    effect: {
      ...access.effect,
      interaction: { ...access.effect.interaction, fields },
    },
  };
}

/** Where a relation path arrives, from each container that claims the query. */
function relationTargets(
  containers: DeclaredContainer[],
  access: StorageAccessRecord,
  reached: ReachedName[],
  path: string[],
): string[] {
  const targets = new Set<string>();
  for (const name of reached) {
    for (const start of claimantsOf(containers, access, name.name).chosen) {
      const arrived = followRelations(containers, start, path);
      if (arrived !== null && arrived.name !== null) {
        targets.add(arrived.name);
      }
    }
  }
  return [...targets];
}

/** Where a walk of a relation path ended up. */
interface RelationHop {
  container: DeclaredContainer;
  /** What the last hop was declared as, and null when there was none. */
  name: string | null;
}

/**
 * The container a relation path arrives at, one hop per relation, or
 * null when a hop is a field the contract leaves out, or a field whose
 * type is a container nothing in the run declares. An empty path
 * arrives where it started.
 */
function followRelations(
  containers: DeclaredContainer[],
  start: DeclaredContainer,
  path: string[],
): RelationHop | null {
  let arrived: RelationHop = { container: start, name: null };
  for (const hop of path) {
    const next = relationTargetOf(containers, arrived.container, hop);
    if (next === undefined) {
      return null;
    }
    arrived = next;
  }
  return arrived;
}

/** The container a relation field points at, when the run declares one. */
function relationTargetOf(
  containers: DeclaredContainer[],
  container: DeclaredContainer,
  field: string,
): RelationHop | undefined {
  const type = relationTypeOf(container, field);
  if (type === null) {
    return undefined;
  }
  const target = containers.find((candidate) => candidate.names.includes(type));
  return target === undefined ? undefined : { container: target, name: type };
}

/** The container a relation field points at, list suffix stripped. */
function relationTypeOf(
  container: DeclaredContainer,
  field: string,
): string | null {
  const declared = (container.contract.fields ?? []).find(
    (candidate) => candidate.name === field,
  );
  const type = declared?.type;
  if (type === undefined) {
    return null;
  }
  return type.endsWith("[]") ? type.slice(0, -2) : type;
}

/** The same access, addressed to the container its relation reached. */
function movedTo(
  access: StorageAccessRecord,
  container: string,
): StorageAccessRecord {
  const semantics: StorageSemantics = { ...access.semantics, container };
  return {
    ...access,
    semantics,
    effect: {
      ...access.effect,
      binding: { ...access.effect.binding, semantics },
    },
  };
}

/**
 * Every storage access in a run, with the names it reaches and the
 * providers that claim it, attributed exactly as `checkStorage`
 * attributes findings. `suss ask` answers a question asked in a
 * deployed name from this, so the two never disagree on a pair.
 */
export interface GroundedStorageAccess {
  /** The unit the access is written in. */
  summary: BehavioralSummary;
  /** The access's binding, the same object the summary's effect has. */
  binding: BoundaryBinding;
  /** The container as the access writes it. */
  container: string;
  /**
   * The names the access reaches. `groundedBy` is the summary that
   * supplied a name the container does not state itself: the runtime
   * whose configuration sets the variable, or the caller that passed
   * the value.
   */
  reached: ReachedName[];
  /** The providers that claim this access. */
  providers: BehavioralSummary[];
  /** Whether the access reads the container or writes it. */
  kind: "read" | "write";
  /** The call as the source writes it, when the effect recorded one. */
  callee: string | undefined;
  /**
   * Present when the container is a reference nothing here grounds:
   * the variable whose deployed value would ground it, or null when a
   * caller's argument would.
   */
  ungrounded?: { variable: string | null };
}

/** A declared store, and every name it is declared under. */
export interface GroundedStorageProvider {
  summary: BehavioralSummary;
  binding: BoundaryBinding;
  /** Its container, and the resource name its contract declares. */
  names: string[];
}

export interface GroundedStorage {
  accesses: GroundedStorageAccess[];
  providers: GroundedStorageProvider[];
}

export function groundStorageAccesses(
  summaries: BehavioralSummary[],
): GroundedStorage {
  const idx = buildInteractionIndex(summaries);
  const grounding = groundReferences(summaries);
  const containers = declaredContainers(providersOf(idx, "storage"));
  const reachedFor = reachedBy(grounding);
  const accesses = withRelationAccessesPlaced(
    containers,
    accessRecords(idx),
    reachedFor,
  );
  const claimed = claimAccesses(containers, accesses, reachedFor);

  const providersFor = new Map<StorageAccessRecord, BehavioralSummary[]>();
  for (const link of claimed.links) {
    const found = providersFor.get(link.access) ?? [];
    if (!found.includes(link.container.summary)) {
      found.push(link.container.summary);
    }
    providersFor.set(link.access, found);
  }

  const grounded = accesses.flatMap((access): GroundedStorageAccess[] => {
    const container = access.semantics.container;
    if (container === null) {
      return [];
    }
    const reached = reachedFor(access);
    const ungrounded =
      reached.length > 0
        ? undefined
        : dispatchByType<BoundaryName, { variable: string | null } | undefined>(
            {
              literal: () => undefined,
              pattern: () => undefined,
              reference: (name) => ({
                variable: grounding.variableFor(
                  access.summary,
                  referenceOf(name),
                ),
              }),
            },
            parseBoundaryName(container),
          );
    return [
      {
        summary: access.summary,
        binding: access.effect.binding,
        container,
        reached,
        providers: providersFor.get(access) ?? [],
        kind: access.effect.interaction.kind === "read" ? "read" : "write",
        callee: access.effect.callee,
        ...(ungrounded === undefined ? {} : { ungrounded }),
      },
    ];
  });

  return {
    accesses: grounded,
    providers: containers.map((container) => ({
      summary: container.summary,
      binding: container.binding,
      names: container.names,
    })),
  };
}

/**
 * The name this container is declared under that covers what the
 * access reached, or null when the two do not meet. A container with
 * two names offers the one that states more of itself, since that is
 * what the choice between containers is made on.
 */
function nameCovering(
  container: DeclaredContainer,
  access: StorageAccessRecord,
  reached: string,
): string | null {
  const semantics = container.semantics;
  if (
    access.semantics.storageSystem !== semantics.storageSystem ||
    access.semantics.scope !== semantics.scope ||
    access.semantics.accessPath !== semantics.accessPath ||
    !sameService(container.summary, access.summary)
  ) {
    return null;
  }
  const covering = container.names.filter((name) => namesAgree(name, reached));
  if (covering.length === 0) {
    return null;
  }
  return covering.reduce((most, name) =>
    fixedTextLength(name) > fixedTextLength(most) ? name : most,
  );
}

/** One access reaching two names can arrive at one container twice. */
function claim(
  byContainer: Map<DeclaredContainer, StorageAccessRecord[]>,
  container: DeclaredContainer,
  access: StorageAccessRecord,
): void {
  const already = byContainer.get(container);
  if (already === undefined) {
    byContainer.set(container, [access]);
    return;
  }

  if (!already.includes(access)) {
    already.push(access);
  }
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

/**
 * How a report spells this store: `aws.dynamodb:editions#by-publication`.
 * The formula is the protocol's own `displayLabel` in `@suss/ir-core`,
 * so a reader who types the key back and this pass's index agree.
 * Returns null for semantics from any other protocol.
 */
export function storageBoundaryKey(semantics: Semantics): string | null {
  return semantics.name === "storage" ? keyOf(semantics) : null;
}

const keyOf = storageLabel;
const containerLabel = storageContainerLabel;

/**
 * Two containers, both declared under a name covering what one access
 * reached, and neither states more of itself than the other.
 */
function makeAmbiguousContainerFinding(
  access: StorageAccessRecord,
  reached: string,
  choice: NameChoice<DeclaredContainer>,
): Finding {
  const tied = choice.tied;
  const first = tied[0] as NameCandidate<DeclaredContainer>;
  const spelled = tied.map((candidate) => `"${candidate.name}"`).join(", ");
  return {
    kind: "ambiguousProvider",
    boundary: access.effect.binding,
    provider: makeSide(first.subject.summary),
    consumer: makeSide(access.summary, access.transitionId),
    description: `${access.summary.identity.name} reaches "${reached}" on ${access.semantics.storageSystem}, and ${tied.length} declared containers cover it (${spelled}). Each states as much of its own name as the other, so nothing in this run settles which one the code reaches. The access pairs with none of them, rather than reporting fields and selectors against a container it never touches.`,
    severity: "warning",
  };
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

/**
 * Both unused findings rest on a query asking for the field, which is
 * the only read either of them can see.
 */
function askedForNote(field: string, verdict: string): string {
  return `suss counts a column as read only when a query selects it, so before you treat ${verdict}, look for code that takes "${field}" off a record it already fetched.`;
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
    description: `${containerLabel(semantics)} declares "${field}". No query here reads it and nothing writes to it. ${askedForNote(field, "the column as dead")}`,
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
    description: `${containerLabel(semantics)} declares "${field}" and code here writes to it, but no query reads it. ${askedForNote(field, "the write as pointless")}`,
    severity: "warning",
  };
}
