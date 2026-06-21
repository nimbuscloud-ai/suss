// @suss/intent-ir summary — the normalised intent shape the checker
// compares against derived behavioural summaries.
//
// The authoring schema (./schema.ts) is friendly to write; this is the
// shape that's convenient to check: boundaries as @suss/ir-core
// BoundaryBindings, body shapes as TypeShapes, and one flat outcome
// list per boundary intent.

import {
  type BoundaryBinding,
  functionCallBinding,
  restBinding,
  type TypeShape,
} from "@suss/ir-core";

import type {
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

/** How a boundary outcome resolves — the cross-kind unification. */
export type IntentOutcomeKind = "response" | "return" | "throw";

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

function toBoundaryBinding(boundary: Boundary): BoundaryBinding {
  if (boundary.semantics === "rest") {
    return restBinding({
      transport: boundary.transport,
      method: boundary.method,
      path: boundary.path,
      recognition: "intent",
    });
  }
  return functionCallBinding({
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
  });
}

function toOutcome(t: BoundaryIntent["transitions"][number]): IntentOutcome {
  const base = { id: t.id, when: t.when };
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
  // The schema's refine guarantees exactly one outcome is present, so
  // this is the `throws` case.
  return {
    ...base,
    kind: "throw",
    status: null,
    body: null,
    errorType: t.throws?.errorType ?? null,
  };
}

function bodyToTypeShape(body: BodyShape): TypeShape | null {
  if (body.properties === undefined) {
    return null;
  }
  const properties: Record<string, TypeShape> = {};
  for (const [name, prop] of Object.entries(body.properties)) {
    properties[name] = PRIMITIVE_TYPE_SHAPES[prop.type];
  }
  return { type: "record", properties };
}

// The friendly primitive vocabulary mapped onto IR TypeShapes. A Record
// (rather than a switch) makes the mapping exhaustive by construction —
// adding a PrimitiveTypeName without a shape here is a compile error.
const PRIMITIVE_TYPE_SHAPES: Record<PrimitiveTypeName, TypeShape> = {
  string: { type: "text" },
  integer: { type: "integer" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  null: { type: "null" },
  unknown: { type: "unknown" },
};
