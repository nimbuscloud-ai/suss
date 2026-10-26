/**
 * Writes the map: one HTML file with its styles, script and data inline,
 * so it opens from disk and asks the network for nothing.
 *
 * The page goes overview, then detail. Tiles count what the code serves
 * and touches, a few cards say what stood out, a faceted list has every
 * route, field, table and variable, and an inspector opens one of them.
 * The parts above the list are written here so they read with scripts
 * off; the list, the inspector, the search and the hover cards are built
 * in the browser from the same model.
 */

import { gzipSync } from "node:zlib";

import { entryNoun, firstPerTable } from "./mapCards.js";
import pageScript from "./mapClient.js?raw";
import { count, esc, fromTag, joinWords, plural, unitLink } from "./mapHtml.js";
import { ICONS, icon } from "./mapIcons.js";
import pageStyle from "./mapPage.css?raw";
import { renderCards } from "./mapPageCards.js";
import { pageDataOf } from "./mapPageData.js";

import type { Card } from "./mapCards.js";
import type { MapEntry, MapModel } from "./mapModel.js";
import type { CardContext } from "./mapPageCards.js";

export interface PageOptions {
  /** The folder a reader passes to `suss ask --dir` to check a number on the page. */
  summariesDir: string;
  /** Lines of a unit's file, numbered from `start`; empty when the file cannot be read. */
  sourceLines: CardContext["sourceLines"];
}

/** The display name of a pack that serves entry points. A pack missing here shows by its own name. */
const FRAMEWORK_NAMES: Record<string, string> = {
  rails: "Rails",
  fastapi: "FastAPI",
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  "flask-restx": "Flask",
  "nestjs-rest": "NestJS",
  "nestjs-graphql": "NestJS",
  "graphql-ruby": "graphql-ruby",
  apollo: "Apollo Server",
  "ts-rest": "ts-rest",
  nextjs: "Next.js",
  "aws-lambda": "AWS Lambda",
};

export function renderMapPage(
  model: MapModel,
  cards: readonly Card[],
  options: PageOptions,
): string {
  const dir = shellWord(options.summariesDir);
  const ctx: CardContext = {
    model,
    ask: (question) => `suss ask "${question}" --dir ${dir}`,
    check: `suss check --dir ${dir} --json`,
    sourceLines: options.sourceLines,
  };
  const { data: pageData, findings } = pageDataOf(model);
  const data = JSON.stringify({
    ...pageData,
    icons: ICONS,
    askDir: dir,
  }).replace(/</g, "\\u003c");
  const name = esc(model.project.name);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} · suss map</title>
<meta name="description" content="What suss read in ${name}: the routes and fields it serves, the tables they touch, and what suss could not follow.">
<style>${pageStyle}</style>
</head>
<body>
<header class="bar">
  <div class="bar-inner">
    <a class="brand" href="#top" aria-label="Back to top">${MARK}<span class="brand-word">suss</span></a>
    <span class="bar-repo">${name}</span>
    <div class="search" role="search">
      <svg class="search-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14 14l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
      <input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="Jump to a route, field or table" aria-label="Jump to a route, field, type, table or variable" aria-controls="results" aria-expanded="false">
      <kbd class="kbd" aria-hidden="true">/</kbd>
      <div id="results" class="results" role="listbox" hidden></div>
    </div>
  </div>
</header>
<main id="top">
  <section class="intro">
    <p class="eyebrow">${eyebrow(model)}</p>
    <h1>${name}</h1>
    ${tiles(model)}
  </section>

  <section class="lead" aria-labelledby="lead-h">
    <div class="section-head"><h2 id="lead-h">Worth knowing</h2></div>
    ${renderCards(cards, ctx)}
  </section>

  <section class="explore" id="explore" aria-labelledby="explore-h">
    <div class="section-head"><h2 id="explore-h">Browse</h2></div>
    <div class="tabs" role="tablist" aria-label="What to list">
      ${tabs(model)}
    </div>
    <div class="workbench">
      <details class="facets-wrap" id="facets-wrap" open>
        <summary class="facets-toggle">${icon("filter", "i-go")}Filters</summary>
        <div class="facets" id="facets"></div>
      </details>
      <div class="listing">
        <div class="list-tools">
          <input id="filter" type="search" autocomplete="off" spellcheck="false" placeholder="Filter by path, name or file" aria-label="Filter the list">
          <p class="list-count" id="list-count" aria-live="polite"></p>
        </div>
        <div class="tokens" id="tokens"></div>
        <div id="panel" class="panel" role="tabpanel"><p class="empty">The list needs JavaScript.</p></div>
      </div>
    </div>
  </section>

  ${coverage(model, ctx)}

  <footer class="foot">
    <span>Written by suss map from ${plural(model.reads.length, "summary file", "summary files")} in <code>${esc(options.summariesDir)}</code>. Nothing was run.</span>
    <label>Open links in <select id="editor" aria-label="Which editor links open in"><option value="vscode">VS Code</option><option value="cursor">Cursor</option><option value="file">the browser</option><option value="github">GitHub</option></select></label>
  </footer>
</main>
<div id="scrim" class="scrim" hidden></div>
<aside id="drawer" class="drawer" aria-labelledby="drawer-title" hidden tabindex="-1">
  <div class="drawer-bar"><span class="drawer-crumb" id="drawer-crumb"></span><button type="button" class="close" id="close" aria-label="Close the panel">${icon("close", "i-go")}<kbd>Esc</kbd></button></div>
  <div id="drawer-body" class="drawer-body"></div>
</aside>
<div id="tip" class="tip" role="tooltip" hidden></div>
<script id="data" type="application/json">${data}</script>
<script id="findings" type="application/gzip">${compressedJson(findings)}</script>
<script>${pageScript}</script>
</body>
</html>
`;
}

/**
 * JSON gzipped and written as base64, which the page inflates the first
 * time it needs it. Finding text repeats one template per kind, so it
 * shrinks several times over, and a page with thousands of findings
 * stays small and parses quickly.
 */
function compressedJson(value: unknown): string {
  return gzipSync(JSON.stringify(value)).toString("base64");
}

const MARK = `<svg class="mark" viewBox="0 0 32 32" fill="none" stroke-width="5.4" stroke-linecap="round" aria-hidden="true"><path d="M23.5 9.6C23.5 6.6 20.6 5 16 5C11.4 5 8.6 7.2 8.6 10.6C8.6 14.2 11.8 15.6 16 16" stroke="var(--mark-1)"/><path d="M16 16C20.2 16.4 23.4 17.8 23.4 21.4C23.4 24.8 20.6 27 16 27C11.4 27 8.5 25.4 8.5 22.4" stroke="var(--mark-2)"/></svg>`;

function eyebrow(model: MapModel): string {
  const frameworks = [
    ...new Set(
      model.project.frameworks.map((name) => FRAMEWORK_NAMES[name] ?? name),
    ),
  ];
  return [joinWords(frameworks), joinWords(model.project.languages)]
    .filter((part) => part !== "")
    .map((part) => `<span>${esc(part)}</span>`)
    .join('<span class="dot" aria-hidden="true">·</span>');
}

// ---------------------------------------------------------------------------
// Overview tiles
// ---------------------------------------------------------------------------

function tile(
  facet: string,
  n: number,
  label: string,
  facts: readonly string[],
): string {
  return `<div class="tile">
  <button type="button" class="tile-main" data-facet="${esc(facet)}"><span class="tile-n">${count(n)}</span><span class="tile-l">${esc(label)}</span></button>
  ${facts.length > 0 ? `<ul class="tile-facts">${facts.map((fact) => `<li>${fact}</li>`).join("")}</ul>` : ""}
</div>`;
}

function fact(facet: string, iconHtml: string, text: string): string {
  return `<button type="button" class="tile-fact" data-facet="${esc(facet)}">${iconHtml}<span>${esc(text)}</span></button>`;
}

function note(text: string): string {
  return `<span class="tile-note">${esc(text)}</span>`;
}

function tiles(model: MapModel): string {
  const rest = model.entries.filter((entry) => entry.kind === "rest");
  const fields = model.entries.filter((entry) => entry.kind === "graphql");
  const parts: string[] = [];

  if (rest.length > 0 || fields.length === 0) {
    const writing = rest.filter(
      (entry) => firstPerTable(model, entry.reach, "writes").length > 0,
    ).length;
    const failing = rest.filter((entry) =>
      entry.outcomes.some((o) => o.status !== null && o.status >= 400),
    ).length;
    const called = rest.filter((entry) => entry.callers.length > 0).length;
    parts.push(
      tile("routes:", rest.length, "Routes", [
        ...(writing > 0
          ? [
              fact(
                "routes:db=writes",
                icon("write", "i-write"),
                `${count(writing)} write a table`,
              ),
            ]
          : []),
        ...(failing > 0
          ? [
              fact(
                "routes:status=error",
                `<span class="status s-4xx">4xx</span>`,
                `${count(failing)} can return an error`,
              ),
            ]
          : []),
        ...(called > 0
          ? [
              fact(
                "routes:caller=has",
                icon("check", "i-check"),
                `${count(called)} with a caller here`,
              ),
            ]
          : []),
      ]),
    );
  }

  if (fields.length > 0) {
    const byType = (type: string) =>
      fields.filter((entry) => entry.method === type).length;
    const called = fields.filter((entry) => entry.callers.length > 0).length;
    const unread = fields.filter((entry) => entry.unread).length;
    parts.push(
      tile("graphql:", fields.length, "GraphQL fields", [
        fact(
          "graphql:type=Query",
          icon("route", "i-go"),
          `${count(byType("Query"))} queries`,
        ),
        fact(
          "graphql:type=Mutation",
          icon("write", "i-write"),
          `${count(byType("Mutation"))} mutations`,
        ),
        ...(called > 0
          ? [
              fact(
                "graphql:caller=none",
                icon("partial", "i-partial"),
                `${count(fields.length - called)} with no caller here`,
              ),
            ]
          : []),
        ...(unread > 0
          ? [
              fact(
                "graphql:read=no",
                icon("partial", "i-partial"),
                `${count(unread)} not read`,
              ),
            ]
          : []),
      ]),
    );
  }

  if (model.pages.length > 0) {
    parts.push(tile("pages:", model.pages.length, "Pages", []));
  }

  const busiest = busiestTable(model);
  parts.push(
    tile(
      "tables:",
      model.tables.length,
      "Tables",
      busiest === null
        ? []
        : [
            `<button type="button" class="tile-fact" data-open="table-${busiest.boundary}">${icon("write", "i-write")}<span>Most written: ${esc(model.boundaries[busiest.boundary]?.name)} (${count(busiest.entries)})</span></button>`,
          ],
    ),
  );

  const variables = envVariables(model);
  parts.push(
    tile(
      "env:",
      variables.all,
      "Env vars",
      variables.defaulted > 0
        ? [
            fact(
              "env:default=yes",
              icon("env", "i-env"),
              `${count(variables.defaulted)} with a default`,
            ),
          ]
        : [],
    ),
  );

  const placed = model.findings.filter((finding) => finding.entry !== null);
  parts.push(
    tile(
      "routes:caller=has",
      model.check.pairs,
      "Pairs checked",
      model.check.pairs === 0
        ? [note("No caller found here")]
        : [
            fact(
              `${fields.length > rest.length ? "graphql" : "routes"}:caller=finding`,
              icon("clash", "i-clash"),
              plural(placed.length, "finding", "findings"),
            ),
          ],
    ),
  );

  const { coverage } = model;
  parts.push(
    `<div class="tile"><a class="tile-main" href="#coverage"><span class="tile-n">${count(coverage.unfollowedCalls)}</span><span class="tile-l">Calls not followed</span></a><ul class="tile-facts"><li>${note(`in ${plural(coverage.withUnfollowed, "function", "functions")}`)}</li><li>${fact(
      `${fields.length > rest.length ? "graphql" : "routes"}:partial=yes`,
      icon("partial", "i-partial"),
      `${plural(coverage.entriesAffected, ...entryNoun(model))} affected`,
    )}</li></ul></div>`,
  );

  return `<div class="tiles">${parts.join("\n")}</div>`;
}

/** The table the most entry points write, with how many. */
function busiestTable(
  model: MapModel,
): { boundary: number; entries: number } | null {
  const writers = new Map<number, number>();
  for (const entry of model.entries) {
    for (const touch of firstPerTable(model, entry.reach, "writes")) {
      writers.set(touch.boundary, (writers.get(touch.boundary) ?? 0) + 1);
    }
  }
  const best = [...writers].sort((a, b) => b[1] - a[1])[0];
  return best === undefined ? null : { boundary: best[0], entries: best[1] };
}

function envVariables(model: MapModel): { all: number; defaulted: number } {
  const reads = new Map<number, boolean>();
  for (const read of model.envReads) {
    reads.set(
      read.boundary,
      (reads.get(read.boundary) ?? true) && read.defaulted,
    );
  }
  return {
    all: reads.size,
    defaulted: [...reads.values()].filter((always) => always).length,
  };
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function tabs(model: MapModel): string {
  const rest = model.entries.filter((entry) => entry.kind === "rest").length;
  const fields = model.entries.length - rest;
  const specs: Array<[string, boolean, string, string, number]> = [
    ["graphql", fields > 0, icon("route", "i-go"), "GraphQL", fields],
    ["routes", rest > 0 || fields === 0, icon("route", "i-go"), "Routes", rest],
    [
      "types",
      model.graphqlTypes.length > 0,
      icon("type", "i-go"),
      "Types",
      model.graphqlTypes.length,
    ],
    [
      "pages",
      model.pages.length > 0,
      icon("route", "i-go"),
      "Pages",
      model.pages.length,
    ],
    ["tables", true, icon("table", "i-table"), "Tables", model.tables.length],
    ["env", true, icon("env", "i-env"), "Env vars", envVariables(model).all],
  ];
  const first = fields > rest ? "graphql" : "routes";
  return specs
    .filter(([, show]) => show)
    .map(
      ([id, , iconHtml, label, n]) =>
        `<button type="button" role="tab" id="tab-${id}" data-tab="${id}" aria-selected="${id === first}" aria-controls="panel">${iconHtml}${label} <span class="tab-n">${count(n)}</span></button>`,
    )
    .join("\n      ");
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function coverage(model: MapModel, ctx: CardContext): string {
  return `<section class="trust" id="coverage" aria-labelledby="coverage-h">
  <div class="section-head"><h2 id="coverage-h">Coverage</h2></div>
  <div class="trust-grid">
    ${readBlock(model)}
    ${specBlock(model)}
    ${checkBlock(model, ctx)}
    ${unfollowedBlock(model)}
  </div>
</section>`;
}

function readBlock(model: MapModel): string {
  const rows = model.reads
    .map((read, at) => {
      if (read.spec) {
        return "";
      }
      const units = model.coverage.unitsPerRead[at] ?? 0;
      const found = foundIn(model, at);
      return `<tr><td><code>${esc(read.label)}</code></td><td class="num">${count(units)}</td><td>${read.packs.length > 0 ? read.packs.map((pack) => `<span class="pack">${esc(pack.split("=")[0])}</span>`).join(" ") : `<span class="muted">not recorded</span>`}</td><td>${found.length > 0 ? esc(found.join(", ")) : `<span class="muted">none</span>`}</td></tr>`;
    })
    .join("");
  return `<div class="trust-block trust-wide">
      <h3>${icon("read", "i-read")}Read</h3>
      <div class="table-wrap"><table class="read-table"><thead><tr><th>Read</th><th class="num">Functions</th><th>Packs</th><th>Found</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
}

/** What one read found, as counts a reader recognises. */
function foundIn(model: MapModel, read: number): string[] {
  const inRead = (unit: number) => model.units[unit]?.read === read;
  const routes = model.entries.filter(
    (entry) => entry.kind === "rest" && entry.units.some(inRead),
  ).length;
  const fields = model.entries.filter(
    (entry) => entry.kind === "graphql" && entry.units.some(inRead),
  ).length;
  const operations = model.operations.filter((op) => inRead(op.unit)).length;
  const clients = model.clients.filter((client) => inRead(client.unit)).length;
  const pages = model.pages.filter((page) => inRead(page.unit)).length;
  return [
    routes > 0 ? plural(routes, "route", "routes") : null,
    fields > 0 ? plural(fields, "GraphQL field", "GraphQL fields") : null,
    operations > 0
      ? plural(operations, "GraphQL operation", "GraphQL operations")
      : null,
    clients > 0 ? plural(clients, "HTTP call", "HTTP calls") : null,
    pages > 0 ? plural(pages, "page", "pages") : null,
  ].filter((part): part is string => part !== null);
}

function specBlock(model: MapModel): string {
  const specReads = model.reads
    .map((read, at) => ({ read, at }))
    .filter(({ at }) =>
      model.entries.some((entry) =>
        entry.specs.some((unit) => model.units[unit]?.read === at),
      ),
    );
  if (specReads.length === 0) {
    return "";
  }
  const rows = specReads
    .map(({ read, at }) => {
      const declared = model.entries.filter((entry) =>
        entry.specs.some((unit) => model.units[unit]?.read === at),
      );
      const served = declared.filter((entry) => entry.units.length > 0).length;
      const called = declared.filter(
        (entry) => entry.callers.length > 0,
      ).length;
      const missing = declared.filter((entry) => entry.units.length === 0);
      const missingText =
        missing.length === 0
          ? `<span class="muted">none</span>`
          : `${missing
              .slice(0, 4)
              .map((entry) => `<code>${esc(entryLabel(entry))}</code>`)
              .join(
                ", ",
              )}${missing.length > 4 ? ` and ${missing.length - 4} more` : ""}`;
      return `<tr><td><code>${esc(read.label)}</code></td><td class="num">${count(declared.length)}</td><td class="num">${count(served)}</td><td class="num">${count(called)}</td><td>${missingText}</td></tr>`;
    })
    .join("");
  return `<div class="trust-block trust-wide">
      <h3>${icon("read", "i-read")}Specs</h3>
      <div class="table-wrap"><table class="read-table"><thead><tr><th>Spec</th><th class="num">Declares</th><th class="num">Served</th><th class="num">Called here</th><th>Not served</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
}

function entryLabel(entry: MapEntry): string {
  return entry.kind === "rest"
    ? `${entry.method} ${entry.path}`
    : `${entry.method}.${entry.path}`;
}

function checkBlock(model: MapModel, ctx: CardContext): string {
  const rest = model.entries.filter((entry) => entry.kind === "rest");
  const fields = model.entries.filter((entry) => entry.kind === "graphql");
  const lines = [
    `<li><span class="num">${count(model.check.pairs)}</span><span>pairs checked</span></li>`,
    ...(rest.length > 0
      ? [
          `<li><span class="num">${count(rest.filter((e) => e.callers.length > 0).length)}</span><span>of ${plural(rest.length, "route", "routes")} with a caller here</span></li>`,
        ]
      : []),
    ...(fields.length > 0
      ? [
          `<li><span class="num">${count(fields.filter((e) => e.callers.length > 0).length)}</span><span>of ${plural(fields.length, "field", "fields")} with a caller here</span></li>`,
        ]
      : []),
    ...(model.operations.length > 0
      ? [
          `<li><span class="num">${count(model.operations.length)}</span><span>GraphQL operations, ${count(model.operations.filter((op) => op.fields.length > 0).length)} paired</span></li>`,
        ]
      : []),
    ...(model.clients.length > 0
      ? [
          `<li><span class="num">${count(model.clients.length)}</span><span>HTTP calls, ${count(model.clients.filter((client) => client.entries.length > 0).length)} paired with a route here</span></li>`,
        ]
      : []),
  ];
  const kinds = model.check.byKind
    .map(
      (row) =>
        `<li><span class="num">${count(row.count)}</span><span><code>${esc(row.kind)}</code> <span class="muted">${esc(row.severity)}</span></span></li>`,
    )
    .join("");
  return `<div class="trust-block">
      <h3>${icon("check", "i-check")}Check<span class="from">${fromTag(ctx.check, "check")}</span></h3>
      <ul class="num-list">${lines.join("")}</ul>
      ${kinds === "" ? `<p class="sub-note">No findings.</p>` : `<p class="sub-h">Findings</p><ul class="num-list">${kinds}</ul>`}
    </div>`;
}

function unfollowedBlock(model: MapModel): string {
  const { coverage } = model;
  const [one, many] = entryNoun(model);
  const exact = model.entries.some((entry) =>
    entry.reach.some((touch) => touch.line !== null),
  );
  const top = coverage.topUnfollowed
    .map(
      (row) =>
        `<li><span class="num">${count(row.count)}</span><span><code>${esc(row.callee.length > 70 ? `${row.callee.slice(0, 68)}…` : row.callee)}</code> ${unitLink(model, row.unit, null)}</span></li>`,
    )
    .join("");
  return `<div class="trust-block">
      <h3>${icon("partial", "i-partial")}Not followed</h3>
      <ul class="num-list">
        <li><span class="num">${count(coverage.unfollowedCalls)}</span><span>calls not followed</span></li>
        <li><span class="num">${count(coverage.withUnfollowed)}</span><span>of ${plural(coverage.functions, "function", "functions")} make one</span></li>
        <li><span class="num">${count(coverage.entriesAffected)}</span><span>${esc(coverage.entriesAffected === 1 ? one : many)} reach one</span></li>
        <li><span class="num">${count(coverage.withUnreadOutcome)}</span><span>functions with an outcome not read</span></li>
      </ul>
      ${top === "" ? "" : `<p class="sub-h">Most often</p><ul class="num-list">${top}</ul>`}
      ${exact ? "" : `<p class="sub-note">Read and write links open the function, not the exact line.</p>`}
    </div>`;
}

/** A path as a shell word, quoted when it has a space in it. */
function shellWord(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text)
    ? text
    : `'${text.replace(/'/g, "'\\''")}'`;
}
