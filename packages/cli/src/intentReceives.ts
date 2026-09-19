/**
 * The `receives` block of a drafted intent document: every path the
 * unit reads off the value its boundary hands it.
 *
 * A field comes out `required: true` when some branch rejects on a null
 * or truthiness check of that path, because rejecting on a missing
 * value is a unit saying it needs one. A 4xx, a throw and a null return
 * are the three ways a branch rejects.
 *
 * The shape comes from `expectedInput`, when the extractor produced
 * one. Curating the block is then deleting lines rather than writing
 * them, which is the whole point of drafting it.
 */

import {
  boundaryInputReads,
  formatPath,
  isTheMessageParameter,
  readPathOf,
} from "@suss/behavioral-ir";

import { toAuthoredShape } from "./intentDraftCommand.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  CarriesPayload,
  Predicate,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type { AuthoredInputField, AuthoredReceives } from "@suss/intent-ir";

/** Which input the caller's value arrives through, per protocol. */
const NOTHING_IS_THE_PAYLOAD: CarriesPayload = () => false;

function carriesPayloadFor(binding: BoundaryBinding): CarriesPayload {
  return binding.semantics.name === "message-bus"
    ? isTheMessageParameter
    : NOTHING_IS_THE_PAYLOAD;
}

/**
 * The block, or null when nothing readable came back. A boundary whose
 * protocol has not said which input the caller's value arrives through
 * gets no block, which is what keeps a REST draft from inventing a
 * spelling the checker cannot compare.
 */
export function draftedReceives(
  summaries: BehavioralSummary[],
  binding: BoundaryBinding,
): AuthoredReceives | null {
  const receives: AuthoredReceives = {};
  for (const summary of summaries) {
    const result = boundaryInputReads(summary, binding);
    if (!result.read) {
      continue;
    }
    const rejected = rejectedPaths(summary, carriesPayloadFor(binding));
    for (const path of result.reads.paths) {
      const spelled = formatPath(path);
      if (receives[spelled] !== undefined) {
        continue;
      }
      receives[spelled] = declaredField(
        rejected.has(spelled),
        shapeAt(summary, path),
      );
    }
  }
  return Object.keys(receives).length === 0 ? null : receives;
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

/** The paths some branch rejects on, as `readSetOf` spells a read. */
function rejectedPaths(
  summary: BehavioralSummary,
  carriesPayload: CarriesPayload,
): Set<string> {
  const paths = new Set<string>();
  for (const transition of summary.transitions) {
    if (!rejects(transition)) {
      continue;
    }
    for (const condition of transition.conditions) {
      for (const path of missingValueChecks(
        summary,
        condition,
        carriesPayload,
      )) {
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
  carriesPayload: CarriesPayload,
): string[][] {
  if (predicate.type === "compound") {
    return predicate.operands.flatMap((operand) =>
      missingValueChecks(summary, operand, carriesPayload),
    );
  }
  if (predicate.type === "negation") {
    return missingValueChecks(summary, predicate.operand, carriesPayload);
  }
  if (predicate.type !== "nullCheck" && predicate.type !== "truthinessCheck") {
    return [];
  }
  const path = readPathOf(summary, predicate.subject, carriesPayload);
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
