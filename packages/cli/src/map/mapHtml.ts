/**
 * Small pieces of HTML the map's server-written parts share with each
 * other: escaping, counts, the badges for a method or a status, and
 * references that open an entry point or a table in the inspector.
 */

import { icon } from "./mapIcons.js";

import type { MapEntry, MapModel, MapRead, MapUnit } from "./mapModel.js";

export function esc(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** "1 route", "12 routes". */
export function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

export function statusPill(status: number | null): string {
  if (status === null) {
    return `<span class="status s-unknown" data-status="?">?</span>`;
  }
  return `<span class="status s-${Math.floor(status / 100)}xx" data-status="${status}">${status}</span>`;
}

const GRAPHQL_BADGE: Record<string, string> = {
  Query: "m-get",
  Subscription: "m-get",
  Mutation: "m-mutation",
};

export function methodBadge(entry: Pick<MapEntry, "kind" | "method">): string {
  const cls =
    entry.kind === "graphql"
      ? (GRAPHQL_BADGE[entry.method] ?? "m-type")
      : `m-${entry.method.toLowerCase()}`;
  return `<span class="method ${cls}">${esc(entry.method)}</span>`;
}

/** An entry point as text, for a card title, where a button cannot go. */
export function entryText(entry: MapEntry): string {
  return `<span class="t-route">${methodBadge(entry)}${esc(entry.path)}</span>`;
}

/** An entry point that opens the inspector, with a hover card. */
export function entryRef(model: MapModel, at: number): string {
  const entry = model.entries[at] as MapEntry;
  return `<button type="button" class="ref ref-route" data-open="entry-${at}" data-peek="entry-${at}">${methodBadge(entry)}<span class="path">${esc(entry.path)}</span></button>`;
}

export function tableText(model: MapModel, boundary: number): string {
  return `<span class="t-table">${icon("table", "i-table")}${esc(model.boundaries[boundary]?.name)}</span>`;
}

export function tableRef(model: MapModel, boundary: number): string {
  return `<button type="button" class="ref ref-table" data-open="table-${boundary}" data-peek="table-${boundary}">${icon("table", "i-table")}<span class="path">${esc(model.boundaries[boundary]?.name)}</span></button>`;
}

export const WRITES = `<span class="verb verb-write" data-term="writes">${icon("write", "i-write")}writes</span>`;

/** A link that opens the unit's file in the editor, at `line` or else at the unit's first line. */
export function unitLink(
  model: MapModel,
  at: number,
  line: number | null,
  label?: string,
): string {
  const unit = model.units[at] as MapUnit;
  const exact = line !== null;
  const shown =
    label ?? (exact ? `${shortFile(unit.file)}:${line}` : `in ${unit.name}`);
  const href = editorHref(unit, model.reads, exact ? line : unit.line);
  const term = exact ? "" : ` data-term="fnline"`;
  const cls = exact ? "loc" : "loc loc-fn";
  if (href === null) {
    return `<span class="${cls}"${term}>${esc(shown)}</span>`;
  }
  return `<a class="${cls}"${term} href="${esc(href)}" data-u="${at}" data-l="${exact ? line : unit.line}">${esc(shown)}</a>`;
}

/** The link an editor opens a file at a line by. The page can switch the editor; this is the default. */
export function editorHref(
  unit: MapUnit,
  reads: readonly MapRead[],
  line: number,
): string | null {
  const root = reads[unit.read]?.root;
  if (root === null || root === undefined || unit.spec) {
    return null;
  }
  return `vscode://file${encodeURI(`${root}/${unit.file}`)}:${line}`;
}

export function shortFile(file: string): string {
  const parts = file.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : file;
}

export function code(text: string): string {
  return `<code class="src">${esc(text.replace(/\s+/g, " "))}</code>`;
}

/** The command that gives the same number, as a tag with the command in its hover card. */
export function fromTag(command: string, label: string): string {
  return `<span class="from-tag" data-tip="${esc(command)}">${esc(label)}</span>`;
}

export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) {
    return words.join("");
  }
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
