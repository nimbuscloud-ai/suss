// @suss/intent-ir summary: the normalised intent shape the checker
// compares against derived behavioural summaries.
//
// The authoring schema (./schema.ts) is friendly to write; this is the
// shape that's convenient to check: boundaries as @suss/ir-core
// BoundaryBindings, body shapes as TypeShapes, and one flat outcome
// list per boundary intent.

import {
  type BoundaryBinding,
  boundaryLabel,
  type EffectRelation,
  functionCallBinding,
  messageBusBinding,
  restBinding,
  storageBinding,
  type TypeShape,
} from "@suss/ir-core";

import type {
  AuthoredShape,
  BodyShape,
  Boundary,
  BoundaryIntent,
  IntentDoc,
  IntentSource,
  Prd,
  PrimitiveTypeName,
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
  /** The boundary it reaches, keeping every field the doc stated. */
  binding: BoundaryBinding;
  /** How a report and `suss ask` spell that boundary. */
  label: string;
}

export interface IntentOutcome {
  /** Author-declared id PRD scenarios reference. */
  id: string;
  /** The condition, in human terms (opaque to the checker). */
  when: string;
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

export interface BoundaryIntentSummary {
  kind: "boundary";
  name: string;
  purpose: string;
  audience: string;
  source: IntentSource;
  boundary: BoundaryBinding;
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
  // The one cast joins the per-protocol table, which narrows, to the
  // runtime lookup, the same way dispatchByType does it.
  const build = BINDINGS[boundary.semantics] as (
    boundary: Boundary,
  ) => BoundaryBinding;
  return build(boundary);
}

function toEffect(declared: {
  does: EffectRelation;
  at: Boundary;
}): IntentEffect {
  const binding = toBoundaryBinding(declared.at);
  return {
    does: declared.does,
    binding,
    // A boundary nothing can spell has no effect to compare, and the
    // checker reports the outcome uncovered rather than guessing.
    label: boundaryLabel(binding) ?? "",
  };
}

function toOutcome(t: BoundaryIntent["transitions"][number]): IntentOutcome {
  const effects = (t.results ?? []).map(toEffect);
  const base = { id: t.id, when: t.when, effects };
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

// The friendly primitive vocabulary mapped onto IR TypeShapes. A Record
// (rather than a switch) makes the mapping exhaustive by construction,
// adding a PrimitiveTypeName without a shape here is a compile error.
const PRIMITIVE_TYPE_SHAPES: Record<PrimitiveTypeName, TypeShape> = {
  string: { type: "text" },
  integer: { type: "integer" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  null: { type: "null" },
  unknown: { type: "unknown" },
};
