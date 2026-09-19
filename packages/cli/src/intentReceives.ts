/**
 * The `receives` block of a drafted intent document: every path the
 * unit reads off the value its boundary hands it.
 *
 * A field comes out `required: true` when some branch rejects on a null
 * or truthiness check of that path, because rejecting on a missing
 * value is a unit saying it needs one. A 4xx, a throw and a null return
 * are the three ways a branch rejects.
 *
 * The shape comes from `expectedInput`. A REST draft writes the
 * sections of the request rather than the handler's own parameter, and
 * `expectedInput` is keyed the way the handler reads, so a REST field
 * comes out with no shape.
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

/** A REST boundary writes its fields in sections; every other kind writes a flat map. */
export type DraftedReceives = AuthoredReceives | AuthoredRestReceives;

/** One drafted field, before it is written in whichever spelling the boundary takes. */
interface DraftedField {
  path: string[];
  required: boolean;
  /** Null when the extractor said nothing about what is at this path. */
  shape: TypeShape | null;
}

/**
 * The block, or null when nothing readable came back. A boundary whose
 * protocol has not said how it spells a read gets no block, which is
 * what keeps a draft from inventing a spelling the checker cannot
 * compare.
 */
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

/** How each protocol writes the block a reader has to be able to load back. */
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

/** Every path read, once each, with what the code says about it. */
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
 * The four sections a request comes in. A body field becomes a
 * property of the body shape rather than an entry in a map, because
 * that is how the schema spells a body: one value with properties
 * under it, and the ones it needs listed beside them.
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
 * The body section, or nothing when the route never touched one. A
 * route that read the body without naming a field says only that it
 * takes one, and curating the document is where its shape gets written.
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
 * A body read written as its outermost property. A read of
 * `body.items.sku` drafts `items`, since that is the field an author
 * has to know about and the nesting under it is the shape's business.
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

/** A field with nothing to say about it is written `{}`, not left out. */
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

/** The paths some branch rejects on, spelled the way a read of one is. */
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

/** Whether this branch turns the caller away rather than serving it. */
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
 * Every input path a predicate checks for a missing value. A compound
 * guard is walked through, so `if (!a && !b)` says both.
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

/** What the extractor said the branch expects at this path, when it said anything. */
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
