// summaryBuilder.ts — turn a validated IntentDoc into a BehavioralSummary.
//
// Both kinds (boundary, prd) flow through the same BehavioralSummary
// stream. Boundary intents become handler-kind summaries that pair against
// derived code via the existing checker. PRD docs become library-kind
// summaries with all scenarios in metadata.prd — the PRD coverage checker
// walks these.

import { restBinding } from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  BodyShape,
  BoundaryIntent,
  BoundaryTransition,
  IntentDoc,
  Prd,
  PrdScenario,
  PrimitiveTypeName,
} from "./schema.js";

export interface BuildOptions {
  /** Logical source recorded on the summary's `location.file`. */
  source?: string;
}

export function intentDocToSummary(
  doc: IntentDoc,
  options: BuildOptions = {},
): BehavioralSummary {
  if (doc.kind === "prd") {
    return prdToSummary(doc, options);
  }
  return boundaryIntentToSummary(doc, options);
}

// Back-compat name — the original v0.1 reader's entry point was
// `intentSpecToSummary` and several call sites still refer to it.
// Forwards to the new dispatcher.
export function intentSpecToSummary(
  doc: IntentDoc,
  options: BuildOptions = {},
): BehavioralSummary {
  return intentDocToSummary(doc, options);
}

function boundaryIntentToSummary(
  spec: BoundaryIntent,
  options: BuildOptions = {},
): BehavioralSummary {
  const sourceFile =
    options.source ?? `intent:${spec.boundary.method} ${spec.boundary.path}`;
  return {
    kind: "handler",
    location: {
      file: sourceFile,
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: `${spec.boundary.method.toUpperCase()} ${spec.boundary.path}`,
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method: spec.boundary.method.toUpperCase(),
        path: spec.boundary.path,
        recognition: "intent",
      }),
    },
    inputs: [],
    transitions: spec.transitions.map((t, idx) =>
      buildTransition(t, idx, spec.transitions.length),
    ),
    gaps: [],
    // `declared` is the closest fit in the current ConfidenceSource enum
    // (inferred_static / inferred_ai / declared / derived). The intent
    // layer's epistemic character is `specification` per the
    // contracts.md taxonomy; bridging the two is tracked separately.
    confidence: { source: "declared", level: "high" },
    metadata: {
      intent: {
        // `name` is what PRDs use to reference this intent's outcomes
        // (`<name>.<transition-id>`). The coverage checker keys on it.
        name: spec.name,
        purpose: spec.purpose,
        audience: spec.audience,
      },
    },
  };
}

function prdToSummary(prd: Prd, options: BuildOptions = {}): BehavioralSummary {
  const sourceFile = options.source ?? `prd:${prd.title}`;
  return {
    // PRDs aren't bound to a specific code unit — they describe outcomes
    // that may span multiple boundaries. `library` is the closest existing
    // CodeUnitKind for "unit of work without a single boundary."
    kind: "library",
    location: {
      file: sourceFile,
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: prd.title,
      exportPath: null,
      // No boundary binding — the PRD coverage checker looks the PRD
      // up by metadata.prd, not by binding.
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      prd: {
        title: prd.title,
        purpose: prd.purpose,
        audience: prd.audience,
        scenarios: prd.scenarios.map(serializeScenario),
      },
    },
  };
}

function serializeScenario(scenario: PrdScenario): {
  title: string | null;
  when: string;
  expect: string[];
} {
  return {
    title: scenario.title ?? null,
    when: scenario.when,
    expect: Array.isArray(scenario.expect)
      ? scenario.expect
      : [scenario.expect],
  };
}

function buildTransition(
  transition: BoundaryTransition,
  index: number,
  total: number,
): Transition {
  const body = transition.output.body
    ? bodyShapeToTypeShape(transition.output.body)
    : null;
  // The last transition in the list is the spec's default — when no earlier
  // `when` matches, this is the outcome. Authors who want a different default
  // can rearrange their `transitions` array.
  const isDefault = index === total - 1;
  return {
    // The Transition.id carries the author-declared outcome id so the
    // PRD coverage checker can resolve `<intent-name>.<outcome-id>`
    // against this transition.
    id: transition.id,
    conditions: isDefault
      ? []
      : [
          {
            type: "opaque",
            sourceText: transition.when,
            reason: "complexExpression",
          },
        ],
    output: {
      type: "response",
      statusCode: { type: "literal", value: transition.output.status },
      body,
      headers: {},
    },
    effects: [],
    location: { start: 0, end: 0 },
    isDefault,
  };
}

function bodyShapeToTypeShape(body: NonNullable<BodyShape>): TypeShape | null {
  if (body === null || body.properties === undefined) {
    return null;
  }
  const properties: Record<string, TypeShape> = {};
  for (const [name, prop] of Object.entries(body.properties)) {
    properties[name] = primitiveToTypeShape(prop.type);
  }
  return { type: "record", properties };
}

function primitiveToTypeShape(name: PrimitiveTypeName): TypeShape {
  // Map the user-facing type vocabulary onto the IR's TypeShape names.
  // "string" is what authors write; the IR calls the same thing "text".
  switch (name) {
    case "string":
      return { type: "text" };
    case "integer":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "unknown":
      return { type: "unknown" };
  }
}
