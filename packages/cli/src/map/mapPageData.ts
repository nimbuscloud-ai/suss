/**
 * The model as the page's script reads it: arrays in place of objects,
 * and every repeated string (a file, a call, a condition) written once in
 * a table and referred to by its place there. A project of eight
 * thousand functions repeats the same calls and paths thousands of
 * times, and this keeps its page to a size a browser opens at once.
 */

import { githubBlobBase } from "./mapHtml.js";

import type { MapModel, MapTouch } from "./mapModel.js";

/** How many units with an unfollowed call an entry point lists; the page gives the rest as a count. */
const UNFOLLOWED_LISTED = 12;

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
  /** Environment reads: [boundary, unit, defaulted]. */
  env: Array<[number, number, 0 | 1]>;
  /** GraphQL operations: [unit, type, name, owner, fields]. */
  ops: Array<[number, number, number, number | null, number[]]>;
  /** HTTP calls: [unit, method, path, entries]. */
  cl: Array<[number, number | null, number | null, number[]]>;
  /** Pages: [unit, path]. */
  pg: Array<[number, number]>;
  /** Findings: [kind, severity, description, entry, provider unit, provider line, consumer unit, consumer line]. */
  fi: Array<
    [
      number,
      number,
      number,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
    ]
  >;
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
  /** Outcomes: [status, output, exception, conditions, unit, line, wrapper]. */
  o: Array<
    [
      number | null,
      number,
      number | null,
      number[],
      number,
      number,
      number | null,
    ]
  >;
  /** Reach: [boundary, relations, unit, via, through, line]. */
  r: Array<[number, string, number, number | null, number[], number | null]>;
  c: number[];
  f: number[];
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

export function pageDataOf(model: MapModel): PageData {
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
    e: model.entries.map((entry) => ({
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
      ]),
      r: entry.reach.map(reach),
      c: entry.callers,
      f: entry.findings,
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
    fi: model.findings.map((finding) => [
      s(finding.kind),
      s(finding.severity),
      s(finding.description),
      finding.entry,
      finding.provider.unit,
      finding.provider.line,
      finding.consumer.unit,
      finding.consumer.line,
    ]),
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
