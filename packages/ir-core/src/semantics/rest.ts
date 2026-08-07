// rest.ts: the REST protocol as a boundary.
//
// One route, identified by an HTTP method and a path. The method can
// be `"*"` for a handler that answers every method, or null when the
// source never named one; the path is null when unnamed. The empty
// string is invalid everywhere: a field that means something when
// blank hides that meaning from every reader.

import { z } from "zod";

import { defineBoundarySemantics } from "./definition.js";

export const RestSemanticsSchema = z.object({
  name: z.literal("rest"),
  /**
   * Uppercase HTTP method ("GET", "POST", …), `"*"` for a handler
   * that answers every method, or null when this source does not name
   * one.
   */
  method: z.string().min(1).nullable(),
  /** Normalized route path ("/users/{id}"), or null when this source does not name one. */
  path: z.string().min(1).nullable(),
  /**
   * Status codes the producing source explicitly declared (OpenAPI
   * responses, CFN MethodResponses, ts-rest router statuses). Kept here
   * so the pairing layer can still see them without unwrapping metadata.
   * Empty / absent for inferred sources.
   */
  declaredResponses: z.array(z.number()).optional(),
});

export type RestSemantics = z.infer<typeof RestSemanticsSchema>;

/**
 * Normalize a route path to a canonical form for matching.
 *
 * - Converts Express-style params (`:id`) to brace-style (`{id}`)
 * - Strips trailing slashes (except bare `/`)
 * - Lowercases the static segments (params stay case-sensitive)
 */
export function normalizePath(path: string): string {
  // :param → {param}
  let normalized = path.replace(/:([a-zA-Z_]\w*)/g, "{$1}");

  // Strip trailing slash (keep bare /)
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  // Lowercase static segments, preserve param names inside braces
  normalized = normalized.replace(/\{[^}]+\}|[^{]+/g, (segment) =>
    segment.startsWith("{") ? segment : segment.toLowerCase(),
  );

  return normalized;
}

/**
 * Whether two REST methods name the same thing. Equal methods agree,
 * and `"*"` agrees with any named method, because a handler that
 * answers every method answers this one. A null method is unnamed and
 * agrees with nothing; there is no claim to agree with.
 *
 * The sibling of `busesAgree`: no method vocabulary is listed here,
 * so a wildcard pairs with whatever methods consumers write.
 */
export function methodsAgree(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return false;
  }
  return a === b || a === "*" || b === "*";
}

/**
 * A normalized route path as a matcher for concrete request paths.
 * `{param}` stands for exactly one path segment; `*` crosses segment
 * boundaries and may be empty, which is how Express 4 reads a bare
 * star. Everything else compares literally, on the normalized
 * (static-lowercased, trailing-slash-stripped) forms of both sides.
 */
function routePathRegex(pattern: string): RegExp {
  const source = pattern
    .split(/(\{[^}]+\}|\*)/g)
    .map((part) => {
      if (part === "*") {
        return ".*";
      }

      if (part.startsWith("{") && part.endsWith("}")) {
        return "[^/]+";
      }

      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

/** Whether a declared route path admits a concrete request path. */
export function routePathAdmits(
  declaredPath: string,
  requestPath: string,
): boolean {
  return routePathRegex(normalizePath(declaredPath)).test(
    normalizePath(requestPath),
  );
}

export const restSemantics = defineBoundarySemantics({
  name: "rest",
  schema: RestSemanticsSchema,
  behavior: {
    /** `"METHOD /normalized/path"`; null when either half is unnamed. */
    identityKey(semantics) {
      if (semantics.method === null || semantics.path === null) {
        return null;
      }
      return `${semantics.method.toUpperCase()} ${normalizePath(semantics.path)}`;
    },
    /**
     * The bucket carries only the path, so a `"*"` route lands with
     * the consumers that each name a method and `methodsAgree`
     * settles it in-bucket. The identity key stays what a reader sees
     * and a suppression names ("GET /users", "* /users"); this key
     * exists so pairing can group what a reader still tells apart.
     */
    pairingKey(semantics) {
      if (semantics.method === null || semantics.path === null) {
        return null;
      }
      return `rest ${normalizePath(semantics.path)}`;
    },
    sidesAgree(a, b) {
      return methodsAgree(a.method, b.method);
    },
    /**
     * What the identity key says, with one unnamed half still
     * readable: ANY where no method was stated, ? where no path was.
     * Null when neither half was stated; there is nothing to show.
     */
    displayLabel(semantics) {
      if (semantics.method === null && semantics.path === null) {
        return null;
      }
      const method =
        semantics.method === null ? "ANY" : semantics.method.toUpperCase();
      const path =
        semantics.path === null ? "?" : normalizePath(semantics.path);
      return `${method} ${path}`;
    },
    /**
     * A route with both halves named answers by its own match: the
     * method through `methodsAgree` (so an `"*"` route answers every
     * method) and the path through `routePathAdmits`. A route missing
     * either half might still be the one that answers, and nothing
     * here can settle it, so it abstains rather than refusing.
     */
    servesRequest(semantics, method, path) {
      if (semantics.method === null || semantics.path === null) {
        return "unknown";
      }

      if (!methodsAgree(semantics.method, method.toUpperCase())) {
        return "nomatch";
      }

      return routePathAdmits(semantics.path, path) ? "match" : "nomatch";
    },
    ruleBoundary: {
      // "METHOD /path": one leading token, then an absolute path.
      claims(raw) {
        return /^\S+ +\//.test(raw.trim());
      },
      normalize(raw) {
        const trimmed = raw.trim();
        const spaceIdx = trimmed.indexOf(" ");
        const method = trimmed.slice(0, spaceIdx).toUpperCase();
        return `${method} ${normalizePath(trimmed.slice(spaceIdx + 1).trim())}`;
      },
    },
  },
});
