import type { TypeShape } from "@suss/behavioral-ir";
import type { MatchResult } from "../match.js";

/**
 * Compare an actual body shape against a declared body shape and report
 * whether the actual satisfies the declared.
 *
 * Semantics are asymmetric: `actual` is treated as the produced value
 * (e.g. a provider's response body) and `declared` as the contract it
 * must conform to. Returns:
 *   - "match"   when `actual` is assignable to `declared`
 *   - "nomatch" when some concrete, verifiable incompatibility exists
 *   - "unknown" when uncertainty would mask a real mismatch (spreads,
 *               refs, unknown shapes, unresolvable property sets)
 *
 * `unknown` is a soft signal; callers decide whether to surface it as a
 * `lowConfidence` finding or drop it.
 */
export function bodyShapesMatch(
  actual: TypeShape,
  declared: TypeShape,
): MatchResult {
  if (actual.type === "unknown" || declared.type === "unknown") {
    return "unknown";
  }

  if (actual.type === "ref" || declared.type === "ref") {
    if (
      actual.type === "ref" &&
      declared.type === "ref" &&
      actual.name === declared.name
    ) {
      return "match";
    }
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
