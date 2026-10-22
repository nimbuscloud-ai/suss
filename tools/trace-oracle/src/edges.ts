/**
 * Turns spans into edges: from the route a request came in on to each
 * table, outbound host or message destination the request reached.
 *
 * The mapping reads only OpenTelemetry semantic convention attributes,
 * old and new spellings both, so it applies to any language's
 * instrumentation. A request is a server span with `http.route`. A
 * reach is any span under it with database, outbound HTTP or messaging
 * attributes, attributed to the nearest server span above it, so a
 * request that calls another service in the same trace keeps that
 * service's reaches apart from its own.
 */

import { readSqlAccess } from "@suss/sql";

import { textAttribute } from "./spans.js";

import type { AttributeValue, Span } from "./spans.js";

export type EdgeKind = "storage" | "http" | "messaging";

export interface RouteEntry {
  method: string;
  /** The route template as the framework wrote it, such as `/users/:id`. */
  route: string;
  /** One concrete path a request used, for a route suss spells differently. */
  examplePath: string | null;
  /** Where the instrumentation says the handler is, when it says. */
  code: { namespace?: string; function?: string; file?: string };
}

export type Target =
  | { kind: "storage"; system: string; table: string }
  | { kind: "http"; method: string; host: string; path: string }
  | { kind: "messaging"; system: string | null; destination: string };

export interface Evidence {
  traceId: string;
  spanId: string;
  /** The instrumentation that wrote the span, which says which library made the call. */
  scope: string;
  /** The attributes the edge was read from. */
  attributes: Record<string, AttributeValue>;
}

export interface TracedEdge {
  entry: RouteEntry;
  target: Target;
  /**
   * True when a request's own path gave the table, as `/items/orders`
   * gives `orders`. No reading of the source can settle that name, so
   * the report counts these edges apart.
   */
  tableFromRequest?: boolean;
  /** How many spans showed this edge. */
  count: number;
  /** The first few spans that showed it. */
  evidence: Evidence[];
}

/** Spans the oracle could not turn into an edge, counted so the report can say how many it set aside. */
export interface SetAside {
  reason: string;
  count: number;
  example: Evidence;
}

export interface Extraction {
  edges: TracedEdge[];
  /** Every route a request came in on, with how many requests. */
  routes: Array<{ entry: RouteEntry; requests: number }>;
  setAside: SetAside[];
}

export interface ExtractOptions {
  /** Keep a request only when its resource attribute contains this text. */
  resourceFilters?: ReadonlyArray<{ key: string; text: string }>;
  /** Keep a request only when `METHOD route` matches. */
  entryPattern?: RegExp;
}

const EVIDENCE_KEPT = 3;

export function entryKey(entry: Pick<RouteEntry, "method" | "route">): string {
  return `${entry.method} ${entry.route}`;
}

export function targetKey(target: Target): string {
  return TARGET_KEYS[target.kind](target as never);
}

const TARGET_KEYS: {
  [K in EdgeKind]: (target: Extract<Target, { kind: K }>) => string;
} = {
  storage: (target) => `${target.system}:${target.table}`,
  http: (target) => `${target.method} ${target.host}${target.path}`,
  messaging: (target) => `${target.system ?? "?"}:${target.destination}`,
};

/** Rails writes an optional format on every route, which a request never names. */
function withoutOptionalFormat(route: string): string {
  return route.replace(/\(\.:format\)$/, "");
}

function pathOnly(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  try {
    return new URL(raw, "http://placeholder").pathname;
  } catch {
    return raw.split("?")[0] ?? null;
  }
}

function routeEntryOf(span: Span): RouteEntry | null {
  if (span.kind !== "server") {
    return null;
  }
  const route = textAttribute(span.attributes, "http.route");
  const method = textAttribute(
    span.attributes,
    "http.request.method",
    "http.method",
  );
  if (route === undefined || method === undefined) {
    return null;
  }
  const namespace = textAttribute(span.attributes, "code.namespace");
  const fn = textAttribute(
    span.attributes,
    "code.function",
    "code.function.name",
  );
  const file = textAttribute(
    span.attributes,
    "code.filepath",
    "code.file.path",
  );
  return {
    method: method.toUpperCase(),
    route: withoutOptionalFormat(route),
    examplePath: pathOnly(
      textAttribute(span.attributes, "url.path", "http.target"),
    ),
    code: {
      ...(namespace === undefined ? {} : { namespace }),
      ...(fn === undefined ? {} : { function: fn }),
      ...(file === undefined ? {} : { file }),
    },
  };
}

/** The dialect @suss/sql parses a statement in, by the `db.system` a span gives. */
const SQL_DIALECTS: Record<string, string> = {
  postgresql: "postgresql",
  postgres: "postgresql",
  cockroachdb: "postgresql",
  mysql: "mysql",
  mariadb: "mysql",
  sqlite: "sqlite",
};

type TargetRead = { targets: Target[] } | { setAside: string } | null;

function storageTargets(span: Span): TargetRead {
  const system = textAttribute(span.attributes, "db.system.name", "db.system");
  if (system === undefined) {
    return null;
  }
  const named = textAttribute(
    span.attributes,
    "db.collection.name",
    "db.sql.table",
    "db.mongodb.collection",
    "db.cassandra.table",
  );
  if (named !== undefined) {
    return { targets: [{ kind: "storage", system, table: lastPart(named) }] };
  }
  const statement = textAttribute(
    span.attributes,
    "db.query.text",
    "db.statement",
  );
  const dialect = SQL_DIALECTS[system];
  if (statement === undefined || dialect === undefined) {
    return { setAside: `a ${system} span with no table` };
  }
  const tables = tablesIn(statement, dialect);
  if (tables.length === 0) {
    return { setAside: `a ${system} statement with no table in it` };
  }
  return {
    targets: tables.map((table) => ({ kind: "storage", system, table })),
  };
}

// A test run repeats a few hundred statements hundreds of thousands of times, and parsing is the slow part.
const PARSED = new Map<string, string[]>();

function tablesIn(statement: string, dialect: string): string[] {
  const key = `${dialect}\n${statement}`;
  const known = PARSED.get(key);
  if (known !== undefined) {
    return known;
  }
  const tables = [
    ...new Set(
      readSqlAccess(statement, { dialect }).map((access) => access.table),
    ),
  ];
  PARSED.set(key, tables);
  return tables;
}

function lastPart(name: string): string {
  return name.split(".").pop() ?? name;
}

function httpTargets(span: Span): TargetRead {
  if (span.kind !== "client") {
    return null;
  }
  const method = textAttribute(
    span.attributes,
    "http.request.method",
    "http.method",
  );
  if (method === undefined) {
    return null;
  }
  const full = textAttribute(span.attributes, "url.full", "http.url");
  let parsed: URL | null = null;
  try {
    parsed = full === undefined ? null : new URL(full);
  } catch {
    parsed = null;
  }
  const host =
    textAttribute(span.attributes, "server.address", "net.peer.name") ??
    parsed?.hostname;
  const path =
    textAttribute(span.attributes, "url.template") ??
    parsed?.pathname ??
    pathOnly(textAttribute(span.attributes, "url.path", "http.target")) ??
    undefined;
  if (host === undefined || path === undefined) {
    return { setAside: "an outbound request with no host or path" };
  }
  return {
    targets: [{ kind: "http", method: method.toUpperCase(), host, path }],
  };
}

function messagingTargets(span: Span): TargetRead {
  const destination = textAttribute(
    span.attributes,
    "messaging.destination.name",
  );
  if (
    destination === undefined ||
    span.kind === "consumer" ||
    span.kind === "server"
  ) {
    return null;
  }
  return {
    targets: [
      {
        kind: "messaging",
        system: textAttribute(span.attributes, "messaging.system") ?? null,
        destination,
      },
    ],
  };
}

const TARGET_READERS: Record<EdgeKind, (span: Span) => TargetRead> = {
  storage: storageTargets,
  http: httpTargets,
  messaging: messagingTargets,
};

function evidenceOf(span: Span): Evidence {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    scope: span.scope,
    attributes: span.attributes,
  };
}

function requestSegments(server: Span): Set<string> {
  const path =
    pathOnly(textAttribute(server.attributes, "url.path", "http.target")) ?? "";
  return new Set(
    path
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      }),
  );
}

function keptByFilters(
  span: Span,
  options: ExtractOptions,
  entry: RouteEntry,
): boolean {
  for (const filter of options.resourceFilters ?? []) {
    const value = span.resource[filter.key];
    if (value === undefined || !String(value).includes(filter.text)) {
      return false;
    }
  }
  return options.entryPattern?.test(entryKey(entry)) ?? true;
}

export function extractEdges(
  spans: readonly Span[],
  options: ExtractOptions = {},
): Extraction {
  const bySpan = new Map<string, Span>();
  for (const span of spans) {
    bySpan.set(`${span.traceId}/${span.spanId}`, span);
  }
  const entries = new Map<string, RouteEntry | null>();
  const entryOf = (span: Span): RouteEntry | null => {
    const key = `${span.traceId}/${span.spanId}`;
    if (!entries.has(key)) {
      const own = routeEntryOf(span);
      entries.set(
        key,
        own !== null && keptByFilters(span, options, own) ? own : null,
      );
    }
    return entries.get(key) ?? null;
  };
  const parentOf = (span: Span): Span | undefined =>
    span.parentSpanId === null
      ? undefined
      : bySpan.get(`${span.traceId}/${span.parentSpanId}`);
  const nearestServer = (span: Span): Span | undefined => {
    let at = parentOf(span);
    while (at !== undefined && at.kind !== "server") {
      at = parentOf(at);
    }
    return at;
  };

  const edges = new Map<string, TracedEdge>();
  const routes = new Map<string, { entry: RouteEntry; requests: number }>();
  const setAside = new Map<string, SetAside>();
  const putAside = (reason: string, span: Span): void => {
    const known = setAside.get(reason);
    if (known === undefined) {
      setAside.set(reason, { reason, count: 1, example: evidenceOf(span) });
      return;
    }
    known.count += 1;
  };

  for (const span of spans) {
    const own = span.kind === "server" ? entryOf(span) : null;
    if (own !== null) {
      const known = routes.get(entryKey(own));
      routes.set(entryKey(own), {
        entry: known?.entry ?? own,
        requests: (known?.requests ?? 0) + 1,
      });
    }
    for (const read of Object.values(TARGET_READERS)) {
      const result = read(span);
      if (result === null) {
        continue;
      }
      const server = nearestServer(span);
      if (server === undefined) {
        putAside("a reach outside any request", span);
        continue;
      }
      const entry = entryOf(server);
      if (entry === null) {
        putAside(
          "a reach under a request with no route, or one the filters left out",
          span,
        );
        continue;
      }
      if ("setAside" in result) {
        putAside(result.setAside, span);
        continue;
      }
      const segments = requestSegments(server);
      for (const target of result.targets) {
        const key = `${entryKey(entry)} -> ${targetKey(target)}`;
        const fromRequest =
          target.kind === "storage" && segments.has(target.table);
        const known = edges.get(key);
        if (known === undefined) {
          edges.set(key, {
            entry,
            target,
            count: 1,
            evidence: [evidenceOf(span)],
            ...(fromRequest ? { tableFromRequest: true } : {}),
          });
          continue;
        }
        if (fromRequest) {
          known.tableFromRequest = true;
        }
        known.count += 1;
        if (known.evidence.length < EVIDENCE_KEPT) {
          known.evidence.push(evidenceOf(span));
        }
      }
    }
  }
  return {
    edges: [...edges.values()],
    routes: [...routes.values()],
    setAside: [...setAside.values()].sort((a, b) => b.count - a.count),
  };
}
