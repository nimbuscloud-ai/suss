/**
 * The REST protocol as a boundary.
 *
 * A boundary here is one route, identified by an HTTP method and a
 * path. The method can be `"*"` for a handler that responds to every
 * method, or null when the source never says which method. The path is
 * null when the source never gives one. An empty string is invalid
 * everywhere: a field that means something when it is blank hides that
 * meaning from every reader.
 *
 * `normalizePath`, `methodsAgree`, and `routePathAdmits` are exported
 * because more than one checker compares paths and methods, and they
 * all have to do it the same way.
 */

import { z } from "zod";

import { patternHole, referenceFromName } from "../boundaryName.js";
import { pathAfterOrigin } from "../urlPath.js";
import { defineBoundarySemantics } from "./definition.js";
import {
  pathSpansShapes,
  pathSpecificity,
  pathsMeet,
  patternAdmits,
} from "./pathPattern.js";

import type { Reference } from "../boundaryName.js";

export const RestSemanticsSchema = z.object({
  name: z.literal("rest"),
  /**
   * Uppercase HTTP method ("GET", "POST", …), `"*"` for a handler that
   * responds to every method, or null when this source does not say
   * which method.
   */
  method: z.string().min(1).nullable(),
  /** Normalized route path ("/users/{id}"), or null when this source does not give one. */
  path: z.string().min(1).nullable(),
  /**
   * Status codes the producing source explicitly declared (OpenAPI
   * responses, CFN MethodResponses, ts-rest router statuses). They are
   * kept here so the pairing layer can see them without unwrapping any
   * metadata. Absent, or empty, for a source that was inferred.
   */
  declaredResponses: z.array(z.number()).optional(),
});

export type RestSemantics = z.infer<typeof RestSemanticsSchema>;

/** A path that opens with a hole, and the rest of the path after it. */
const OPENING_HOLE = /^\{([^{}]+)\}(.*)$/;

/**
 * Where a base URL the source left open says to go and ask. Only a
 * hole at the front is a base URL: one further along is a route
 * parameter, and `/orders/{id}` means every id rather than a variable
 * somebody set.
 */
function baseUrlReference(semantics: {
  path: string | null;
}): Reference | null {
  const label = OPENING_HOLE.exec(semantics.path ?? "")?.[1];
  return label === undefined ? null : referenceFromName(patternHole(label));
}

/**
 * Normalize a route path to a canonical form for matching.
 *
 * - Converts Express-style params (`:id`) to brace-style (`{id}`), and
 *   keeps a range modifier (`:id?`, `:rest+`, `:rest*`) inside the braces
 * - Strips trailing slashes (except bare `/`)
 * - Lowercases the static segments (params stay case-sensitive)
 */
export function normalizePath(path: string): string {
  // :param → {param}
  let normalized = path.replace(/:([a-zA-Z_]\w*)([?+*]?)/g, "{$1$2}");

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
 * A path with every parameter reduced to its position. `/users/{id}`
 * and `/users/:userId` both come out `/users/{}`, which is the set of
 * requests each one serves, and what deciding whether two sides
 * describe one endpoint rests on. The name a parameter is written
 * under is worth keeping in a report and worth nothing in a comparison.
 * A parameter's range stays, since `{tenant?}` serves a different set
 * of requests from `{tenant}`.
 */
export function pathShape(path: string): string {
  return normalizePath(path).replace(/\{[^{}]*?([?+*]?)\}/g, "{$1}");
}

/**
 * Whether two REST methods mean the same thing. Equal methods agree,
 * and `"*"` agrees with any stated method, because a handler that
 * responds to every method responds to this one. A null method was never
 * stated, so it agrees with nothing: there is no claim to agree with.
 *
 * This is the counterpart of `busesAgree`. No list of methods appears
 * here, so a wildcard pairs with whatever methods consumers write.
 */
export function methodsAgree(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return false;
  }
  return a === b || a === "*" || b === "*";
}

/**
 * Whether a declared route path admits a concrete request path. Both
 * sides compare on their normalized forms, and a hole in the request
 * is text like any other, so a route inside a mount pattern is admitted
 * by it and a wider route is not.
 */
export function routePathAdmits(
  declaredPath: string,
  requestPath: string,
): boolean {
  return patternAdmits(normalizePath(declaredPath), normalizePath(requestPath));
}

/** Whether two declared route paths serve at least one request in common. */
export function routePathsMeet(a: string, b: string): boolean {
  return pathsMeet(normalizePath(a), normalizePath(b));
}

export const restSemantics = defineBoundarySemantics({
  name: "rest",
  schema: RestSemanticsSchema,
  semconv: {
    // A span states the one method a request used, so a route that
    // responds to every method has nothing to compare.
    method: { name: "http.request.method", placeholderValues: ["*"] },
    path: { name: "http.route" },
    // declaredResponses is a list, and http.response.status_code is
    // the one status a request got back.
  },
  behavior: {
    /** A request goes out, a status and a body come back. */
    exchangesHttpResponses: true,
    reportsUnpairedItself: false,
    /** `"METHOD /normalized/path"`, or null when either half is missing. */
    identityKey(semantics) {
      if (semantics.method === null || semantics.path === null) {
        return null;
      }
      return `${semantics.method.toUpperCase()} ${normalizePath(semantics.path)}`;
    },
    /**
     * The bucket has only the path in it, so a `"*"` route lands with
     * the consumers that each specify a method, and `methodsAgree`
     * settles it inside the bucket. The identity key stays what a reader
     * sees and a suppression targets ("GET /users", "* /users"), and
     * this key groups what a reader still tells apart.
     *
     * A parameter's name goes too. A spec written by hand says
     * `{userId}` where the Express route that serves it says `:id`, and
     * both match the same requests, so pairing on the name gave two
     * boundaries that never met and a run with nothing to report.
     */
    pairingKey(semantics) {
      if (semantics.method === null || semantics.path === null) {
        return null;
      }
      return `rest ${pathShape(semantics.path)}`;
    },
    sidesAgree(a, b) {
      return methodsAgree(a.method, b.method);
    },
    spansBuckets(semantics) {
      return (
        semantics.path !== null &&
        pathSpansShapes(normalizePath(semantics.path))
      );
    },
    bucketsMeet(a, b) {
      return (
        a.path !== null && b.path !== null && routePathsMeet(a.path, b.path)
      );
    },
    bucketRank(semantics) {
      return semantics.path === null
        ? []
        : pathSpecificity(normalizePath(semantics.path));
    },
    /**
     * What the identity key says, with a missing half still readable:
     * ANY when no method was stated, and ? when no path was. Null when
     * neither was stated, because then there is nothing to show.
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
     * A route with both halves stated decides for itself: the method
     * through `methodsAgree` (so a `"*"` route matches every method),
     * and the path through `routePathAdmits`. A route missing either
     * half might still be the one that handles the request, and nothing
     * here can settle that, so it abstains instead of refusing.
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
    /**
     * A route the registration pattern admits is inside it. A route
     * whose path this source never gave is left outside, because
     * nothing here can show it is one the pattern covers.
     */
    withinScope(semantics, scope) {
      return semantics.path !== null && routePathAdmits(scope, semantics.path);
    },
    /**
     * A call whose base URL the deployment fills in, resolved to the
     * path it reaches.
     *
     * The source cannot settle this on its own, which is why the
     * adapter leaves the hole in. `API_BASE` could be
     * `http://backend.internal`, and then the path is `/orders`. It
     * could equally be `/api/v2`, and then the path is
     * `/api/v2/orders`. Putting the deployed value in and reading the
     * path back out gets the right one either way.
     *
     * Only a hole at the front is a base URL. A hole further along is a
     * route parameter, and `/orders/{id}` means every id rather than a
     * variable somebody set.
     */
    groundName(semantics, deployment) {
      const reference = baseUrlReference(semantics);
      if (reference === null) {
        return null;
      }
      const base = deployment.setTo(reference);
      if (base === null) {
        return null;
      }
      const rest = OPENING_HOLE.exec(semantics.path ?? "")?.[2] ?? "";
      const grounded = pathAfterOrigin(`${base}${rest}`);
      return { ...semantics, path: grounded === "" ? "/" : grounded };
    },
    nameReference: baseUrlReference,
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
