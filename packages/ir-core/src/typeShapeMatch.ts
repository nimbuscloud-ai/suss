/**
 * Structural comparison of two TypeShapes.
 *
 * The behavioral checker compares a provider body against a declared
 * contract, and the intent checker compares a code body against declared
 * intent. The two have to reach the same verdict for the same pair, so
 * the comparison is defined next to TypeShape and both checkers import
 * it.
 *
 * The comparison is asymmetric and has three results. `unknown` keeps a
 * shape that cannot be inspected from being reported as a match.
 */

import type { TypeShape } from "./schemas.js";

/**
 * The result of comparing two shapes:
 *   - "match": `actual` satisfies `declared`
 *   - "nomatch": the shapes have a specific, checkable incompatibility
 *   - "unknown": part of a shape cannot be inspected (a spread, a ref, an
 *                unknown shape), and calling it a match could hide a mismatch
 */
export type MatchResult = "match" | "nomatch" | "unknown";

/**
 * Whether an actual body satisfies a declared body.
 *
 * The arguments are not interchangeable. `actual` is the value that is
 * produced (a response body, a return value), and `declared` is the
 * contract it has to conform to. The caller decides whether to report
 * an `"unknown"` result.
 */
export function bodyShapesMatch(
  actual: TypeShape,
  declared: TypeShape,
): MatchResult {
  if (actual.type === "unknown" || declared.type === "unknown") {
    return "unknown";
  }

  // A ref has a name and no structure. Two refs to the same declaration
  // are the same type, and every other comparison with a ref stays
  // unknown so it cannot hide a difference.
  if (actual.type === "ref" && declared.type === "ref") {
    const sameDeclaration =
      actual.from !== undefined &&
      actual.from === declared.from &&
      actual.name === declared.name;
    return sameDeclaration ? "match" : "unknown";
  }
  if (actual.type === "ref" || declared.type === "ref") {
    return "unknown";
  }

  if (actual.type === "union") {
    return combine(actual.variants.map((v) => bodyShapesMatch(v, declared)));
  }
  if (declared.type === "union") {
    return matchAny(actual, declared.variants);
  }

  if (declared.type === "dictionary") {
    if (actual.type === "dictionary") {
      return bodyShapesMatch(actual.values, declared.values);
    }
    if (actual.type === "record") {
      if (actual.spreads && actual.spreads.length > 0) {
        return "unknown";
      }
      const results = Object.values(actual.properties).map((v) =>
        bodyShapesMatch(v, declared.values),
      );
      return combine(results);
    }
    return "nomatch";
  }
  if (actual.type === "dictionary") {
    return declared.type === "record" ? "unknown" : "nomatch";
  }

  if (declared.type === "record") {
    if (actual.type !== "record") {
      return "nomatch";
    }
    if (
      (actual.spreads && actual.spreads.length > 0) ||
      (declared.spreads && declared.spreads.length > 0)
    ) {
      return "unknown";
    }
    const results: MatchResult[] = [];
    for (const [key, declaredValue] of Object.entries(declared.properties)) {
      const actualValue = actual.properties[key];
      if (actualValue === undefined) {
        if (allowsUndefined(declaredValue)) {
          continue;
        }
        return "nomatch";
      }
      results.push(bodyShapesMatch(actualValue, declaredValue));
    }
    return combine(results);
  }

  if (declared.type === "array") {
    if (actual.type !== "array") {
      return "nomatch";
    }
    return bodyShapesMatch(actual.items, declared.items);
  }

  if (declared.type === "literal") {
    if (actual.type !== "literal") {
      return "nomatch";
    }
    return actual.value === declared.value ? "match" : "nomatch";
  }

  if (declared.type === "text") {
    if (actual.type === "text") {
      return "match";
    }
    if (actual.type === "literal" && typeof actual.value === "string") {
      return "match";
    }
    return "nomatch";
  }

  if (declared.type === "integer") {
    if (actual.type === "integer") {
      return "match";
    }
    if (
      actual.type === "literal" &&
      typeof actual.value === "number" &&
      Number.isInteger(actual.value)
    ) {
      return "match";
    }
    return "nomatch";
  }

  if (declared.type === "number") {
    if (actual.type === "number" || actual.type === "integer") {
      return "match";
    }
    if (actual.type === "literal" && typeof actual.value === "number") {
      return "match";
    }
    return "nomatch";
  }

  if (declared.type === "boolean") {
    if (actual.type === "boolean") {
      return "match";
    }
    if (actual.type === "literal" && typeof actual.value === "boolean") {
      return "match";
    }
    return "nomatch";
  }

  if (declared.type === "null") {
    return actual.type === "null" ? "match" : "nomatch";
  }

  if (declared.type === "undefined") {
    return actual.type === "undefined" ? "match" : "nomatch";
  }

  // Every TypeShape variant is handled above, so `declared` is `never`
  // here. This only guards a variant added later with no branch of its
  // own, so it is excluded from coverage instead of tested.
  /* v8 ignore next */
  return "nomatch";
}

function matchAny(actual: TypeShape, variants: TypeShape[]): MatchResult {
  let sawUnknown = false;
  for (const v of variants) {
    const r = bodyShapesMatch(actual, v);
    if (r === "match") {
      return "match";
    }
    if (r === "unknown") {
      sawUnknown = true;
    }
  }
  return sawUnknown ? "unknown" : "nomatch";
}

function combine(results: MatchResult[]): MatchResult {
  if (results.some((r) => r === "nomatch")) {
    return "nomatch";
  }
  if (results.some((r) => r === "unknown")) {
    return "unknown";
  }
  return "match";
}

function allowsUndefined(shape: TypeShape): boolean {
  if (shape.type === "undefined") {
    return true;
  }
  if (shape.type === "union") {
    return shape.variants.some(allowsUndefined);
  }
  return false;
}
