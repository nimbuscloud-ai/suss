/**
 * Pairs declared stores (Prisma models, Drizzle tables, SQL DDL,
 * template resources) with the `storage-access` effects in code, keyed
 * by (storageSystem, scope, container, accessPath). It reports a field
 * the code reads or writes that the contract does not declare, a
 * declared field nothing reads or writes, and a selector the container
 * does not key on.
 *
 * Before any access is claimed, one written under a relation, such as
 * the select inside a Prisma `include`, is moved to the container the
 * relation reaches. When two containers' names both cover what an
 * access reached, the more specific one takes it. The storage README
 * explains each rule.
 */

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
  storageSystemLabel,
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
  /** The effect's storage semantics, narrowed once for the claim loop. */
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

    const readNames = new Set<string>();
    const writtenNames = new Set<string>();
    let anyDefaultShapeRead = false;
    let anyUnknownWrite = false;

    for (const access of inScope) {
      const fields = access.effect.interaction.fields;
      const kind = access.effect.interaction.kind;
      const wildcards = fields.includes(ALL_FIELDS);

      // A read that states no fields asks for the whole item. An access
      // path that copies only some fields returns what it has without an
      // error, so the caller silently gets an item with fields missing.
      if (
        wildcards &&
        kind === "read" &&
        fieldSetIsComplete &&
        semantics.accessPath !== null
      ) {
        findings.push(makeWholeItemFinding(provider, binding, access));
      }

      // A wildcard covers whatever the schema declares, so none of its
      // fields can be unknown.
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
      // on fails at the store, so it is reported before it runs.
      for (const field of selectorBeyondKey(contract, access)) {
        findings.push(
          makeSelectorMismatchFinding(provider, binding, access, field),
        );
      }

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
          // Nobody read the payload, so which columns this wrote is
          // unknown. Naming them all reports a column the database
          // sets as one this code writes.
          anyUnknownWrite = true;
        } else {
          for (const field of fields) {
            writtenNames.add(field);
          }
        }
      }
    }

    // A wildcard read may use any field, so the field checks are skipped.
    // So is a store no code in this run reaches, since a template read
    // alone would warn about every field of every table.
    if (!anyDefaultShapeRead && inScope.length > 0) {
      for (const field of contract.fields ?? []) {
        // The store computes a derived field, so nobody writes it and
        // neither check applies.
        if (field.derived === true) {
          continue;
        }
        const isRead = readNames.has(field.name);
        const isWritten = writtenNames.has(field.name);
        // An unknown write may have written this field, so nobody can
        // say it went unused.
        if (!isRead && !isWritten && !anyUnknownWrite) {
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
      // providersOf returns only summaries with a binding.
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
 * covers it, and the most specific of those takes it. When two are
 * equally specific, neither takes it and a finding says so.
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
 * The containers that could claim what one access reached. A tie comes
 * back for the caller to report.
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
  return mostSpecificName(statedEngineFirst(candidates, access));
}

/**
 * The candidates left once one of them states the engine the access
 * uses. A store with no engine on it covers an access on any of them,
 * so it gives way to one declared on the engine the access uses, the
 * same way a name stating more of itself wins over one with a hole.
 */
function statedEngineFirst(
  candidates: NameCandidate<DeclaredContainer>[],
  access: StorageAccessRecord,
): NameCandidate<DeclaredContainer>[] {
  const agreeing: NameCandidate<DeclaredContainer>[] = [];
  for (const candidate of candidates) {
    if (enginesMatch(candidate.subject.semantics, access.semantics)) {
      agreeing.push(candidate);
    }
  }
  return agreeing.length === 0 ? candidates : agreeing;
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
      const resolved = keyWriteOn(containers, owner.container, relation);
      if (resolved === null || resolved.columns.length === 0) {
        continue;
      }
      const key = `${resolved.container ?? owner.name ?? ""}:${resolved.columns.join(",")}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const placed =
        resolved.container === null
          ? placedOn(access, owner)
          : movedTo(access, resolved.container);
      written.push(withFields(placed, resolved.columns));
    }
  }
  return written;
}

/** Where a key write lands, and the columns it fills there. */
interface KeyWrite {
  /** The container name to move the access to, or null to leave it where the relation's hops already placed it. */
  container: string | null;
  columns: string[];
}

/**
 * What a write through one field of a container changes. A relation
 * that declares a foreign key fills it here. An implicit many-to-many
 * fills both columns of its join table instead, since a `connect`,
 * `disconnect` or `set` there changes a row of that table rather than
 * a column of either model. A relation whose key lives on the far
 * side and declares no join table changes no column anywhere this
 * pass can see, so the write is dropped. A field the contract does
 * not call a relation is taken at its word as a column, so the
 * unknown-field check still reports one nobody declared.
 */
function keyWriteOn(
  containers: DeclaredContainer[],
  container: DeclaredContainer,
  field: string,
): KeyWrite | null {
  const declared = (container.contract.fields ?? []).find(
    (candidate) => candidate.name === field,
  );
  if (declared === undefined) {
    return { container: null, columns: [field] };
  }
  if (declared.relationKey !== undefined) {
    return { container: null, columns: declared.relationKey };
  }
  if (declared.joinContainer !== undefined) {
    return joinTableWrite(containers, declared.joinContainer);
  }
  if (relationTargetOf(containers, container, field) !== undefined) {
    return null;
  }
  return { container: null, columns: [field] };
}

/**
 * The write a `connect`, `disconnect` or `set` makes on the join table
 * behind an implicit many-to-many: every column the table declares,
 * since those columns are the row the operation adds, removes or
 * replaces. Null when nothing in the run declares that table.
 */
function joinTableWrite(
  containers: DeclaredContainer[],
  joinContainer: string,
): KeyWrite | null {
  const join = containers.find((candidate) =>
    candidate.names.includes(joinContainer),
  );
  if (join === undefined) {
    return null;
  }
  return {
    container: joinContainer,
    columns: (join.contract.fields ?? []).map((field) => field.name),
  };
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
 * providers that claim it, attributed the same way `checkStorage`
 * attributes findings. `suss ask` uses this for a question about a
 * deployed name, so the two never disagree on a pair.
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
    !enginesAgree(semantics, access.semantics) ||
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

/**
 * Whether a declared store and an access are about the same engine. A
 * store whose deploy configuration picks its engine from a variable
 * says which instance it is and not which engine, so it meets an access
 * on any of them. An access always records its own engine, since a
 * connection pool is for one product.
 */
function enginesAgree(
  declared: StorageSemantics,
  access: StorageSemantics,
): boolean {
  return declared.storageSystem === null || enginesMatch(declared, access);
}

/** Whether both sides give the same engine. */
function enginesMatch(
  declared: StorageSemantics,
  access: StorageSemantics,
): boolean {
  return declared.storageSystem === access.storageSystem;
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

/**
 * How a report writes this store: `aws.dynamodb:editions#by-publication`.
 * It is the storage protocol's `displayLabel` in `@suss/ir-core`, so a
 * key a reader types back matches this pass's index. Returns null for
 * semantics from any other protocol.
 */
export function storageBoundaryKey(semantics: Semantics): string | null {
  return semantics.name === "storage" ? keyOf(semantics) : null;
}

const keyOf = storageLabel;

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
    description: `${access.summary.identity.name} reaches "${reached}" on ${storageSystemLabel(access.semantics)}, and ${tied.length} declared containers cover it (${spelled}). Each states as much of its own name as the other, so nothing in this run settles which one the code reaches. The access pairs with none of them, rather than reporting fields and selectors against a container it never touches.`,
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
    description: `${access.summary.identity.name} ${verb} "${field}" on ${storageContainerLabel(semantics)} (${storageSystemLabel(semantics)}) but the contract declares no ${field} field.`,
    severity: "error",
  };
}

/** A read of a whole item through an access path that copies only some fields. */
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
    description: `${access.summary.identity.name} reads whole items through ${storageContainerLabel(semantics)} (${storageSystemLabel(semantics)}), which copies only the fields it declares, so anything else comes back absent and no error says so.`,
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
    description: `${access.summary.identity.name} picks items on ${storageContainerLabel(semantics)} by "${field}", which is not one of its key attributes (${keys}). ${storageSystemLabel(semantics)} refuses a request keyed on anything else, so this fails when it runs.`,
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
    description: `${storageContainerLabel(semantics)} declares "${field}". No query here reads it and nothing writes to it. ${askedForNote(field, "the column as dead")}`,
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
    description: `${storageContainerLabel(semantics)} declares "${field}" and code here writes to it, but no query reads it. ${askedForNote(field, "the write as pointless")}`,
    severity: "warning",
  };
}
