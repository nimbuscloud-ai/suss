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
  /** Of those, how many ran while a template was rendering, and which templates. */
  duringRender: number;
  templates: string[];
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
  const statement = textAttribute(
    span.attributes,
    "db.query.text",
    "db.statement",
  );
  const dialect = SQL_DIALECTS[system];
  const tables = tablesOfSpan(named, statement, dialect);
  if (tables.length === 0) {
    return {
      setAside:
        statement === undefined
          ? `a ${system} span with no table`
          : `a ${system} statement with no table in it`,
    };
  }
  const own = tables.filter((table) => !isCatalog(table));
  if (own.length === 0) {
    return { setAside: `a read of the ${system} catalog` };
  }
  return {
    targets: own.map((table) => ({
      kind: "storage",
      system,
      table: lastPart(table),
    })),
  };
}

function tablesOfSpan(
  named: string | undefined,
  statement: string | undefined,
  dialect: string | undefined,
): string[] {
  if (named !== undefined) {
    return [named];
  }
  if (statement === undefined || dialect === undefined) {
    return [];
  }
  return tablesIn(statement, dialect);
}

// The database's own catalog, which schema introspection reads and application code never mentions.
const CATALOG = /^(sqlite_|pg_)|(^|\.)(information_schema|pg_catalog)\./i;

function isCatalog(table: string): boolean {
  return CATALOG.test(table);
}

// A test run repeats a few hundred statements hundreds of thousands of times, and parsing is the slow part.
const PARSED = new Map<string, string[]>();

function tablesIn(statement: string, dialect: string): string[] {
  const key = `${dialect}\n${statement}`;
  const known = PARSED.get(key);
  if (known !== undefined) {
    return known;
  }
  // Python drivers write a bind as %(name)s or %s, which no SQL grammar reads.
  const bound = statement.replace(/%\(\w+\)s|%s/g, "$1");
  const named = commonTableExpressions(statement);
  const tables = [
    ...new Set(
      readSqlAccess(bound, { dialect })
        .filter((access) => !named.has(access.table.toLowerCase()))
        .map((access) => [...access.qualifier, access.table].join(".")),
    ),
  ];
  PARSED.set(key, tables);
  return tables;
}

// The parser reads a CTE declared inside a join's subquery as a table, so its name is dropped here.
const CTE_NAME =
  /(?:\bwith\s+(?:recursive\s+)?|,\s*)["`]?(\w+)["`]?\s+as\s*\(/gi;

function commonTableExpressions(statement: string): Set<string> {
  return new Set(
    [...statement.matchAll(CTE_NAME)].map((match) =>
      (match[1] ?? "").toLowerCase(),
    ),
  );
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

/**
 * The path segments a request filled into its route's parameters. When
 * the route and the path have the same number of segments, those are
 * the ones under a `:name`, `{name}` or `*`. Otherwise every segment
 * the route does not spell out counts.
 */
function requestSegments(server: Span): Set<string> {
  const path =
    pathOnly(textAttribute(server.attributes, "url.path", "http.target")) ?? "";
  const route = withoutOptionalFormat(
    textAttribute(server.attributes, "http.route") ?? "",
  );
  const given = path
    .split("/")
    .filter((segment) => segment !== "")
    .map(decoded);
  const template = route.split("/").filter((segment) => segment !== "");
  if (given.length === template.length) {
    return new Set(
      given.filter((_, index) => /[:{*]/.test(template[index] ?? "")),
    );
  }
  const fixed = new Set(template.filter((segment) => !/[:{*(]/.test(segment)));
  return new Set(given.filter((segment) => !fixed.has(segment)));
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The template a span renders, when it is one: Rails' ActionView writes
 * `render_template.action_view` with the file as `identifier`, and
 * Python's Jinja2 instrumentation writes `jinja2.render`.
 */
function templateOf(span: Span): string | null {
  if (!/^render_\w+\.action_view$|^jinja2\.render$|^render\b/.test(span.name)) {
    return null;
  }
  return (
    textAttribute(
      span.attributes,
      "identifier",
      "jinja2.template_name",
      "code.filepath",
    ) ?? span.name
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
  const nearestServer = (
    span: Span,
  ): { server: Span; template: string | null } | undefined => {
    let at = parentOf(span);
    let template: string | null = null;
    while (at !== undefined && at.kind !== "server") {
      template ??= templateOf(at);
      at = parentOf(at);
    }
    return at === undefined ? undefined : { server: at, template };
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
      const found = nearestServer(span);
      if (found === undefined) {
        putAside("a reach outside any request", span);
        continue;
      }
      const { server, template } = found;
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
        const known = edges.get(key) ?? {
          entry,
          target,
          count: 0,
          duringRender: 0,
          templates: [],
          evidence: [],
        };
        edges.set(key, known);
        if (fromRequest) {
          known.tableFromRequest = true;
        }
        if (template !== null) {
          known.duringRender += 1;
          if (!known.templates.includes(template)) {
            known.templates.push(template);
          }
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
