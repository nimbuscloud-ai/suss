/**
 * The assembly engine: a `RawCodeStructure` from a language adapter goes in,
 * a `BehavioralSummary` comes out. The package README explains where that step
 * fits in the pipeline.
 *
 * Two things surprise people reading this file. First, `RawCodeStructure` and
 * the raw types around it are the contract every adapter and pack implements,
 * so a field added here is a change to that contract. Second, this is the only
 * module allowed to turn a `Reading` into a claim on a summary; adapters hand
 * readings over uncollapsed and the rule for collapsing them lives here.
 */

import { createHash } from "node:crypto";

import {
  exchangesHttpResponses,
  withGraphqlMetadata,
  withHttpMetadata,
  withSourceDocumentMetadata,
} from "@suss/behavioral-ir";

import { inputReadsOf } from "./inputReads.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  CodeUnitKind,
  ConfidenceInfo,
  DeployableUnit,
  Effect,
  Gap,
  GraphqlDeclaredContract,
  GraphqlMetadata,
  HttpMetadata,
  Input,
  Output,
  Predicate,
  RenderNode,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";
import type { FailureDelivery } from "./framework.js";
import type { ConditionSource } from "./paths/structuredStatement.js";
import type { DefaultedReading, Reading } from "./reading.js";

export {
  httpRouteDiscovery,
  type RegistrationHelper,
  registrationHelperDiscovery,
  unwrapJsonStringify,
} from "./packHelpers.js";
export {
  enumerateOrDegrade,
  enumerateStructuredPaths,
  PathBudgetExceeded,
  UnmodeledFlow,
} from "./paths/enumeratePaths.js";
export { sharedGatingConditions } from "./paths/gatingConditions.js";
export { IdMap, IdSet } from "./paths/nodeIdentity.js";
export {
  absentReading,
  ambiguousReading,
  andThenReading,
  firstWrittenReading,
  mapReading,
  unreadableReading,
  valueToReadFurtherFrom,
  writtenReading,
} from "./reading.js";

export type {
  AccessRecognizer,
  BindingExtraction,
  ContractPattern,
  DeclaredMatch,
  DiscoveredCustomUnit,
  DiscoveredSubUnit,
  DiscoveredSubUnitParent,
  DiscoveryMatch,
  DiscoveryPattern,
  FailureDelivery,
  InputMappingPattern,
  InvocationRecognizer,
  PackDeclarations,
  PatternPack,
  ResponsePropertyMapping,
  ResponsePropertyMeaning,
  TerminalExtraction,
  TerminalMatch,
  TerminalPattern,
  TransparentWrapper,
} from "./framework.js";
export type { LanguageAdapter } from "./languageAdapter.js";
export type {
  StructuredPathConditionsInput,
  StructuredPathConditionsResult,
} from "./paths/enumeratePaths.js";
export type { Identified } from "./paths/nodeIdentity.js";
export type {
  CaseGroup,
  ConditionHandle,
  ConditionInfo,
  ConditionSource,
  ExitKind,
  LoweredStatementParts,
  StatementBlock,
  StructuredStatement,
} from "./paths/structuredStatement.js";
export type {
  ChosenReading,
  DefaultedReading,
  Reading,
  SourceRange,
} from "./reading.js";

// =============================================================================
// RawCodeStructure: what a language adapter hands the engine
// =============================================================================

export interface RawParameter {
  name: string;
  position: number;
  /**
   * What the parameter is for, in the library's own vocabulary. When the
   * adapter could not tell, this is null rather than a guess, and the reason
   * goes in `readings`.
   */
  role: string | null;
  typeText: string | null;
}

export interface RawCondition {
  sourceText: string;
  structured: Predicate | null;
  polarity: "positive" | "negative";
  source: ConditionSource;
}

export interface RawTerminal {
  kind:
    | "response"
    | "throw"
    | "return"
    | "render"
    | "delegate"
    | "emit"
    | "void";
  statusCode:
    | { type: "literal"; value: number }
    | { type: "dynamic"; sourceText: string }
    | null;
  body: { typeText: string | null; shape: TypeShape | null } | null;
  exceptionType: string | null;
  message: string | null;
  /** Set on a throw whose pack declared the thrown status is the wire response. */
  producesResponse?: boolean;
  component: string | null;
  /** Null when the pack read only the root element name, not the tree under it. */
  renderTree: RenderNode | null;
  delegateTarget: string | null;
  emitEvent: string | null;
  location: { start: number; end: number };
}

/**
 * An invocation argument as the adapter read it. An argument that fits none of
 * these variants, arithmetic for instance, comes through as null instead of
 * being dropped, so a reader still knows how many arguments the call had.
 */
export type EffectArg =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "object"; fields: Record<string, EffectArg> }
  /**
   * The element shapes the adapter could read, which is not always one
   * per runtime element. An array a callback builds,
   * `tags.map((tag) => ({ name: tag }))`, arrives with a single item,
   * because every element it produces has that one shape.
   */
  | { kind: "array"; items: EffectArg[] }
  | { kind: "template"; sourceText: string }
  /**
   * A bare variable or a whole access chain, written out as it appears. An
   * identifier bound to a module-level const with a simple initializer is
   * replaced by that initializer, so a constant does not hide the value.
   */
  | { kind: "identifier"; name: string }
  | { kind: "call"; callee: string; args: EffectArg[] }
  | null;

export type RawEffect =
  | {
      type: "mutation";
      target: string;
      operation: "create" | "update" | "delete";
    }
  | {
      type: "invocation";
      callee: string;
      args: EffectArg[];
      async: boolean;
      /** Empty means the call always fires, not that nobody looked. */
      preconditions?: RawCondition[];
    }
  | { type: "emission"; event: string }
  | { type: "stateChange"; variable: string };

export interface RawBranch {
  conditions: RawCondition[];
  terminal: RawTerminal;
  effects: RawEffect[];
  /**
   * Effects a recognizer built itself, already in IR form, so these skip the
   * `RawEffect` conversion that `effects` goes through.
   */
  extraEffects?: Effect[];
  location: { start: number; end: number };
  isDefault: boolean;
  /** The fields a consumer reads off a response inside this branch. */
  expectedInput?: TypeShape | null;
  /**
   * An adapter that passes its reading along uncollapsed sets this instead of
   * `terminal.statusCode`. A status nobody wrote then becomes a claim only
   * where a pack declared the default.
   */
  statusCodeReading?: DefaultedReading<number>;
  /**
   * Set instead of `terminal.body.shape`, on the same terms.
   * `terminal.body.typeText` is left alone, so a pack that gives the type as
   * text and also reads its structure can do both.
   */
  bodyShapeReading?: DefaultedReading<TypeShape>;
}

function valuesOfOutput(output: Transition["output"]): ValueRef[] {
  if (output.type === "response" && output.statusCode !== null) {
    return [output.statusCode];
  }
  return [];
}

export interface RawDependencyCall {
  name: string;
  assignedTo: string | null;
  async: boolean;
  returnType: string | null;
  location: { start: number; end: number };
}

export interface RawDeclaredContract {
  framework: string;
  responses: Array<{
    statusCode: number;
    /** Null means either the contract declared no body or suss could not read
     * the schema form, and nothing here tells the two apart. */
    body?: TypeShape | null;
  }>;
  params?: Record<string, { type: string; required: boolean }>;
  /**
   * "derived" means the contract and the transitions both come from the same
   * source, so comparing them proves nothing and the checker skips it. A pack
   * that says nothing gets "independent", which risks a spurious finding
   * rather than dropping a valid one.
   */
  provenance?: "derived" | "independent";
}

/**
 * What the adapter found where a unit's body should be. Downstream this is the
 * difference between a summary that says nothing because there was nothing to
 * say and one that says nothing because nobody could read the body.
 *
 * "absent" is a declaration with no body at all, such as an overload
 * signature. "empty" is a body with nothing in it, which an empty summary
 * describes completely. "statements" is a body with work in it, which an empty
 * summary describes none of. "elsewhere" is a body this run did not read: a
 * route registered with a handler the caller supplies points at no function to
 * go look in.
 */
export type BodyContent = "absent" | "empty" | "statements" | "elsewhere";

export interface RawCodeStructure {
  /** Types the unit's shapes refer to by name instead of spelling out, so a
   * reader who follows one of those names has somewhere to look. */
  definitions?: Record<string, TypeShape> | null;
  identity: {
    name: string;
    nameKind?: "binding" | "label";
    kind: CodeUnitKind;
    file: string;
    range: { start: number; end: number };
    exportName: string | null;
    exportPath: string[] | null;
  };
  /** Null when the unit is not on any cross-unit boundary, which is the
   * ordinary case for helpers and pure utilities. */
  boundaryBinding: BoundaryBinding | null;
  deployableUnit?: DeployableUnit;
  parameters: RawParameter[];
  branches: RawBranch[];
  /** Return statements no terminal in the pack matched. Leave this at zero and
   * a handler the pack cannot describe looks like one that returns nothing. */
  unmatchedReturns?: number;
  /**
   * Only the adapter can tell a body nobody could read from a body with
   * nothing in it, and an empty summary looks the same either way.
   */
  bodyContent?: BodyContent;
  dependencyCalls: RawDependencyCall[];
  declaredContract: RawDeclaredContract | null;
  /** The property a consumer goes through to get at the body, `data` for
   * axios say, so the checker can unwrap it without knowing each pack. */
  bodyAccessors?: string[];
  /** The same, for the status: `status` for fetch and for axios. */
  statusAccessors?: string[];
  /** The same, for the success flag: `ok` for fetch, nothing for axios. */
  successAccessors?: string[];
  /** Whether this client's non-2xx arrives as a response or a rejection. */
  failureDelivery?: FailureDelivery;
  /** Left exactly as written, because the extractor does not depend on
   * graphql-js. The parsing happens at check time. */
  graphqlDocument?: string;
  graphqlSchemaSdl?: string;
  /** The document this unit was read out of, when something else read out of
   * the same document states what this one relies on. */
  sourceDocumentLabel?: string;
  /** The extractor cannot derive this. An adapter that has the SDL and knows
   * which field the resolver serves fills it in. */
  graphqlDeclaredContract?: GraphqlDeclaredContract;
  /** Fragment spreads in `graphqlDocument` with no definition in it, so a
   * partially read document is marked rather than passed off as whole. */
  graphqlUnresolvedFragments?: string[];
  /** Set when a document reference was recognized but its body could not be
   * read, so an unreadable document is accounted for instead of dropped. */
  graphqlUnresolvedDocument?: { reference: string; reason: string };
  /**
   * Which part of the boundary the source does not state, and why. The binding
   * still goes out with that part empty, so the unit pairs with nothing rather
   * than with whatever a guess would have supplied. It comes out as an
   * `unreadOutcome` gap, so no checker counts it against the unit.
   */
  unreadBinding?: string;
  /**
   * Readings the adapter passed along without collapsing. This module writes
   * the reason for any that came back unreadable or ambiguous. Written and
   * absent readings contribute nothing here, since what they found is already
   * on the summary.
   */
  readings?: readonly Reading<unknown>[];
}

// =============================================================================
// Extractor options
// =============================================================================

export interface ExtractorOptions {
  gapHandling: "strict" | "permissive" | "silent";
}

const DEFAULT_OPTIONS: ExtractorOptions = { gapHandling: "permissive" };

/**
 * The id for one branch's transition, built so that editing a handler does not
 * churn it. Reordering branches, or adding an unrelated one, must leave the
 * existing ids alone, otherwise `diffSummaries` reports "everything changed"
 * every time somebody shuffles a handler around.
 *
 * The id combines the enclosing function name, the terminal kind, the status
 * code (a literal value, the source text of a dynamic one, or "none"), and a
 * short hash of the condition chain's source texts. Editing a branch's body
 * without touching its guards or its status leaves the id alone, so a diff
 * reports one changed transition instead of an add plus a remove. Change any
 * of those signals and you get a new id.
 */
export function makeTransitionId(
  functionName: string,
  branch: RawBranch,
): string {
  const { terminal } = branch;

  const statusKey =
    terminal.statusCode === null
      ? "none"
      : terminal.statusCode.type === "literal"
        ? String(terminal.statusCode.value)
        : `dyn:${terminal.statusCode.sourceText}`;

  // Short-circuiting makes condition order part of a branch's identity.
  const conditionSig = branch.conditions
    .map((c) => `${c.polarity}:${c.sourceText}`)
    .join(";");

  const conditionHash = createHash("sha1")
    .update(conditionSig)
    .digest("hex")
    .slice(0, 7);

  return `${functionName}:${terminal.kind}:${statusKey}:${conditionHash}`;
}

/**
 * What follows is the one place a `Reading` turns into a field on a summary,
 * and the rule is fixed. A written reading becomes a claim. An absent one
 * takes a default only where the pack declared that default as data, so the
 * value is library-defined and shows up somewhere review will see it.
 * Unreadable and ambiguous readings claim nothing and report their reason as
 * a gap instead.
 *
 * None of this is exported. Callers compose readings with the combinators in
 * reading.ts, and the only way to get a value they can claim is to hand the
 * reading over to this module.
 */
type ReadingCollapse<T, R> = {
  [K in Reading<T>["kind"]]: (reading: Extract<Reading<T>, { kind: K }>) => R;
};

function collapseReading<T, R>(
  table: ReadingCollapse<T, R>,
  reading: Reading<T>,
): R {
  return (table[reading.kind] as (r: Reading<T>) => R)(reading);
}

/**
 * What the source wrote, or the pack's declared default when it wrote
 * nothing. A reading nobody could resolve claims nothing.
 */
function claimedValue<T>(defaulted: DefaultedReading<T>): T | null {
  const table: ReadingCollapse<T, T | null> = {
    written: (r) => r.value,
    absent: () => defaulted.libraryDefault ?? null,
    unreadable: () => null,
    ambiguous: () => null,
  };
  return collapseReading(table, defaulted.reading);
}

/** Why a reading did not become a claim, in the sentence the gap will use.
 * Null when it did become one. */
function unreadReasonOf(reading: Reading<unknown>): string | null {
  const table: ReadingCollapse<unknown, string | null> = {
    written: () => null,
    absent: () => null,
    unreadable: (r) => r.reason,
    ambiguous: (r) => r.reason,
  };
  return collapseReading(table, reading);
}

function bodyWithClaimedShape(
  terminal: RawTerminal,
  reading: DefaultedReading<TypeShape>,
): RawTerminal["body"] {
  return {
    typeText: terminal.body?.typeText ?? null,
    shape: claimedValue(reading),
  };
}

/**
 * Collapse the readings before anything else looks at the branch, so the
 * transition's id and its output agree about what the branch returns.
 */
function branchWithCollapsedReadings(branch: RawBranch): RawBranch {
  const { statusCodeReading, bodyShapeReading } = branch;
  if (statusCodeReading === undefined && bodyShapeReading === undefined) {
    return branch;
  }

  const status =
    statusCodeReading !== undefined ? claimedValue(statusCodeReading) : null;
  return {
    ...branch,
    terminal: {
      ...branch.terminal,
      ...(statusCodeReading !== undefined
        ? {
            statusCode:
              status !== null ? { type: "literal", value: status } : null,
          }
        : {}),
      ...(bodyShapeReading !== undefined
        ? { body: bodyWithClaimedShape(branch.terminal, bodyShapeReading) }
        : {}),
    },
  };
}

/** Ordered so that the gap sentences they produce come out in a sensible
 * order. */
function readingsOfBranch(branch: RawBranch): Reading<unknown>[] {
  return [
    ...(branch.bodyShapeReading !== undefined
      ? [branch.bodyShapeReading.reading]
      : []),
    ...(branch.statusCodeReading !== undefined
      ? [branch.statusCodeReading.reading]
      : []),
  ];
}

function unreadSentences(raw: RawCodeStructure): string[] {
  const handedOver: Reading<unknown>[] = [
    ...(raw.readings ?? []),
    ...raw.branches.flatMap(readingsOfBranch),
  ];

  return [
    ...(raw.unreadBinding !== undefined ? [raw.unreadBinding] : []),
    ...handedOver
      .map(unreadReasonOf)
      .filter((reason): reason is string => reason !== null),
  ];
}

export function assembleSummary(
  raw: RawCodeStructure,
  options: ExtractorOptions = DEFAULT_OPTIONS,
): BehavioralSummary {
  const transitions: Transition[] = raw.branches.map((rawBranch) => {
    const branch = branchWithCollapsedReadings(rawBranch);
    const conditions: Predicate[] = branch.conditions.map(
      rawConditionToPredicate,
    );

    const transition: Transition = {
      id: makeTransitionId(raw.identity.name, branch),
      conditions,
      output: terminalToOutput(branch.terminal),
      effects: [
        ...branch.effects.map(effectToIR),
        ...(branch.extraEffects ?? []),
      ],
      location: branch.location,
      isDefault: branch.isDefault,
    };
    if (branch.expectedInput != null) {
      transition.expectedInput = branch.expectedInput;
    }
    return transition;
  });

  const gaps = detectGaps(raw, transitions, options);
  const confidence = assessConfidence(raw);
  const inputs: Input[] = raw.parameters.map(paramToInput);

  const metadata = buildMetadata(raw);
  const reads = inputReadsOf({
    conditions: transitions.map((t) => t.conditions),
    values: transitions.flatMap((t) => valuesOfOutput(t.output)),
  });

  return {
    kind: raw.identity.kind,
    location: {
      file: raw.identity.file,
      range: raw.identity.range,
      exportName: raw.identity.exportName,
    },
    identity: {
      name: raw.identity.name,
      ...(raw.identity.nameKind !== undefined
        ? { nameKind: raw.identity.nameKind }
        : {}),
      exportPath: raw.identity.exportPath,
      boundaryBinding: raw.boundaryBinding ?? null,
      ...(raw.deployableUnit !== undefined
        ? { deployableUnit: raw.deployableUnit }
        : {}),
    },
    inputs,
    transitions,
    gaps,
    confidence,
    ...(reads.length > 0 ? { inputReads: reads } : {}),
    ...(raw.definitions !== undefined && raw.definitions !== null
      ? { definitions: raw.definitions }
      : {}),
    ...(metadata !== null ? { metadata } : {}),
  };
}

/** Each semantics family gets its own key space under `metadata`, so HTTP and
 * GraphQL can grow their metadata independently of each other. */
function buildMetadata(raw: RawCodeStructure): Record<string, unknown> | null {
  let metadata: Record<string, unknown> = {};
  const http = buildHttpMetadataValue(raw);
  if (http !== null) {
    metadata = withHttpMetadata(metadata, http);
  }
  const graphql = buildGraphqlMetadataValue(raw);
  if (graphql !== null) {
    metadata = withGraphqlMetadata(metadata, graphql);
  }
  if (raw.sourceDocumentLabel !== undefined) {
    metadata = withSourceDocumentMetadata(metadata, {
      label: raw.sourceDocumentLabel,
    });
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function buildHttpMetadataValue(raw: RawCodeStructure): HttpMetadata | null {
  const http: HttpMetadata = {};
  if (raw.declaredContract !== null) {
    // The schema's default only kicks in inside `withHttpMetadata`'s parse, so
    // spelling it out here keeps this object's static type matching what the
    // parse will produce.
    http.declaredContract = {
      framework: raw.declaredContract.framework,
      responses: raw.declaredContract.responses,
      provenance: raw.declaredContract.provenance ?? "independent",
    };
  }
  // Spelled out one field at a time, rather than looped over a list of
  // names, because `check:metadata-wiring` finds a writer by reading
  // these assignments and a computed key hides all three from it.
  if (raw.bodyAccessors !== undefined && raw.bodyAccessors.length > 0) {
    http.bodyAccessors = raw.bodyAccessors;
  }
  if (raw.statusAccessors !== undefined && raw.statusAccessors.length > 0) {
    http.statusAccessors = raw.statusAccessors;
  }
  if (raw.successAccessors !== undefined && raw.successAccessors.length > 0) {
    http.successAccessors = raw.successAccessors;
  }
  if (raw.failureDelivery !== undefined) {
    http.failureDelivery = raw.failureDelivery;
  }
  return Object.keys(http).length > 0 ? http : null;
}

function buildGraphqlMetadataValue(
  raw: RawCodeStructure,
): GraphqlMetadata | null {
  const graphql: GraphqlMetadata = {};
  if (raw.graphqlDocument !== undefined) {
    graphql.document = raw.graphqlDocument;
  }
  if (raw.graphqlSchemaSdl !== undefined) {
    graphql.schemaSdl = raw.graphqlSchemaSdl;
  }
  if (raw.graphqlDeclaredContract !== undefined) {
    graphql.declaredContract = raw.graphqlDeclaredContract;
  }
  if (raw.graphqlUnresolvedFragments !== undefined) {
    graphql.unresolvedFragments = raw.graphqlUnresolvedFragments;
  }
  if (raw.graphqlUnresolvedDocument !== undefined) {
    graphql.unresolvedDocument = raw.graphqlUnresolvedDocument;
  }
  return Object.keys(graphql).length > 0 ? graphql : null;
}

// =============================================================================
// Gap detection
// =============================================================================

/**
 * A declared contract lists HTTP statuses, so comparing it against what a unit
 * produces only means something on an HTTP boundary. Without this, a
 * subscriber that declares a message structure gets told which of its statuses
 * the handler never produced. A unit with no binding keeps the comparison.
 */
function answersWithHttpResponses(raw: RawCodeStructure): boolean {
  if (raw.boundaryBinding === null || raw.boundaryBinding === undefined) {
    return true;
  }
  return exchangesHttpResponses(raw.boundaryBinding);
}

export function detectGaps(
  raw: RawCodeStructure,
  transitions: Transition[],
  options: ExtractorOptions,
): Gap[] {
  if (options.gapHandling === "silent") {
    return [];
  }

  const gaps: Gap[] = [];

  // Without this the summary comes out with no transition and no gap, which
  // looks like a function that does nothing rather than one nobody read.
  if (raw.unmatchedReturns !== undefined && raw.unmatchedReturns > 0) {
    const count = raw.unmatchedReturns;
    gaps.push({
      type: "unreadOutcome",
      conditions: [],
      consequence: "unknown",
      description:
        count === 1
          ? "One return in this function matches none of the terminal shapes this pack looks for, so what it produces is not described here"
          : `${count} returns in this function match none of the terminal shapes this pack looks for, so what they produce is not described here`,
    });
  }

  for (const sentence of unreadSentences(raw)) {
    gaps.push({
      type: "unreadOutcome",
      conditions: [],
      consequence: "unknown",
      description: sentence,
    });
  }

  const unreadBody = describeUnreadBody(raw);
  if (unreadBody !== null) {
    gaps.push({
      type: "unreadOutcome",
      conditions: [],
      consequence: "unknown",
      description: unreadBody,
    });
  }

  if (raw.declaredContract && answersWithHttpResponses(raw)) {
    const producedStatuses = new Set(
      transitions.flatMap((t) => {
        if (t.output.type !== "response") {
          return [];
        }
        const sc = t.output.statusCode;
        if (sc?.type === "literal") {
          return [sc.value as number];
        }
        return [];
      }),
    );
    const declaredStatuses = new Set(
      raw.declaredContract.responses.map((r) => r.statusCode),
    );

    for (const declared of declaredStatuses) {
      if (!producedStatuses.has(declared)) {
        gaps.push({
          type: "unhandledCase",
          conditions: [],
          consequence: "frameworkDefault",
          description: `Declared response ${declared} is never produced by the handler`,
        });
      }
    }

    for (const produced of producedStatuses) {
      if (!declaredStatuses.has(produced)) {
        gaps.push({
          type: "unhandledCase",
          conditions: [],
          consequence: "unknown",
          description: `Handler produces status ${produced} which is not declared in the ${raw.declaredContract.framework} contract`,
        });
      }
    }
  }

  return gaps;
}

// =============================================================================
// Confidence
// =============================================================================

/** True when a summary says nothing because of what the pack could read, not
 * because the unit does nothing. */
function bodyWentUnread(raw: RawCodeStructure): boolean {
  if (raw.bodyContent === "absent" || raw.bodyContent === "elsewhere") {
    return true;
  }
  return raw.bodyContent === "statements" && raw.branches.length === 0;
}

/** Why an empty summary is empty, in a sentence, or null when the summary is
 * not empty. The transitions on their own will never tell a reader this. */
function describeUnreadBody(raw: RawCodeStructure): string | null {
  if (!bodyWentUnread(raw)) {
    return null;
  }
  if (raw.bodyContent === "absent") {
    return "This unit is a declaration with no body behind it, so nothing about what it does was read here";
  }
  if (raw.bodyContent === "elsewhere") {
    return "The handler on this boundary comes from outside the code that registers it, so nothing about what it does was read here";
  }
  // Unmatched returns already say this, in more detail.
  if ((raw.unmatchedReturns ?? 0) > 0) {
    return null;
  }
  return "Nothing this unit's body does matches a shape this pack looks for, so what it does is not described here";
}

export function assessConfidence(raw: RawCodeStructure): ConfidenceInfo {
  // The condition ratio further down cannot catch either of these cases. A
  // function whose returns all went unread has no conditions either, and zero
  // opaque out of zero would come out as high confidence.
  if ((raw.unmatchedReturns ?? 0) > 0) {
    return { source: "inferred_static", level: "low" };
  }

  if (bodyWentUnread(raw)) {
    return { source: "inferred_static", level: "low" };
  }

  let total = 0;
  let opaque = 0;

  for (const branch of raw.branches) {
    for (const condition of branch.conditions) {
      total++;
      if (!condition.structured || condition.structured.type === "opaque") {
        opaque++;
      }
    }
  }

  const ratio = total === 0 ? 0 : opaque / total;
  const level: "high" | "medium" | "low" =
    ratio === 0 ? "high" : ratio < 0.5 ? "medium" : "low";

  return { source: "inferred_static", level };
}

// =============================================================================
// Mapping helpers
// =============================================================================

function bodyToShape(
  body: RawTerminal["body"] | null | undefined,
): TypeShape | null {
  if (!body) {
    return null;
  }
  if (body.shape !== null) {
    return body.shape;
  }
  if (body.typeText) {
    return { type: "ref", name: body.typeText };
  }
  return null;
}

const terminalConverters: Record<
  RawTerminal["kind"],
  (t: RawTerminal) => Output
> = {
  response: (t) => {
    const statusCode: ValueRef | null = t.statusCode
      ? t.statusCode.type === "literal"
        ? { type: "literal", value: t.statusCode.value }
        : { type: "unresolved", sourceText: t.statusCode.sourceText }
      : null;
    const body: TypeShape | null = bodyToShape(t.body);
    return { type: "response", statusCode, body, headers: {} };
  },
  throw: (t) => {
    // A response only when the pack declared that the framework turns
    // the thrown status into the wire response, never from the status
    // being present alone (#149).
    if (t.statusCode && t.producesResponse === true) {
      const statusCode: ValueRef =
        t.statusCode.type === "literal"
          ? { type: "literal", value: t.statusCode.value }
          : { type: "unresolved", sourceText: t.statusCode.sourceText };
      return {
        type: "response",
        statusCode,
        body: bodyToShape(t.body),
        headers: {},
      };
    }
    return {
      type: "throw",
      exceptionType: t.exceptionType,
      message: t.message,
    };
  },
  render: (t) => ({
    type: "render",
    component: t.component ?? "unknown",
    ...(t.renderTree !== null ? { root: t.renderTree } : {}),
  }),
  delegate: (t) => ({
    type: "delegate",
    to: t.delegateTarget ?? "unknown",
  }),
  emit: (t) => ({
    type: "emit",
    event: t.emitEvent ?? "unknown",
  }),
  return: (t) => ({
    type: "return",
    value: bodyToShape(t.body),
  }),
  void: (_t) => ({ type: "void" }),
};

export function terminalToOutput(terminal: RawTerminal): Output {
  return terminalConverters[terminal.kind](terminal);
}

/** A condition the adapter left unstructured becomes an opaque predicate
 * rather than being dropped, so the branch keeps its guard. */
function rawConditionToPredicate(c: RawCondition): Predicate {
  const pred: Predicate =
    c.structured !== null
      ? c.structured
      : {
          type: "opaque",
          sourceText: c.sourceText,
          reason: "complexExpression",
        };
  return c.polarity === "negative" ? { type: "negation", operand: pred } : pred;
}

type EffectConverters = {
  [K in RawEffect["type"]]: (e: Extract<RawEffect, { type: K }>) => Effect;
};

const effectConverters: EffectConverters = {
  mutation: (e) => ({
    type: "mutation",
    target: e.target,
    operation: e.operation,
  }),
  invocation: (e) => {
    const invocation: Extract<Effect, { type: "invocation" }> = {
      type: "invocation",
      callee: e.callee,
      args: e.args,
      async: e.async,
    };
    if (e.preconditions !== undefined && e.preconditions.length > 0) {
      invocation.preconditions = e.preconditions.map(rawConditionToPredicate);
    }
    return invocation;
  },
  emission: (e) => ({ type: "emission", event: e.event }),
  stateChange: (e) => ({ type: "stateChange", variable: e.variable }),
};

export function effectToIR(effect: RawEffect): Effect {
  return (effectConverters[effect.type] as (e: RawEffect) => Effect)(effect);
}

export function paramToInput(param: RawParameter): Input {
  return {
    type: "parameter",
    name: param.name,
    position: param.position,
    role: param.role,
    shape: param.typeText ? { type: "ref", name: param.typeText } : null,
  };
}

export type {
  AstCapableOps,
  CallOps,
  ConstructedFrom,
  DeclaredBy,
  OpsCarrier,
  ReceiverOrigin,
  UnsettledName,
  ValueEntry,
  ValueOps,
} from "./ops.js";
