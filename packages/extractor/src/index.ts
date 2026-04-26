// @suss/extractor — assembly engine

import { createHash } from "node:crypto";

import type {
  BehavioralSummary,
  BoundaryBinding,
  CodeUnitKind,
  ConfidenceInfo,
  Effect,
  Gap,
  Input,
  Output,
  Predicate,
  RenderNode,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";

export { httpRouteDiscovery } from "./packHelpers.js";

export type {
  BindingExtraction,
  ContractPattern,
  DiscoveredSubUnit,
  DiscoveredSubUnitParent,
  DiscoveryMatch,
  DiscoveryPattern,
  InputMappingPattern,
  InvocationRecognizer,
  PatternPack,
  ResponsePropertyMapping,
  ResponsePropertyMeaning,
  TerminalExtraction,
  TerminalMatch,
  TerminalPattern,
} from "./framework.js";

// =============================================================================
// RawCodeStructure — the interface between language adapters and the engine
// =============================================================================

export interface RawParameter {
  name: string;
  position: number;
  role: string;
  typeText: string | null;
}

export interface RawCondition {
  sourceText: string;
  structured: Predicate | null;
  polarity: "positive" | "negative";
  source: "explicit" | "earlyReturn" | "earlyThrow" | "catchBlock";
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
  /** For render terminals: the component being rendered */
  component: string | null;
  /**
   * For render terminals (JSX / component-tree output): the nested
   * render tree if the pack's extractor can produce one. Flows
   * through to `Output.render.root`. Absent when the extractor sees
   * only the root element name or opted out of tree extraction.
   */
  renderTree: RenderNode | null;
  /** For delegate terminals: where control is passed */
  delegateTarget: string | null;
  /** For emit terminals: the event/channel name */
  emitEvent: string | null;
  location: { start: number; end: number };
}

/**
 * A structured capture of an invocation argument. Literal values
 * (string, number, boolean), object/array literals, template literals,
 * identifier references, and nested call expressions are all captured
 * as structured variants so readers can see *what* was passed even when
 * the runtime value isn't statically resolvable. `null` is reserved for
 * the rare case where the argument shape doesn't match any variant
 * (type assertions with computed operands, arithmetic, etc.) — the
 * caller still knows how many arguments the call had.
 *
 * Useful for recognising literal-string discriminators like
 * `findings.push({ kind: "scenarioCoverageGap" })` or
 * `dispatch({ type: "USER_LOGGED_IN" })` at the summary level, and for
 * preserving argument *shape* (`{ userId, count }`, `getUser(id)`) so
 * downstream consumers (AI agents, error-taxonomy tooling,
 * release-note generators) can reason about composition without
 * re-reading source.
 */
export type EffectArg =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "object"; fields: Record<string, EffectArg> }
  | { kind: "array"; items: EffectArg[] }
  /**
   * Template literal with interpolation (`` `Error: ${e.message}` ``).
   * The resolved runtime value is unknown, but the source text is
   * preserved so readers can see which variables compose it — useful
   * for log messages, computed keys, and dedup-style key builders.
   */
  | { kind: "template"; sourceText: string }
  /**
   * Identifier reference — a bare variable (`userId`), a property-access
   * chain (`user.profile.email`, `process.env.DATABASE_URL`), or an
   * element-access chain (`config["host"]`). `name` holds the full
   * source text so readers can tell which binding flowed into the call
   * without inferring it from context. Identifiers that resolve to a
   * module-level `const` with a simple initializer (literal, process.env
   * access, etc.) are inlined to the initializer's EffectArg form so
   * closure-over-constants doesn't hide the actual value at call sites.
   */
  | { kind: "identifier"; name: string }
  /**
   * Nested call expression passed as an argument — `log(formatError(e))`,
   * `enqueue(buildPayload(ctx))`, inline composition. `callee` is the
   * source text of the call target; `args` recurses with bounded depth,
   * so `formatError(e)` reads as `{ callee: "formatError", args: [...] }`
   * rather than an opaque null.
   */
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
      /**
       * Ancestor if/switch/ternary conditions that gate reaching this
       * call. Populated for calls nested inside conditional blocks or
       * loop bodies; empty for top-level (always-fires) calls.
       * Converts to `Effect.preconditions: Predicate[]` in the IR —
       * same RawCondition → Predicate pipeline transitions use.
       */
      preconditions?: RawCondition[];
    }
  | { type: "emission"; event: string }
  | { type: "stateChange"; variable: string };

export interface RawBranch {
  conditions: RawCondition[];
  terminal: RawTerminal;
  effects: RawEffect[];
  /**
   * Pre-typed `Effect`s emitted by `PatternPack.invocationRecognizers`.
   * Bypass the `RawEffect → Effect` conversion that `effects` runs
   * through — recognizers have full structural knowledge of what
   * they're emitting (e.g. `storageAccess` with table/fields/selector)
   * and there's no narrower extractor-side representation worth
   * round-tripping through. Concatenated with converted `effects` at
   * `assembleSummary` time.
   */
  extraEffects?: Effect[];
  location: { start: number; end: number };
  isDefault: boolean;
  /**
   * Shape of upstream data the code unit reads within this branch.
   * Populated by the adapter for client/consumer code units: after
   * branching on a response status, the consumer accesses fields on
   * the response body — those accesses are collected into a TypeShape.
   * The extractor copies this through to Transition.expectedInput.
   */
  expectedInput?: TypeShape | null;
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
    /**
     * Structured body schema the contract declares for this status code.
     * Populated when the adapter can statically resolve the response schema
     * (e.g. `c.type<T>()`'s type argument). Null when the contract exists
     * but no body was declared or the schema form isn't yet supported.
     */
    body?: TypeShape | null;
  }>;
  params?: Record<string, { type: string; required: boolean }>;
  /**
   * Relationship between this declared contract and the `transitions[]`
   * on the same summary:
   *
   *   - "derived": both are extracted from the same source data, so
   *     comparing them against each other is tautological. Example: an
   *     OpenAPI stub's contract and its transitions both come from the
   *     operation's `responses` block. The cross-boundary checker
   *     skips per-summary contract-consistency for these.
   *
   *   - "independent": the contract is a separate statement from the
   *     transitions. Example: a ts-rest handler whose router declares
   *     `responses` and whose implementation is a separate function;
   *     a CFN stub whose `MethodResponses` and integration config are
   *     independent template fields. Contract-consistency comparison
   *     is meaningful.
   *
   * Defaults to "independent" when a pack doesn't say — safer to
   * surface a spurious-but-investigable finding than to silently drop
   * a real one.
   */
  provenance?: "derived" | "independent";
}

export interface RawCodeStructure {
  identity: {
    name: string;
    kind: CodeUnitKind;
    file: string;
    range: { start: number; end: number };
    exportName: string | null;
    exportPath: string[] | null;
  };
  /**
   * Three-layer boundary description (`transport`, `semantics`,
   * `recognition`). See `@suss/behavioral-ir`'s `BoundaryBinding`.
   * Null when the unit participates in no cross-unit boundary —
   * helpers, pure utilities, and anything the adapter can't place.
   */
  boundaryBinding: BoundaryBinding | null;
  parameters: RawParameter[];
  branches: RawBranch[];
  dependencyCalls: RawDependencyCall[];
  declaredContract: RawDeclaredContract | null;
  /**
   * Names of pack-declared response properties whose semantics is `body`.
   * For client units this records the accessor a consumer uses to reach the
   * body (e.g. ["data"] for axios, ["body","json","text"] for fetch). Carried
   * through to `summary.metadata.http.bodyAccessors` so the cross-boundary
   * checker can unwrap consumer expectedInput correctly without knowing each
   * pack. Flat here because this is the adapter→extractor plumbing contract;
   * nesting under `http` happens when the summary is assembled.
   */
  bodyAccessors?: string[];
  /**
   * Names of pack-declared response properties whose semantics is
   * `statusCode`. Same shape as `bodyAccessors` but for the status side —
   * lets the checker recognise pack-specific names (e.g. fetch's `status`,
   * axios's `status`, hypothetical `responseStatus`) when matching consumer
   * branch conditions to provider transitions. Carried through to
   * `summary.metadata.http.statusAccessors`.
   */
  statusAccessors?: string[];
  /**
   * Raw GraphQL document source attached to consumer-side graphql
   * summaries (the inner text of a `useQuery(gql\`...\`)` call).
   * Assembled into `summary.metadata.graphql.document` for the
   * checker's pairing layer to parse. Deliberately untouched here —
   * the extractor has no dependency on graphql-js; parsing happens
   * at check time.
   */
  graphqlDocument?: string;
  /**
   * Raw GraphQL schema SDL attached to provider-side resolver
   * summaries. For schema-first stubs (AppSync), the SDL IS the
   * schema. For code-first frameworks (Apollo Server), the SDL
   * comes from the `typeDefs` config option when statically
   * resolvable. Surfaced as `summary.metadata.graphql.schemaSdl`
   * so the checker can use the return-type field set when pairing
   * nested consumer selections.
   */
  graphqlSchemaSdl?: string;
}

// =============================================================================
// Extractor options
// =============================================================================

export interface ExtractorOptions {
  gapHandling: "strict" | "permissive" | "silent";
}

const DEFAULT_OPTIONS: ExtractorOptions = { gapHandling: "permissive" };

// =============================================================================
// Transition identity
//
// Transition IDs must survive branch reordering and the addition of unrelated
// branches — otherwise `diffSummaries` devolves into "everything changed"
// every time a handler is reshuffled.
//
// Identity is built from stable, content-addressable signals:
//   - the enclosing function name,
//   - the terminal kind (response / throw / return / ...),
//   - the status code (literal value, dynamic source text, or "none"),
//   - a short hash of the condition chain's source texts.
//
// Reordering branches leaves IDs intact. Editing a branch's body (without
// changing its guards or status) also leaves the ID intact, so diffSummaries
// correctly reports a "changed" transition rather than add+remove. Changing
// any signal — status code, condition text, terminal kind — mints a new ID.
// =============================================================================

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

  // Order-preserving join: short-circuit semantics make condition order
  // part of a branch's identity.
  const conditionSig = branch.conditions
    .map((c) => `${c.polarity}:${c.sourceText}`)
    .join(";");

  const conditionHash = createHash("sha1")
    .update(conditionSig)
    .digest("hex")
    .slice(0, 7);

  return `${functionName}:${terminal.kind}:${statusKey}:${conditionHash}`;
}

// =============================================================================
// Core assembly function
// =============================================================================

export function assembleSummary(
  raw: RawCodeStructure,
  options: ExtractorOptions = DEFAULT_OPTIONS,
): BehavioralSummary {
  const transitions: Transition[] = raw.branches.map((branch) => {
    // Conditions with structured: null become opaque predicates — never silently dropped.
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
  return {
    kind: raw.identity.kind,
    location: {
      file: raw.identity.file,
      range: raw.identity.range,
      exportName: raw.identity.exportName,
    },
    identity: {
      name: raw.identity.name,
      exportPath: raw.identity.exportPath,
      boundaryBinding: raw.boundaryBinding ?? null,
    },
    inputs,
    transitions,
    gaps,
    confidence,
    ...(metadata !== null ? { metadata } : {}),
  };
}

/**
 * Assemble summary-level metadata, namespaced by semantics family.
 * `metadata.http.*` for REST shapes (declared contracts, body/status
 * accessors); `metadata.graphql.*` for GraphQL shapes (operation
 * documents, eventually per-variable type info). See
 * `docs/boundary-semantics.md` for the broader model — each semantics
 * gets its own metadata key space so they can evolve independently.
 */
function buildMetadata(raw: RawCodeStructure): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {};
  const http = buildHttpMetadata(raw);
  if (http !== null) {
    metadata.http = http;
  }
  const graphql = buildGraphqlMetadata(raw);
  if (graphql !== null) {
    metadata.graphql = graphql;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function buildHttpMetadata(
  raw: RawCodeStructure,
): Record<string, unknown> | null {
  const http: Record<string, unknown> = {};
  if (raw.declaredContract !== null) {
    http.declaredContract = raw.declaredContract;
  }
  if (raw.bodyAccessors !== undefined && raw.bodyAccessors.length > 0) {
    http.bodyAccessors = raw.bodyAccessors;
  }
  if (raw.statusAccessors !== undefined && raw.statusAccessors.length > 0) {
    http.statusAccessors = raw.statusAccessors;
  }
  return Object.keys(http).length > 0 ? http : null;
}

function buildGraphqlMetadata(
  raw: RawCodeStructure,
): Record<string, unknown> | null {
  const graphql: Record<string, unknown> = {};
  if (raw.graphqlDocument !== undefined) {
    graphql.document = raw.graphqlDocument;
  }
  if (raw.graphqlSchemaSdl !== undefined) {
    graphql.schemaSdl = raw.graphqlSchemaSdl;
  }
  return Object.keys(graphql).length > 0 ? graphql : null;
}

// =============================================================================
// Gap detection
// =============================================================================

export function detectGaps(
  raw: RawCodeStructure,
  transitions: Transition[],
  options: ExtractorOptions,
): Gap[] {
  if (options.gapHandling === "silent") {
    return [];
  }

  const gaps: Gap[] = [];

  if (raw.declaredContract) {
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

    // Declared but never produced
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

    // Produced but never declared — contract violation
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

export function assessConfidence(raw: RawCodeStructure): ConfidenceInfo {
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
    // When the framework pack extracts a status code from the thrown value
    // (e.g., Express error middleware converting `throw new HttpError(404)`
    // to a 404 response), the throw is behaviorally a response — the client
    // sees an HTTP status code, not an exception. Convert to a response
    // output so the checker counts it as a produced status.
    if (t.statusCode) {
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

/**
 * Convert a RawCondition (adapter-level, carries structured Predicate
 * when available or source-text fallback) to the IR's Predicate shape.
 * Mirrors the conversion used for transition conditions — opaque fallback
 * when structured is null, negation wrapper when polarity is negative.
 */
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
  // Narrow then dispatch — the Extract<...> in EffectConverters ensures
  // each converter receives its exact variant.
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
