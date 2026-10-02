/**
 * The REST protocol as a boundary.
 *
 * A boundary here is one route, identified by an HTTP method and a
 * path. The method can be `"*"` for a handler that responds to every
 * method, or null when the source never says which method. The path is
 * null when the source never gives one. An empty string is invalid in
 * both fields, because a blank value with a special meaning is easy for
 * a reader to miss.
 *
 * `normalizePath`, `methodsAgree` and `routePathAdmits` are exported
 * because more than one checker compares paths and methods, and they
 * all have to do it the same way.
 */

import { z } from "zod";

import { patternHole, referenceFromName } from "../boundaryName.js";
import { hostCanBeOwn, pathAfterOrigin } from "../urlPath.js";
import { defineBoundarySemantics } from "./definition.js";
import {
  isCatchAll,
  pathAfterBaseUrl,
  pathSpansShapes,
  pathsMeet,
  patternAdmits,
  requestRank,
} from "./pathPattern.js";

import type { Reference } from "../boundaryName.js";
import type { Deployment } from "../deployment.js";

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
   * Status codes the producing source declared explicitly, such as
   * OpenAPI responses or CloudFormation MethodResponses. They are kept
   * here so the pairing layer can see them without unwrapping any
   * metadata. Absent or empty for an inferred source.
   */
  declaredResponses: z.array(z.number()).optional(),
  /**
   * The host a client wrote in an absolute URL, with its port
   * (`api.example.com:8443`). A piece suss could not read is written
   * `{name}`. Absent for a relative URL and for a route.
   */
  host: z.string().min(1).optional(),
  /**
   * True for a route the framework also serves with `.{format}` after
   * its path, the way Rails serves `/search.json` from `get "search"`.
   */
  optionalFormat: z.boolean().optional(),
});

export type RestSemantics = z.infer<typeof RestSemanticsSchema>;

/** A path that opens with a hole, and the rest of the path after it. */
const OPENING_HOLE = /^\{([^{}]+)\}(.*)$/;

/**
 * The reference for a base URL the source left open. Only a hole at the
 * front of the path is a base URL. A hole further along is a route
 * parameter: `/orders/{id}` means every id, and no variable sets it.
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
  let normalized = withoutParameterConstraints(path).replace(
    /:([a-zA-Z_]\w*)([?+*]?)/g,
    "{$1$2}",
  );

  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  normalized = normalized.replace(/\{[^}]+\}|[^{]+/g, (segment) =>
    segment.startsWith("{") ? segment : segment.toLowerCase(),
  );

  return normalized;
}

/**
 * The path with the pattern Express lets a parameter carry,
 * `/:pk([0-9a-f]{8})`, left out. The pattern narrows the values the
 * parameter takes, and the parameter is still one segment. Parentheses
 * that follow anything but a parameter name are kept.
 */
function withoutParameterConstraints(path: string): string {
  let out = "";
  let i = 0;
  while (i < path.length) {
    const name = /^:[a-zA-Z_]\w*\(/.exec(path.slice(i));
    if (name === null) {
      out += path[i];
      i += 1;
      continue;
    }
    const open = i + name[0].length - 1;
    const close = closingParenthesis(path, open);
    if (close === -1) {
      return out + path.slice(i);
    }
    out += path.slice(i, open);
    i = close + 1;
  }
  return out;
}

/** Where the group opened at `open` closes, skipping escaped characters, or -1. */
function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * A path with every parameter name removed, for comparing two paths.
 * `/users/{id}` and `/users/:userId` both become `/users/{}`, since a
 * parameter's name does not change which requests the path serves. A
 * parameter's range stays, since `{tenant?}` serves a different set of
 * requests from `{tenant}`.
 */
export function pathShape(path: string): string {
  return normalizePath(path).replace(/\{[^{}]*?([?+*]?)\}/g, "{$1}");
}

/**
 * Whether two REST methods mean the same thing. Equal methods agree,
 * and `"*"` agrees with any given method, because a handler that
 * responds to every method responds to this one. A null method means
 * the source never gave one, so it agrees with nothing.
 *
 * This is the REST counterpart of `busesAgree`. There is no list of
 * known methods, so a wildcard pairs with whatever methods consumers
 * write.
 */
export function methodsAgree(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return false;
  }
  return a === b || a === "*" || b === "*";
}

/**
 * Whether a declared route path admits a concrete request path. Both
 * are normalized first. A hole in the request path is compared as plain
 * text, so a mount pattern admits a route inside it and rejects a wider
 * route.
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

/** The host when suss read all of it, and undefined otherwise. */
function readHost(semantics: RestSemantics): string | undefined {
  const host = semantics.host;
  return host === undefined || /[{(]/.test(host) ? undefined : host;
}

/**
 * Whether the sides name one host. A side with no host, or with one suss
 * could not read, can be anywhere, so two such sides agree.
 */
function hostsAgree(a: RestSemantics, b: RestSemantics): boolean {
  return readHost(a) === readHost(b);
}

/** Whether the client left open where the call goes: in its host, or in a base URL. */
function hostUnread(semantics: RestSemantics): boolean {
  if (semantics.host !== undefined) {
    return readHost(semantics) === undefined;
  }
  return baseUrlReference(semantics) !== null;
}

/** The paths a route serves, with the `.{format}` a framework adds. */
function servedPath(semantics: RestSemantics, path: string): string {
  const normalized = normalizePath(path);
  return semantics.optionalFormat === true
    ? `${normalized}(|.{format})`
    : normalized;
}

function withoutHost(semantics: RestSemantics): RestSemantics {
  const { host: _host, ...rest } = semantics;
  return rest;
}

/** The semantics with a base URL the deployment sets filled in, or null. */
function groundedBaseUrl(
  semantics: RestSemantics,
  deployment: Deployment,
): RestSemantics | null {
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
    leavesTheProcess: true,
    reportsUnpairedItself: false,
    /** `"METHOD /normalized/path"`, or null when either half is missing. */
    identityKey(semantics) {
      if (semantics.method === null || semantics.path === null) {
        return null;
      }
      return `${semantics.method.toUpperCase()} ${normalizePath(semantics.path)}`;
    },
    /**
     * The bucket has only the path, so a `"*"` route lands with the
     * consumers that each give a method, and `methodsAgree` compares the
     * methods inside the bucket. The identity key is still what a reader
     * sees and what a suppression targets ("GET /users", "* /users").
     *
     * Parameter names are dropped too. A hand-written spec writes
     * `{userId}` where the Express route that serves it writes `:id`,
     * and both match the same requests. Pairing on the name would leave
     * two boundaries that never meet.
     */
    pairingKey(semantics) {
      if (semantics.method === null || semantics.path === null) {
        return null;
      }
      const shape = pathShape(pathAfterBaseUrl(normalizePath(semantics.path)));
      const host = readHost(semantics);
      return host === undefined ? `rest ${shape}` : `rest //${host}${shape}`;
    },
    /**
     * A spec writes `/teams/{team_id}` where the route that serves it
     * writes `/teams/:id`. The method stays in, so a `"*"` handler is
     * never compared with the document for one method.
     */
    operationKey(semantics) {
      if (semantics.method === null || semantics.path === null) {
        return null;
      }
      return `${semantics.method.toUpperCase()} ${pathShape(semantics.path)}`;
    },
    sidesAgree(a, b) {
      return methodsAgree(a.method, b.method) && hostsAgree(a, b);
    },
    spansBuckets(semantics) {
      return (
        semantics.path !== null &&
        (semantics.optionalFormat === true ||
          pathSpansShapes(normalizePath(semantics.path)))
      );
    },
    bucketsMeet(a, b) {
      return (
        a.path !== null &&
        b.path !== null &&
        hostsAgree(a, b) &&
        pathsMeet(servedPath(a, a.path), servedPath(b, b.path))
      );
    },
    /**
     * A catch-all route never takes a call whose host suss could not
     * read, since nothing else ties that call to this app.
     */
    pairRank(provider, consumer) {
      if (provider.path === null || consumer.path === null) {
        return [];
      }
      if (hostUnread(consumer) && isCatchAll(normalizePath(provider.path))) {
        return null;
      }
      return requestRank(
        servedPath(provider, provider.path),
        normalizePath(consumer.path),
      );
    },
    /**
     * The identity key, with a missing half still readable: `ANY` when
     * the source gave no method, and `?` when it gave no path. Null when
     * both are missing, since then there is nothing to show.
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
     * With both halves present, the method goes through `methodsAgree`
     * (so a `"*"` route matches every method) and the path through
     * `routePathAdmits`. A route missing either half might still handle
     * the request, and this declaration cannot settle that, so the
     * result is `"unknown"`.
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
     * without a path counts as outside, because nothing shows that the
     * pattern covers it.
     */
    withinScope(semantics, scope) {
      return semantics.path !== null && routePathAdmits(scope, semantics.path);
    },
    /**
     * A call whose base URL the deployment fills in, resolved to the
     * path it reaches, and a call to a host that can be the project's
     * own, with the host left out so it meets the route.
     *
     * The source cannot settle a base URL on its own, so the adapter
     * leaves the hole in. `API_BASE` could be `http://backend.internal`,
     * and then the path is `/orders`. It could equally be `/api/v2`, and
     * then the path is `/api/v2/orders`. Filling in the deployed value
     * and reading the path back out gets the right one either way, and
     * a base the deployment sets counts as the app's own.
     */
    groundName(semantics, deployment) {
      const based = groundedBaseUrl(semantics, deployment);
      const grounded = based ?? semantics;
      const host = readHost(grounded);
      return host !== undefined && hostCanBeOwn(host)
        ? withoutHost(grounded)
        : based;
    },
    nameReference: baseUrlReference,
    ruleBoundary: {
      // "METHOD /path": one token, a space, then an absolute path.
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
