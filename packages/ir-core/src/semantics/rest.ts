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

import { pathAfterOrigin } from "../urlPath.js";
import { defineBoundarySemantics } from "./definition.js";

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
 * The variable a hole's label asks about.
 *
 * A pack writes the label the way the source spells the read, so
 * `{API_BASE}` and `{env.API_BASE}` ask about the same variable.
 */
function variableOf(label: string): string {
  const parts = label.split(".");
  return parts[parts.length - 1] ?? label;
}

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
 * A path with every parameter reduced to its position. `/users/{id}`
 * and `/users/:userId` both come out `/users/{}`, which is the set of
 * requests each one serves, and what deciding whether two sides
 * describe one endpoint rests on. The name a parameter is written
 * under is worth keeping in a report and worth nothing in a comparison.
 */
export function pathShape(path: string): string {
  return normalizePath(path).replace(/\{[^}]*\}/g, "{}");
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
 * Turn a normalized route path into a matcher for concrete request
 * paths. `{param}` stands for exactly one path segment, and `*` crosses
 * segment boundaries and can be empty, which is how Express 4 reads a
 * bare star. Everything else compares literally, on the normalized
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
    groundName(semantics, deployedAs) {
      if (semantics.path === null) {
        return null;
      }
      const opening = OPENING_HOLE.exec(semantics.path);
      if (opening === null) {
        return null;
      }
      const [, label, rest] = opening;
      const base = deployedAs(variableOf(label));
      if (base === null) {
        return null;
      }
      const grounded = pathAfterOrigin(`${base}${rest}`);
      return { ...semantics, path: grounded === "" ? "/" : grounded };
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
