/**
 * The `receives` block of a drafted intent document: every path the unit
 * reads from the input its boundary passes in.
 *
 * A field is marked `required: true` when some branch rejects the call
 * after a null or truthiness check on that path, since a unit that
 * refuses a missing value needs it. A branch rejects by returning a 4xx,
 * throwing, or returning null.
 *
 * Field shapes come from `expectedInput`. That is keyed by the handler's
 * own parameter, while a REST draft is laid out by request section, so a
 * REST field usually has no shape.
 */

import {
  boundaryInputPathOf,
  boundaryInputReads,
  formatPath,
} from "@suss/behavioral-ir";

import { toAuthoredShape } from "./intentDraftCommand.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Predicate,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  AuthoredInputField,
  AuthoredReceives,
  AuthoredRestReceives,
  AuthoredShape,
} from "@suss/intent-ir";
import type { Semantics } from "@suss/ir-core";

/** A REST boundary groups its fields by request section. Every other kind uses a flat map of dotted paths. */
export type DraftedReceives = AuthoredReceives | AuthoredRestReceives;

/** One drafted field, before it is laid out for its boundary's protocol. */
interface DraftedField {
  path: string[];
  required: boolean;
  /** Null when the summary has no expected type at this path. */
  shape: TypeShape | null;
}

/** The `receives` block, or null when no unit reads anything from the input. */
export function draftedReceives(
  summaries: BehavioralSummary[],
  binding: BoundaryBinding,
  wrappersOf: (unit: BehavioralSummary) => BehavioralSummary[],
): DraftedReceives | null {
  const drafted = draftedFields(summaries, binding, wrappersOf);
  if (drafted.length === 0) {
    return null;
  }
  return RECEIVES_BLOCK[binding.semantics.name](drafted);
}

/** The layout each protocol's `receives` block must have for the intent loader to accept it. */
const RECEIVES_BLOCK: Record<
  Semantics["name"],
  (drafted: readonly DraftedField[]) => DraftedReceives
> = {
  rest: restBlock,
  "function-call": dottedBlock,
  "message-bus": dottedBlock,
  storage: dottedBlock,
  "unit-invocation": dottedBlock,
  "graphql-resolver": dottedBlock,
  "graphql-operation": dottedBlock,
  "runtime-config": dottedBlock,
  metric: dottedBlock,
};

/** Every path read across the summaries, once each, with whether it is required and its shape. */
function draftedFields(
  summaries: BehavioralSummary[],
  binding: BoundaryBinding,
  wrappersOf: (unit: BehavioralSummary) => BehavioralSummary[],
): DraftedField[] {
  const seen = new Set<string>();
  const drafted: DraftedField[] = [];
  for (const summary of summaries) {
    const result = boundaryInputReads(summary, binding, wrappersOf(summary));
    if (!result.read) {
      continue;
    }
    const rejected = rejectedPaths(summary, binding);
    for (const path of result.reads.paths) {
      const spelled = formatPath(path);
      if (seen.has(spelled)) {
        continue;
      }
      seen.add(spelled);
      drafted.push({
        path,
        required: rejected.has(spelled),
        shape: shapeAt(summary, path),
      });
    }
  }
  return drafted;
}

function dottedBlock(drafted: readonly DraftedField[]): AuthoredReceives {
  const receives: AuthoredReceives = {};
  for (const field of drafted) {
    receives[formatPath(field.path)] = declaredField(
      field.required,
      field.shape,
    );
  }
  return receives;
}

/**
 * Lays fields out under the four request sections. A body field becomes
 * a property of one body shape, with required fields listed beside the
 * properties, because the intent schema describes a body that way.
 */
function restBlock(drafted: readonly DraftedField[]): AuthoredRestReceives {
  const block: AuthoredRestReceives = {};
  const body = {
    properties: {} as Record<string, AuthoredShape>,
    required: [] as string[],
  };
  let takesABody = false;

  for (const field of drafted) {
    const [section, ...rest] = field.path;
    if (section === "body") {
      takesABody = true;
      addBodyProperty(body, rest, field);
      continue;
    }
    if (section === "headers" || section === "query" || section === "params") {
      const name = rest.join(".");
      block[section] = {
        ...(block[section] ?? {}),
        [name]: declaredField(field.required, field.shape),
      };
    }
  }

  return { ...block, ...draftedBody(body, takesABody) };
}

/**
 * The body section, or nothing when the route never reads the body. When
 * the route reads the body as a whole, the draft marks the body `unknown`
 * and the curator writes its shape.
 */
function draftedBody(
  body: { properties: Record<string, AuthoredShape>; required: string[] },
  takesABody: boolean,
): Pick<AuthoredRestReceives, "body"> {
  if (Object.keys(body.properties).length > 0) {
    return {
      body: {
        properties: body.properties,
        ...(body.required.length > 0 ? { required: body.required } : {}),
      },
    };
  }
  return takesABody ? { body: { type: "unknown" } } : {};
}

/**
 * Adds only the outermost property of a body read. A read of
 * `body.items.sku` drafts `items`, because that is the field an author
 * must know about, and anything nested under it belongs in its shape.
 */
function addBodyProperty(
  body: { properties: Record<string, AuthoredShape>; required: string[] },
  rest: readonly string[],
  field: DraftedField,
): void {
  const name = rest[0];
  if (name === undefined || body.properties[name] !== undefined) {
    return;
  }
  body.properties[name] =
    field.shape === null ? { type: "unknown" } : toAuthoredShape(field.shape);
  if (field.required) {
    body.required.push(name);
  }
}

/** A field with no known shape and no requirement is still written, as `{}`. */
function declaredField(
  required: boolean,
  shape: TypeShape | null,
): AuthoredInputField {
  const authored = shape === null ? null : toAuthoredShape(shape);
  return {
    ...(authored !== null && authored.type !== "unknown" ? authored : {}),
    ...(required ? { required: true } : {}),
  } as AuthoredInputField;
}

/** The paths some rejecting branch checks, formatted the same way as the paths read. */
function rejectedPaths(
  summary: BehavioralSummary,
  binding: BoundaryBinding,
): Set<string> {
  const paths = new Set<string>();
  for (const transition of summary.transitions) {
    if (!rejects(transition)) {
      continue;
    }
    for (const condition of transition.conditions) {
      for (const path of missingValueChecks(summary, condition, binding)) {
        paths.add(formatPath(path));
      }
    }
  }
  return paths;
}

/** Whether this branch refuses the call: a 4xx response, a throw, or a null return. */
function rejects(transition: Transition): boolean {
  const output = transition.output;
  if (output.type === "throw") {
    return true;
  }
  if (output.type === "response") {
    const status = output.statusCode;
    return (
      status !== null &&
      status.type === "literal" &&
      Number(status.value) >= 400 &&
      Number(status.value) < 500
    );
  }
  return output.type === "return" && returnsNothing(output.value);
}

function returnsNothing(value: TypeShape | null): boolean {
  return (
    value !== null && (value.type === "null" || value.type === "undefined")
  );
}

/**
 * Every input path a predicate checks for a missing value. Compound
 * guards are walked, so `if (!a && !b)` returns both paths.
 */
function missingValueChecks(
  summary: BehavioralSummary,
  predicate: Predicate,
  binding: BoundaryBinding,
): string[][] {
  if (predicate.type === "compound") {
    return predicate.operands.flatMap((operand) =>
      missingValueChecks(summary, operand, binding),
    );
  }
  if (predicate.type === "negation") {
    return missingValueChecks(summary, predicate.operand, binding);
  }
  if (predicate.type !== "nullCheck" && predicate.type !== "truthinessCheck") {
    return [];
  }
  const path = boundaryInputPathOf(summary, binding, predicate.subject);
  return path === null ? [] : [path];
}

/** The first expected type any transition records at this path, or null. */
function shapeAt(
  summary: BehavioralSummary,
  path: readonly string[],
): TypeShape | null {
  for (const transition of summary.transitions) {
    const shape = walkTo(transition.expectedInput ?? null, path);
    if (shape !== null) {
      return shape;
    }
  }
  return null;
}

function walkTo(
  shape: TypeShape | null,
  path: readonly string[],
): TypeShape | null {
  let here = shape;
  for (const segment of path) {
    if (here === null || here.type !== "record") {
      return null;
    }
    here = here.properties[segment] ?? null;
  }
  return here;
}
