/**
 * The normalized intent form the checker compares against behavioral
 * summaries.
 *
 * The authoring schema is built to be easy to write, and this form is
 * built to be easy to check: boundaries as @suss/ir-core
 * `BoundaryBinding`s, body shapes as `TypeShape`s, and one flat
 * outcome list per boundary intent.
 */

import {
  type BoundaryBinding,
  type EffectRelation,
  EffectRelationSchema,
  functionCallBinding,
  messageBusBinding,
  restBinding,
  storageBinding,
  type TypeShape,
  unitInvocationBinding,
} from "@suss/ir-core";

import type {
  AuthoredInputField,
  AuthoredShape,
  BodyShape,
  Boundary,
  BoundaryIntent,
  DeclaredEffect,
  IntentDoc,
  IntentSource,
  Prd,
  PrimitiveTypeName,
  When,
  WhenClause,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Normalised types
// ---------------------------------------------------------------------------

/**
 * How a boundary outcome ends. `effect` is an outcome that declares
 * only what it did, which is what a queue consumer or a table writer
 * has to say instead of a status.
 */
export type IntentOutcomeKind = "response" | "return" | "throw" | "effect";

/** One effect an outcome has, in the verbs `suss ask` asks with. */
export interface IntentEffect {
  does: EffectRelation;
  /** The boundary it reaches, as the author wrote it. */
  names: string;
  /** The columns it touches. Empty when the doc states none. */
  fields: string[];
  /** What it picks the item out by. Empty when the doc states none. */
  by: string[];
}

/**
 * One clause of what a branch turned on. The checker compares a clause
 * whose subject is a boundary, and the rest are kept for a reader.
 */
export interface IntentCondition {
  /** The boundary the guard read, when the clause says one. */
  at: IntentEffect | null;
  /** What the caller sent, when the clause says that instead. */
  input: string | null;
  /** Whether the lookup came back with something, when the clause says. */
  finds: "nothing" | "something" | null;
  /** The clause as one line, for a finding to quote. */
  said: string;
}

export interface IntentOutcome {
  /** The id the author gave the outcome, which PRD scenarios link to. */
  id: string;
  /** What the branch turned on, as one line, for a reader. */
  when: string;
  /** The same, clause by clause, for the checker to compare. */
  conditions: IntentCondition[];
  kind: IntentOutcomeKind;
  /** Set only for `response` outcomes (REST status code). */
  status: number | null;
  /** Response / return body shape, when declared. */
  body: TypeShape | null;
  /** Error type name, set only for `throw` outcomes when declared. */
  errorType: string | null;
  /** The effects this outcome declares. Empty when it declares none. */
  effects: IntentEffect[];
}

/**
 * One field of the value the boundary is handed. Every spelling of
 * `receives` normalises to a list of these, so the checker has one pass
 * over the list and never looks at the boundary kind.
 */
export interface IntentInputField {
  /** `pair.provider` becomes `["pair", "provider"]`, a header `["headers", "x-tenant-id"]`. */
  path: string[];
  /** Null when the author named the field and said nothing else about it. */
  shape: TypeShape | null;
  required: boolean;
}

export interface BoundaryIntentSummary {
  kind: "boundary";
  name: string;
  purpose: string;
  audience: string;
  source: IntentSource;
  boundary: BoundaryBinding;
  /** Empty for a doc with no `receives` block, which states nothing about the input. */
  receives: IntentInputField[];
  outcomes: IntentOutcome[];
}

export interface PrdScenarioSummary {
  title: string | null;
  /** Condition, human terms. */
  when: string;
  /** Expected outcome, human terms. */
  expect: string;
  /** Qualified outcome refs (`<intent-name>.<outcome-id>`); empty when unlinked. */
  link: string[];
}

export interface PrdSummary {
  kind: "prd";
  title: string;
  purpose: string;
  audience: string;
  source: IntentSource;
  scenarios: PrdScenarioSummary[];
}

export type IntentSummary = BoundaryIntentSummary | PrdSummary;

// ---------------------------------------------------------------------------
// Transform: authored IntentDoc → normalised IntentSummary
// ---------------------------------------------------------------------------

export function intentDocToSummary(doc: IntentDoc): IntentSummary {
  if (doc.kind === "prd") {
    return prdToSummary(doc);
  }
  return boundaryIntentToSummary(doc);
}

function boundaryIntentToSummary(doc: BoundaryIntent): BoundaryIntentSummary {
  return {
    kind: "boundary",
    name: doc.name,
    purpose: doc.purpose,
    audience: doc.audience,
    source: doc.source,
    boundary: toBoundaryBinding(doc.boundary),
    receives: toReceives(doc.boundary),
    outcomes: doc.transitions.map(toOutcome),
  };
}

function prdToSummary(doc: Prd): PrdSummary {
  return {
    kind: "prd",
    title: doc.title,
    purpose: doc.purpose,
    audience: doc.audience,
    source: doc.source,
    scenarios: doc.scenarios.map((s) => ({
      title: s.title ?? null,
      when: s.when,
      expect: s.expect,
      link:
        s.link === undefined ? [] : Array.isArray(s.link) ? s.link : [s.link],
    })),
  };
}

// One constructor per protocol, each the ir-core one, so an intent
// boundary and a derived boundary are built by the same code.
const BINDINGS: {
  [K in Boundary["semantics"]]: (
    boundary: Extract<Boundary, { semantics: K }>,
  ) => BoundaryBinding;
} = {
  rest: (boundary) =>
    restBinding({
      transport: boundary.transport,
      method: boundary.method,
      path: boundary.path,
      recognition: "intent",
    }),
  "function-call": (boundary) =>
    functionCallBinding({
      transport: boundary.transport,
      recognition: "intent",
      ...(boundary.module !== undefined ? { module: boundary.module } : {}),
      ...(boundary.exportName !== undefined
        ? { exportName: boundary.exportName }
        : {}),
      ...(boundary.package !== undefined ? { package: boundary.package } : {}),
      ...(boundary.exportPath !== undefined
        ? { exportPath: boundary.exportPath }
        : {}),
    }),
  "message-bus": (boundary) =>
    messageBusBinding({
      recognition: "intent",
      messageBus: boundary.messageBus,
      channel: boundary.channel,
    }),
  "unit-invocation": (boundary) =>
    unitInvocationBinding({
      recognition: "intent",
      deploymentTarget: boundary.deploymentTarget,
      instanceName: boundary.instanceName,
    }),
  storage: (boundary) =>
    storageBinding({
      recognition: "intent",
      storageSystem: boundary.storageSystem,
      scope: boundary.scope,
      container: boundary.container,
      accessPath: boundary.accessPath,
    }),
};

export function toBoundaryBinding(boundary: Boundary): BoundaryBinding {
  // The table narrows per protocol and a lookup by name cannot, so the
  // cast happens once here, as in `dispatchByType`.
  const build = BINDINGS[boundary.semantics] as (
    boundary: Boundary,
  ) => BoundaryBinding;
  return build(boundary);
}

/** A dotted field name is the path the checker compares, segment by segment. */
function toField(name: string, field: AuthoredInputField): IntentInputField {
  return {
    path: name.split("."),
    shape: fieldShape(field),
    required: field.required,
  };
}

/** Null when the author named the field and said nothing about its shape. */
function fieldShape(field: AuthoredInputField): TypeShape | null {
  if (!("type" in field)) {
    return null;
  }
  const { required: _required, ...shape } = field;
  return shapeToTypeShape(shape);
}

function dottedReceives(
  receives: Record<string, AuthoredInputField> | undefined,
): IntentInputField[] {
  return Object.entries(receives ?? {}).map(([name, field]) =>
    toField(name, field),
  );
}

/** The sections of a request, as paths whose first segment is the section. */
const REST_SECTIONS = ["headers", "query", "params"] as const;

function restReceives(
  boundary: Extract<Boundary, { semantics: "rest" }>,
): IntentInputField[] {
  const receives = boundary.receives;
  if (receives === undefined) {
    return [];
  }
  const fields = REST_SECTIONS.flatMap((section) =>
    Object.entries(receives[section] ?? {}).map(([name, field]) =>
      toField(`${section}.${name}`, field),
    ),
  );
  return [...fields, ...bodyFields(receives.body)];
}

/**
 * A declared body's own properties, each as a field under `body`. A
 * body declared as one value, such as an array or a primitive, stays
 * one field, `body` itself.
 */
function bodyFields(body: BodyShape | undefined): IntentInputField[] {
  if (body === undefined) {
    return [];
  }
  const shape = bodyToTypeShape(body);
  if (shape === null) {
    return [];
  }
  if (shape.type !== "record") {
    return [{ path: ["body"], shape, required: false }];
  }
  const required = new Set("required" in body ? (body.required ?? []) : []);
  return Object.entries(shape.properties).map(([name, property]) => ({
    path: ["body", name],
    shape: property,
    required: required.has(name),
  }));
}

const RECEIVES: {
  [K in Boundary["semantics"]]: (
    boundary: Extract<Boundary, { semantics: K }>,
  ) => IntentInputField[];
} = {
  rest: restReceives,
  "function-call": (boundary) => dottedReceives(boundary.receives),
  "message-bus": (boundary) => dottedReceives(boundary.receives),
  storage: (boundary) => dottedReceives(boundary.receives),
  "unit-invocation": (boundary) => dottedReceives(boundary.receives),
};

export function toReceives(boundary: Boundary): IntentInputField[] {
  // The same cast the binding table takes, for the same reason.
  const read = RECEIVES[boundary.semantics] as (
    boundary: Boundary,
  ) => IntentInputField[];
  return read(boundary);
}

const VERBS = EffectRelationSchema.options;

function toEffect(declared: DeclaredEffect): IntentEffect {
  // The schema gives every effect one verb, so the find always succeeds.
  const [does, names] = Object.entries(declared).find(([key]) =>
    (VERBS as readonly string[]).includes(key),
  ) as [EffectRelation, string];
  return {
    does,
    names,
    fields: declared.fields ?? [],
    by: oneOrMore(declared.by),
  };
}

function oneOrMore(written: string | string[] | undefined): string[] {
  if (written === undefined) {
    return [];
  }
  return typeof written === "string" ? [written] : written;
}

/** The verb key and the boundary it points at, when a clause has one. */
function subjectOf(clause: Exclude<WhenClause, string>): IntentEffect | null {
  for (const does of VERBS) {
    const names = clause[does];
    if (names !== undefined) {
      return { does, names, fields: [], by: [] };
    }
  }
  return null;
}

function toCondition(clause: WhenClause): IntentCondition {
  if (typeof clause === "string") {
    return { at: null, input: null, finds: null, said: clause };
  }
  const at = subjectOf(clause);
  return {
    at,
    input: clause.input ?? null,
    finds: clause.finds ?? null,
    said: saidAsOneLine(clause, at),
  };
}

/** A clause on one line, the way a finding quotes it back. */
function saidAsOneLine(
  clause: Exclude<WhenClause, string>,
  at: IntentEffect | null,
): string {
  // The schema gives every clause one subject, so one of the two is set.
  const subject =
    at !== null ? `${at.does} ${at.names}` : `input ${String(clause.input)}`;
  const check = CHECK_KEYS.map((key) =>
    clause[key] === undefined ? null : `${key} ${String(clause[key])}`,
  ).find((said) => said !== null);
  const narrows = clause.where === undefined ? null : `where ${clause.where}`;
  return [subject, check, narrows].filter((part) => part !== null).join(" ");
}

const CHECK_KEYS = ["finds", "is", "equals", "has"] as const;

function toConditions(when: When): IntentCondition[] {
  return (typeof when === "string" ? [when] : when).map(toCondition);
}

function whenAsOneLine(when: When): string {
  return typeof when === "string"
    ? when
    : toConditions(when)
        .map((condition) => condition.said)
        .join(" and ");
}

function toOutcome(t: BoundaryIntent["transitions"][number]): IntentOutcome {
  const effects = (t.results ?? []).map(toEffect);
  const base = {
    id: t.id,
    when: whenAsOneLine(t.when),
    conditions: toConditions(t.when),
    effects,
  };
  if (t.response !== undefined) {
    return {
      ...base,
      kind: "response",
      status: t.response.status,
      body: t.response.body ? bodyToTypeShape(t.response.body) : null,
      errorType: null,
    };
  }
  if (t.returns !== undefined) {
    return {
      ...base,
      kind: "return",
      status: null,
      body: t.returns.body ? bodyToTypeShape(t.returns.body) : null,
      errorType: null,
    };
  }
  if (t.throws !== undefined) {
    return {
      ...base,
      kind: "throw",
      status: null,
      body: null,
      errorType: t.throws.errorType ?? null,
    };
  }
  // The schema's refines leave one case: a transition that says only
  // what it resulted in.
  return { ...base, kind: "effect", status: null, body: null, errorType: null };
}

function bodyToTypeShape(body: BodyShape): TypeShape | null {
  // Record shorthand: `properties:` with no `type:` field.
  if (!("type" in body)) {
    if (body.properties === undefined) {
      return null;
    }
    return recordShape(body.properties);
  }
  return shapeToTypeShape(body);
}

function shapeToTypeShape(shape: AuthoredShape): TypeShape {
  if (shape.type === "array") {
    return {
      type: "array",
      items:
        shape.items !== undefined
          ? shapeToTypeShape(shape.items)
          : { type: "unknown" },
    };
  }
  if (shape.type === "object") {
    return recordShape(shape.properties ?? {});
  }
  return PRIMITIVE_TYPE_SHAPES[shape.type];
}

function recordShape(authored: Record<string, AuthoredShape>): TypeShape {
  const properties: Record<string, TypeShape> = {};
  for (const [name, prop] of Object.entries(authored)) {
    properties[name] = shapeToTypeShape(prop);
  }
  return { type: "record", properties };
}

// The Record type makes this mapping exhaustive, so adding a
// PrimitiveTypeName without a shape here fails to compile.
const PRIMITIVE_TYPE_SHAPES: Record<PrimitiveTypeName, TypeShape> = {
  string: { type: "text" },
  integer: { type: "integer" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  null: { type: "null" },
  unknown: { type: "unknown" },
};
