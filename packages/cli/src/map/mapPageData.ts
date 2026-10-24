/**
 * The model as the page's script reads it: arrays in place of objects,
 * and every repeated string (a file, a call, a condition) written once in
 * a table and referred to by its place there. A project of eight
 * thousand functions repeats the same calls and paths thousands of
 * times, and this keeps its page to a size a browser opens at once.
 */

import { githubBlobBase } from "./mapHtml.js";

import type { MapFinding, MapModel, MapTouch } from "./mapModel.js";

/** How many units with an unfollowed call an entry point lists; the page gives the rest as a count. */
const UNFOLLOWED_LISTED = 12;

/**
 * How many findings of one kind an entry point lists; the page gives the
 * rest as a count. A project with thousands of findings has hundreds of
 * one kind on a single route, and nobody reads past the first few.
 */
export const FINDINGS_LISTED_PER_KIND = 10;

/**
 * One finding as the inspector shows it: [kind, severity, description,
 * provider unit, provider line, consumer unit, consumer line]. The rows
 * go in a compressed block of their own, so they carry their text rather
 * than places in the string table.
 */
export type FindingRow = [
  string,
  string,
  string,
  number | null,
  number | null,
  number | null,
  number | null,
];

export interface PageData {
  /** The strings the rest refers to by index. */
  s: string[];
  name: string;
  /** Per read: the absolute directory its paths are relative to, or null. */
  roots: Array<string | null>;
  /** Per read: [file, label, packs, spec, code units]. */
  reads: Array<[number, number, number[], 0 | 1, number]>;
  /** Repositories: [name, the GitHub URL a file's path follows, or null]. */
  repos: Array<[number, string | null]>;
  /** Units: [name, file, line, kind, read, spec, id, repository]. */
  u: Array<
    [number, number, number, number, number, 0 | 1, number, number | null]
  >;
  /** Boundaries: [label, category, name, system]. */
  b: Array<[number, string, number, number | null]>;
  e: EntryData[];
  /** Tables: [boundary, writers as [unit, via], readers as [unit, via]]. */
  t: Array<
    [number, Array<[number, number | null]>, Array<[number, number | null]>]
  >;
  /** Environment reads: [boundary, unit, defaulted, the default as the code writes it, or null]. */
  env: Array<[number, number, 0 | 1, number | null]>;
  /** GraphQL operations: [unit, type, name, owner, fields]. */
  ops: Array<[number, number, number, number | null, number[]]>;
  /** HTTP calls: [unit, method, path, entries]. */
  cl: Array<[number, number | null, number | null, number[]]>;
  /** Pages: [unit, path]. */
  pg: Array<[number, number]>;
  /** GraphQL types: [name, fields as [name, args, returns, refs, unit, entry]]. */
  ty: Array<
    [
      number,
      Array<
        [
          number,
          Array<[number, number, 0 | 1]>,
          number,
          number[],
          number | null,
          number | null,
        ]
      >,
    ]
  >;
  cov: MapModel["coverage"];
  chk: MapModel["check"];
}

export interface EntryData {
  /** "h" for an HTTP route, "q" for a GraphQL field. */
  k: "h" | "q";
  m: number;
  p: number;
  fw: number;
  u: number[];
  sp: number[];
  /** Outcomes: [status, output, exception, conditions, unit, line, wrapper, returns]. */
  o: Array<
    [
      number | null,
      number,
      number | null,
      number[],
      number,
      number,
      number | null,
      number | null,
    ]
  >;
  /** Reach: [boundary, relations, unit, via, through, line]. */
  r: Array<[number, string, number, number | null, number[], number | null]>;
  c: number[];
  /** Its findings, as places in the page's list of finding rows. */
  f: number[];
  /** Findings past the ones listed: [kind, how many more]. */
  fx: Array<[number, number]>;
  g: number[];
  /** How many units with an unfollowed call its reach crosses in all. */
  gn: number;
  nr: 0 | 1;
  /** GraphQL shape: [args as [name, type, required], returns, refs]. */
  sh: [Array<[number, number, 0 | 1]>, number, number[]] | null;
  ss: number[];
}

const RELATION_LETTER: Record<string, string> = {
  reads: "r",
  writes: "w",
  invokes: "i",
  provides: "p",
};

/**
 * The page's data, and the finding rows its inspector lists. A finding is
 * listed only on the entry point it was placed on, which is the only
 * place the page shows one, and only the first of each kind there. The
 * coverage section counts every finding by kind.
 */
export function pageDataOf(model: MapModel): {
  data: PageData;
  findings: FindingRow[];
} {
  const listed = listedFindings(model);
  return {
    data: pageDataWith(model, listed),
    findings: listed.rows,
  };
}

interface ListedFindings {
  rows: FindingRow[];
  /** Per entry: the places in `rows` of its findings. */
  shown: number[][];
  /** Per entry: [kind, how many more] for each kind with findings past the cap. */
  more: Array<Array<[string, number]>>;
}

function listedFindings(model: MapModel): ListedFindings {
  const listed: ListedFindings = { rows: [], shown: [], more: [] };
  for (const entry of model.entries) {
    const perKind = new Map<string, number>();
    const shown: number[] = [];
    for (const at of entry.findings) {
      const finding = model.findings[at];
      if (finding === undefined) {
        continue;
      }

      const ofKind = (perKind.get(finding.kind) ?? 0) + 1;
      perKind.set(finding.kind, ofKind);
      if (ofKind > FINDINGS_LISTED_PER_KIND) {
        continue;
      }

      shown.push(listed.rows.length);
      listed.rows.push(findingRow(finding));
    }
    listed.shown.push(shown);
    listed.more.push(
      [...perKind]
        .filter(([, count]) => count > FINDINGS_LISTED_PER_KIND)
        .map(([kind, count]) => [kind, count - FINDINGS_LISTED_PER_KIND]),
    );
  }
  return listed;
}

function findingRow(finding: MapFinding): FindingRow {
  return [
    finding.kind,
    finding.severity,
    finding.description,
    finding.provider.unit,
    finding.provider.line,
    finding.consumer.unit,
    finding.consumer.line,
  ];
}

function pageDataWith(model: MapModel, listed: ListedFindings): PageData {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const s = (text: string): number => {
    const seen = stringIndex.get(text);
    if (seen !== undefined) {
      return seen;
    }
    strings.push(text);
    stringIndex.set(text, strings.length - 1);
    return strings.length - 1;
  };
  const maybe = (text: string | null): number | null =>
    text === null ? null : s(text);
  const flat = (text: string): number => s(text.replace(/\s+/g, " "));

  const reach = (touch: MapTouch): EntryData["r"][number] => [
    touch.boundary,
    touch.relations.map((relation) => RELATION_LETTER[relation] ?? "").join(""),
    touch.unit,
    touch.via === null ? null : flat(touch.via),
    touch.through.map(flat),
    touch.line,
  ];

  return {
    s: strings,
    name: model.project.name,
    roots: model.reads.map((read) => read.root),
    reads: model.reads.map((read, at) => [
      s(read.file),
      s(read.label),
      read.packs.map(s),
      read.spec ? 1 : 0,
      model.coverage.unitsPerRead[at] ?? 0,
    ]),
    repos: model.repositories.map((repository) => [
      s(repository.name),
      githubBlobBase(repository),
    ]),
    u: model.units.map((unit) => [
      s(unit.name),
      s(unit.file),
      unit.line,
      s(unit.kind),
      unit.read,
      unit.spec ? 1 : 0,
      s(unit.id),
      unit.repository,
    ]),
    b: model.boundaries.map((boundary) => [
      s(boundary.label),
      boundary.category[0] as string,
      s(boundary.name),
      maybe(boundary.system),
    ]),
    e: model.entries.map((entry, at) => ({
      k: entry.kind === "rest" ? "h" : "q",
      m: s(entry.method),
      p: s(entry.path),
      fw: s(entry.framework),
      u: entry.units,
      sp: entry.specs,
      o: entry.outcomes.map((outcome) => [
        outcome.status,
        s(outcome.output),
        maybe(outcome.exception),
        outcome.conditions.map(flat),
        outcome.unit,
        outcome.line,
        maybe(outcome.wrapper),
        maybe(outcome.returns),
      ]),
      r: entry.reach.map(reach),
      c: entry.callers,
      f: listed.shown[at] ?? [],
      fx: (listed.more[at] ?? []).map(([kind, count]) => [s(kind), count]),
      g: entry.unfollowed.slice(0, UNFOLLOWED_LISTED),
      gn: entry.unfollowed.length,
      nr: entry.unread ? 1 : 0,
      sh:
        entry.shape === null
          ? null
          : [
              entry.shape.args.map((arg) => [
                s(arg.name),
                s(arg.type),
                arg.required ? 1 : 0,
              ]),
              s(entry.shape.returns),
              entry.shape.refs.map(s),
            ],
      ss: entry.specStatuses,
    })),
    t: model.tables.map((table) => [
      table.boundary,
      table.writers.map((touch) => [touch.unit, maybeFlat(touch.via, flat)]),
      table.readers.map((touch) => [touch.unit, maybeFlat(touch.via, flat)]),
    ]),
    env: model.envReads.map((read) => [
      read.boundary,
      read.unit,
      read.defaulted ? 1 : 0,
      read.value === undefined ? null : s(JSON.stringify(read.value)),
    ]),
    ops: model.operations.map((op) => [
      op.unit,
      s(op.type),
      s(op.name),
      op.owner,
      op.fields,
    ]),
    cl: model.clients.map((client) => [
      client.unit,
      maybe(client.method),
      maybe(client.path),
      client.entries,
    ]),
    pg: model.pages.map((page) => [page.unit, s(page.path)]),
    ty: model.graphqlTypes.map((type) => [
      s(type.name),
      type.fields.map((field) => [
        s(field.name),
        field.shape.args.map((arg) => [
          s(arg.name),
          s(arg.type),
          arg.required ? 1 : 0,
        ]),
        s(field.shape.returns),
        field.shape.refs.map(s),
        field.unit,
        field.entry,
      ]),
    ]),
    cov: model.coverage,
    chk: model.check,
  };
}

function maybeFlat(
  text: string | null,
  flat: (text: string) => number,
): number | null {
  return text === null ? null : flat(text);
}
