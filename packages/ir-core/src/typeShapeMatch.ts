/**
 * Comparing two TypeShapes structurally.
 *
 * Both checkers do this. The behavioural checker compares a provider
 * body against a declared contract, and the intent checker compares a
 * code body against declared intent, and the two have to reach the same
 * verdict for the same pair. The comparison is here, next to the
 * TypeShape it works on, so neither checker owns it and the two cannot
 * drift apart.
 *
 * The comparison is asymmetric, and the answer has three values rather
 * than two. `unknown` is what keeps a shape nobody can see into from
 * being reported as agreement.
 */

import type { TypeShape } from "./schemas.js";

/**
 * A comparison result with three values:
 *   - "match": `actual` satisfies `declared`
 *   - "nomatch": there is a concrete, verifiable incompatibility
 *   - "unknown": uncertainty that would otherwise mask a mismatch
 *                (spreads, refs, unknown shapes)
 */
export type MatchResult = "match" | "nomatch" | "unknown";

/**
 * Compare an actual body against a declared body and say whether the
 * actual satisfies the declared.
 *
 * The two sides are not interchangeable. `actual` is the value that gets
 * produced (a response body, a return value), and `declared` is the
 * contract it has to conform to. `unknown` is a soft signal, and the
 * caller decides whether to show it.
 */
export function bodyShapesMatch(
  actual: TypeShape,
  declared: TypeShape,
): MatchResult {
  if (actual.type === "unknown" || declared.type === "unknown") {
    return "unknown";
  }

  // A ref has a name and no structure, so two refs to the same
  // declaration are the same type and that is the one case decidable
  // here. Everything else stays unknown, or a difference would be hidden.
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
