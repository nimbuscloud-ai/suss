// summaryBuilder.ts — turn a validated IntentSpec into a BehavioralSummary.

import { restBinding } from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  BodyShape,
  IntentSpec,
  PrimitiveTypeName,
  RestTransition,
} from "./schema.js";

export interface BuildOptions {
  /** Logical source recorded on the summary's `location.file`. */
  source?: string;
}

export function intentSpecToSummary(
  spec: IntentSpec,
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
    confidence: { source: "specification", level: "high" },
    metadata: {
      intent: {
        purpose: spec.purpose,
        audience: spec.audience,
      },
    },
  };
}

function buildTransition(
  transition: RestTransition,
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
    id: `intent-${index}`,
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
