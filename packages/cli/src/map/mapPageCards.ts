/**
 * How each card kind looks on the page: a title in result style, one
 * line of detail, a count, and the rows behind it when the card opens.
 * Which cards appear, and why, is decided in `mapCards.ts`.
 */

import { CARD_RULES, entryNoun } from "./mapCards.js";
import {
  code,
  entryRef,
  entryText,
  esc,
  fromTag,
  plural,
  shortFile,
  statusPill,
  tableRef,
  tableText,
  unitLink,
  WRITES,
} from "./mapHtml.js";
import { icon } from "./mapIcons.js";

import type { Card, CardKind } from "./mapCards.js";
import type { IconName } from "./mapIcons.js";
import type { MapEntry, MapModel, MapTouch } from "./mapModel.js";

export interface CardContext {
  model: MapModel;
  /** The command that reproduces a fact, given the question. */
  ask: (question: string) => string;
  /** The command that runs check over the same summaries. */
  check: string;
  /** Lines of a unit's file, numbered from `start`; empty when the file cannot be read. */
  sourceLines: (unit: number, start: number, end: number) => string[];
}

interface CardView {
  icon: IconName;
  tone: string;
  title: string;
  meta: string;
  count: number;
  countLabel: string;
  body: string;
  from: string;
}

const CARD_VIEWS: Record<CardKind, (card: Card, ctx: CardContext) => CardView> =
  {
    finding: (card, ctx) => {
      const { model } = ctx;
      const finding = model.findings[card.finding as number];
      const at = card.entries[0] as number;
      const entry = model.entries[at] as MapEntry;
      const provider = finding?.provider;
      const consumer = finding?.consumer;
      const status = entry.outcomes.find(
        (outcome) =>
          outcome.line === provider?.line && outcome.unit === provider.unit,
      )?.status;
      return {
        icon: "clash",
        tone: "clash",
        title: `${entryText(entry)}${status === undefined || status === null ? "" : ` ${statusPill(status)}`}`,
        meta: `${esc(finding?.kind)} · ${esc(finding?.severity)} · both sides read`,
        count: entry.callers.length,
        countLabel: entry.callers.length === 1 ? "caller" : "callers",
        body: `<p class="issue-lede">${esc(finding?.description)}</p>
        <div class="pair">${excerpt(ctx, provider?.unit ?? null, provider?.line ?? null, "Served by")}${excerpt(ctx, consumer?.unit ?? null, consumer?.line ?? null, "Called from")}</div>
        ${actions(openButton(`entry-${at}`, "Inspect"))}`,
        from: fromTag(ctx.check, "check"),
      };
    },
    mostTablesWritten: (card, ctx) => {
      const { model } = ctx;
      const at = card.entries[0] as number;
      const entry = model.entries[at] as MapEntry;
      const touches = card.touches ?? [];
      return {
        icon: "write",
        tone: "write",
        title: `${entryText(entry)} writes ${plural(card.total, "table", "tables")}`,
        meta: esc(
          touches.map((t) => model.boundaries[t.boundary]?.name).join(", "),
        ),
        count: card.total,
        countLabel: "tables",
        body: `<ul class="rows rows-2">${touches.map((touch) => `<li class="row"><div class="row-head">${WRITES}${tableRef(model, touch.boundary)}</div>${siteLine(model, touch)}</li>`).join("")}</ul>${actions(openButton(`entry-${at}`, "Inspect"))}`,
        from: fromTag(
          ctx.ask(`what does ${unitId(model, entry)} reach`),
          "ask",
        ),
      };
    },
    getWrites: (card, ctx) => {
      const { model } = ctx;
      const paths = card.entries
        .slice(0, 3)
        .map((at) => esc(model.entries[at]?.path));
      const rows = card.entries.slice(0, 6).map((at, i) => {
        const touch = card.touches?.[i] as MapTouch;
        return `<li class="row"><div class="row-head">${entryRef(model, at)}${WRITES}${tableRef(model, touch.boundary)}</div>${siteLine(model, touch)}</li>`;
      });
      return {
        icon: "write",
        tone: "write",
        title: `${plural(card.total, "GET route writes", "GET routes write")} a table`,
        meta: `${paths.join(", ")}${card.total > 3 ? `, and ${card.total - 3} more` : ""}`,
        count: card.total,
        countLabel: "routes",
        body: `<ul class="rows rows-2">${rows.join("")}</ul>${actions(facetButton("routes:method=GET,db=writes", `Show all ${card.total}`))}`,
        from: fromTag(ctx.ask("what does <route> reach"), "ask"),
      };
    },
    mostWrittenTable: (card, ctx) => {
      const { model } = ctx;
      const boundary = card.boundary as number;
      const places = card.places ?? [];
      const label = model.boundaries[boundary]?.label ?? "";
      return {
        icon: "table",
        tone: "write",
        title: `${tableText(model, boundary)} written by ${plural(card.total, "route", "routes")}`,
        meta: plural(places.length, "place writes it", "places write it"),
        count: card.total,
        countLabel: "routes",
        body: `<ul class="rows rows-2">${places
          .slice(0, 6)
          .map(
            (place) =>
              `<li class="row"><div class="row-head"><span class="unit-name">${esc(model.units[place.touch.unit]?.name)}</span><span class="count">${plural(place.entries, "route", "routes")}</span></div>${siteLine(model, place.touch)}</li>`,
          )
          .join(
            "",
          )}</ul>${actions(openButton(`table-${boundary}`, "Inspect the table"))}`,
        from: fromTag(ctx.ask(`what writes ${label}`), "ask"),
      };
    },
    sharedEarlyReturn: (card, ctx) => {
      const { model } = ctx;
      const outcome = card.outcome;
      const noun = entryNoun(model, card.entries);
      return {
        icon: "guard",
        tone: "guard",
        title: `${plural(card.total, noun[0], noun[1])} return ${statusPill(outcome?.status ?? null)} from <code class="src">${esc(outcome?.wrapper)}</code>`,
        meta:
          outcome?.condition === null || outcome?.condition === undefined
            ? "on every request"
            : `when ${esc(outcome.condition)}`,
        count: card.total,
        countLabel: noun[1],
        body: `${chips(model, card.entries)}${actions(facetButton(`routes:early=${outcome?.wrapper ?? ""}`, "Filter the list"))}`,
        from: fromTag("suss inspect <route's file>", "inspect"),
      };
    },
    uncalledFields: (card, ctx) => {
      const { model } = ctx;
      const byType = new Map<string, number>();
      for (const at of card.entries) {
        const type = model.entries[at]?.method ?? "";
        byType.set(type, (byType.get(type) ?? 0) + 1);
      }
      return {
        icon: "partial",
        tone: "guard",
        title: `${plural(card.total, "field", "fields")} with no caller here`,
        meta: [...byType].map(([type, n]) => `${n} ${esc(type)}`).join(" · "),
        count: card.total,
        countLabel: "fields",
        body: `${chips(model, card.entries)}${actions(facetButton("graphql:caller=none", `Show all ${card.total}`))}`,
        from: fromTag(ctx.check, "check"),
      };
    },
    notRead: (card, ctx) => {
      const { model } = ctx;
      const served = model.entries.filter((entry) => entry.units.length > 0);
      const graphql = card.entries.some(
        (at) => model.entries[at]?.kind === "graphql",
      );
      const noun = entryNoun(model, card.entries);
      return {
        icon: "partial",
        tone: "partial",
        title: `${card.total} of ${plural(served.length, noun[0], noun[1])} not read`,
        meta: "tables they reach may be missing",
        count: card.total,
        countLabel: "not read",
        body: `${chips(model, card.entries)}${actions(facetButton(`${graphql ? "graphql" : "routes"}:read=no`, "Show them in the list"))}`,
        from: fromTag("suss inspect <file>", "inspect"),
      };
    },
  };

export function renderCards(cards: readonly Card[], ctx: CardContext): string {
  if (cards.length === 0) {
    return `<p class="empty-cards">No cards for this project.</p>`;
  }
  const items = cards.map((card, i) => {
    const view = CARD_VIEWS[card.kind](card, ctx);
    const rule = CARD_RULES[card.kind];
    return `<li class="issue tone-${view.tone}">
      <details${i === 0 ? " open" : ""}>
        <summary>
          <span class="issue-icon">${icon(view.icon, `i-${view.tone}`)}</span>
          <span class="issue-main">
            <span class="issue-type" data-tip="${esc(rule.rule)}">${esc(rule.name)}</span>
            <span class="issue-title">${view.title}</span>
            <span class="issue-meta">${view.meta}</span>
          </span>
          <span class="issue-count"><span class="issue-n">${view.count}</span><span class="issue-nl">${esc(view.countLabel)}</span></span>
          <span class="issue-chev">${icon("chevron", "i-chev")}</span>
        </summary>
        <div class="issue-body">${view.body}<div class="issue-actions"><span class="from">${view.from}</span></div></div>
      </details>
    </li>`;
  });
  return `<ol class="issues">${items.join("\n")}</ol>`;
}

/** The call that makes a touch, where it is, and the calls on the way to it. */
function siteLine(model: MapModel, touch: MapTouch): string {
  const through =
    touch.through.length === 0
      ? ""
      : `<span class="through" data-term="through">via ${touch.through.map((hop) => `<span class="hop">${esc(hop.replace(/\s+/g, " "))}</span>`).join('<span class="arrow" aria-hidden="true">›</span>')}</span>`;
  return `<div class="site"><div class="site-code">${code(touch.via ?? "")}</div><div class="site-meta">${unitLink(model, touch.unit, touch.line)}${through}</div></div>`;
}

function chips(model: MapModel, entries: readonly number[]): string {
  const shown = entries.slice(0, 24);
  const rest = entries.length - shown.length;
  return `<ul class="rows rows-grid">${shown.map((at) => `<li class="row">${entryRef(model, at)}</li>`).join("")}</ul>${rest > 0 ? `<p class="issue-lede muted">and ${rest} more</p>` : ""}`;
}

function unitId(model: MapModel, entry: MapEntry): string {
  const first = entry.units[0];
  return first === undefined
    ? entry.path
    : (model.units[first]?.id ?? entry.path);
}

function actions(...buttons: string[]): string {
  return `<div class="issue-actions">${buttons.join("")}</div>`;
}

function openButton(target: string, label: string): string {
  return `<button type="button" class="action" data-open="${esc(target)}">${esc(label)}${icon("chevron", "i-go")}</button>`;
}

function facetButton(facets: string, label: string): string {
  return `<button type="button" class="action" data-facet="${esc(facets)}">${icon("filter", "i-go")}${esc(label)}</button>`;
}

/** Up to eighteen lines of a unit's source around `line`, with that line marked. */
function excerpt(
  ctx: CardContext,
  unit: number | null,
  line: number | null,
  title: string,
): string {
  const found = unit === null ? undefined : ctx.model.units[unit];
  if (unit === null || found === undefined) {
    return "";
  }
  const mark = line ?? found.line;
  const start = Math.max(found.line, mark - 6);
  const end = Math.min(found.endLine, start + 17);
  const lines = ctx.sourceLines(unit, start, end);
  if (lines.length === 0) {
    return "";
  }
  const indent = Math.min(
    ...lines
      .filter((text) => text.trim().length > 0)
      .map((text) => text.length - text.trimStart().length),
  );
  const body = lines
    .map((text, i) => {
      const n = start + i;
      return `<span class="cl${n === line ? " hl" : ""}"><span class="ln">${n}</span><code class="src" data-lang="${esc(langOf(found.file))}">${esc(text.slice(Number.isFinite(indent) ? indent : 0)) || " "}</code></span>`;
    })
    .join("");
  return `<figure class="excerpt"><figcaption><span class="ex-title">${esc(title)}</span>${unitLink(ctx.model, unit, mark, `${shortFile(found.file)}:${mark}`)}</figcaption><pre>${body}</pre></figure>`;
}

const LANG_BY_SUFFIX: Array<[RegExp, string]> = [
  [/\.rb$/, "ruby"],
  [/\.py$/, "python"],
];

function langOf(file: string): string {
  return LANG_BY_SUFFIX.find(([pattern]) => pattern.test(file))?.[1] ?? "js";
}
