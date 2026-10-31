/**
 * The facts `suss map` draws, gathered from one run's summaries and the
 * check over them.
 *
 * Each fact here is one another command also gives. An entry point's
 * statuses and conditions are what `inspect` prints for its unit, what
 * it reaches is what `ask "what does <unit> reach"` lists, and its
 * callers and findings are what `check` paired and reported. A table's
 * writers are what `ask "what writes <table>"` lists. The page draws
 * these and adds nothing, so any number on it can be checked with the
 * command it came from. Indexes point into the model's own arrays, so
 * the page can ship the model as compact JSON.
 */

import { gatherCoverage } from "./mapCoverage.js";
import { gatherEntries } from "./mapEntries.js";
import { gatherEnvReads } from "./mapEnv.js";
import { gatherGraphqlTypes } from "./mapGraphqlTypes.js";
import { gatherCallers } from "./mapPairs.js";
import { gatherReach } from "./mapReach.js";
import { gatherTables } from "./mapTables.js";
import { languagesOf, UnitTable } from "./mapUnits.js";

import type { BehavioralSummary, Finding } from "@suss/behavioral-ir";
import type { CheckAllResult } from "@suss/checker";
import type { Relation } from "@suss/ir-core";
import type { LoadedSummaries } from "../loadedSummaries.js";

/** One file of summaries the run read, and where its paths are rooted. */
export interface MapRead {
  /** The file's name in the summaries folder. */
  file: string;
  /** The command that wrote it, when the run knows, or else the file name. */
  label: string;
  /** The directory its summaries' paths are relative to, for links. Null when unknown. */
  root: string | null;
  /** The packs it was read with, from `suss.json`. Empty when unknown. */
  packs: string[];
  /** True when it came from `suss contract` rather than from source. */
  spec: boolean;
}

/** One unit the page mentions. */
export interface MapUnit {
  /** The id a report prints and `ask` takes. */
  id: string;
  name: string;
  kind: BehavioralSummary["kind"];
  file: string;
  line: number;
  endLine: number;
  /** Which entry in `reads` it came from. */
  read: number;
  /** True for a unit a spec declared, which has no place in source. */
  spec: boolean;
  /** For a spec's unit, the spec file relative to its read's root, or null when the label gives none. */
  document: string | null;
  /** Which entry in `repositories` the summary records, or null when it records none. */
  repository: number | null;
}

/** A git repository and commit summaries were extracted at. */
export interface MapRepository {
  name: string;
  /** Where the summaries' paths start, relative to the repository's top. */
  path: string;
  remote: string | null;
  commit: string | null;
}

export type EntryKind = "rest" | "graphql";

/** One way an entry point can end, as its summary records it. */
export interface MapOutcome {
  /** The HTTP status, when the summary gives a literal one. */
  status: number | null;
  /** The output's type: `response`, `throw`, `return` and so on. */
  output: string;
  /** For a throw, the exception's class. */
  exception: string | null;
  /** For a return, the type it returns, written the way `inspect` writes one. */
  returns: string | null;
  /** The conditions on the path, as `inspect` prints them. */
  conditions: string[];
  unit: number;
  line: number;
  /** The middleware or filter whose body produced this outcome, when one did. */
  wrapper: string | null;
}

/** A boundary an entry point's reach crosses, or a table or variable on the page. */
export interface MapBoundary {
  /** The boundary as `ask` prints it. */
  label: string;
  category: BoundaryCategory;
  /** The table or variable name without the system in front. */
  name: string;
  /** The storage system, for a table. */
  system: string | null;
}

export type BoundaryCategory = "table" | "env" | "other";

/** One line of `ask "what does <unit> reach"`. */
export interface MapTouch {
  boundary: number;
  relations: Relation[];
  /** The unit that makes the call. */
  unit: number;
  /** The call as the source writes it. */
  via: string | null;
  /** The calls from the entry point to that unit, outermost first. */
  through: string[];
  /** The line of the call, when the summary records one. */
  line: number | null;
}

/** What a GraphQL field declares: its arguments and its type, as `inspect` prints types. */
export interface GraphqlShape {
  args: Array<{ name: string; type: string; required: boolean }>;
  returns: string;
  /** The named types the shape mentions, which the page can link to. */
  refs: string[];
}

/** A route the code serves, or a Query, Mutation or Subscription field. */
export interface MapEntry {
  /** The key `check` pairs on. */
  key: string;
  kind: EntryKind;
  /** The HTTP method, or the GraphQL type the field is on. */
  method: string;
  /** The path, or the field name. */
  path: string;
  /** The pack that recognised it. */
  framework: string;
  /** The code units that serve it. */
  units: number[];
  /** The spec units that declare it. */
  specs: number[];
  outcomes: MapOutcome[];
  reach: MapTouch[];
  /** Units in this repo that `check` paired with it as callers. */
  callers: number[];
  findings: number[];
  /** Units on its reach, itself included, that record a call suss could not follow. */
  unfollowed: number[];
  /** True when its own summary records an outcome suss did not read. */
  unread: boolean;
  /** For a GraphQL field: the shape the code declares, or the schema when the code declares none. */
  shape: GraphqlShape | null;
  /** The statuses a spec declares for it. */
  specStatuses: number[];
}

/** One reading of an environment variable. */
export interface MapEnvRead {
  boundary: number;
  unit: number;
  /** True when the code gives a value to use when the variable is not set. */
  defaulted: boolean;
  /** That value, when it settles to one. */
  value?: string | number | boolean;
}

/** A table, with what `ask "what writes"` and `ask "what reads"` list for it. */
export interface MapTable {
  boundary: number;
  writers: MapTouch[];
  readers: MapTouch[];
}

/** A GraphQL operation in this repo's code. */
export interface MapOperation {
  unit: number;
  type: string;
  name: string;
  /** The function the operation is written in, when the summaries give one at the same place. */
  owner: number | null;
  /** The fields `check` paired it with. */
  fields: number[];
}

/** A call to an HTTP server in this repo's code. */
export interface MapClient {
  unit: number;
  method: string | null;
  path: string | null;
  /** The routes `check` paired it with. */
  entries: number[];
}

/** A finding from `check`, placed on the page. */
export interface MapFinding {
  kind: Finding["kind"];
  severity: Finding["severity"];
  description: string;
  entry: number | null;
  provider: { unit: number | null; line: number | null };
  consumer: { unit: number | null; line: number | null };
}

/** A GraphQL type and its fields, from the code's resolvers and the schema. */
export interface GraphqlType {
  name: string;
  /** "object" covers interfaces and input types, which also have fields. */
  kind: "object" | "enum" | "union" | "scalar";
  fields: GraphqlField[];
  /** An enum's values or a union's member types. */
  members: string[];
}

export interface GraphqlField {
  name: string;
  shape: GraphqlShape;
  /** The resolver in code, when one serves the field. */
  unit: number | null;
  /** The entry point, for a Query, Mutation or Subscription field. */
  entry: number | null;
}

/** How much of the code suss read, and what it could not follow. */
export interface MapCoverage {
  /** Code units in the run. */
  functions: number;
  /** Units that record a call suss could not follow. */
  withUnfollowed: number;
  /** Calls suss could not follow, one per line `inspect` prints under "Could not follow". */
  unfollowedCalls: number;
  /** The calls suss most often could not follow, with one unit that makes each. */
  topUnfollowed: Array<{ callee: string; count: number; unit: number }>;
  /** Entry points whose reach crosses a unit with a call suss could not follow. */
  entriesAffected: number;
  /** Units that record an outcome suss did not read. */
  withUnreadOutcome: number;
  /** Code units per read, in the order of `reads`. */
  unitsPerRead: number[];
}

/** What `check` compared. */
export interface MapCheck {
  pairs: number;
  /** Findings by kind and severity, including the ones placed on an entry point. */
  byKind: Array<{ kind: string; severity: string; count: number }>;
}

export interface MapModel {
  project: { name: string; languages: string[]; frameworks: string[] };
  reads: MapRead[];
  /** Every repository and commit the summaries record, in the order units first mention them. */
  repositories: MapRepository[];
  units: MapUnit[];
  boundaries: MapBoundary[];
  entries: MapEntry[];
  tables: MapTable[];
  envReads: MapEnvRead[];
  operations: MapOperation[];
  clients: MapClient[];
  /** Components a client-side router serves at a path. */
  pages: Array<{ unit: number; path: string }>;
  findings: MapFinding[];
  graphqlTypes: GraphqlType[];
  coverage: MapCoverage;
  check: MapCheck;
}

export interface MapInput {
  projectName: string;
  loaded: LoadedSummaries;
  check: CheckAllResult;
  reads: MapRead[];
  /** Which entry in `reads` each summary came from. */
  readOf: ReadonlyMap<BehavioralSummary, number>;
}

export function buildMapModel(input: MapInput): MapModel {
  const { summaries } = input.loaded;
  const units = new UnitTable(input.reads, input.readOf, summaries);
  const boundaries = new BoundaryTable();

  const gathered = gatherEntries(summaries, units);
  gatherReach(
    gathered.entries,
    gathered.servedBy,
    input.loaded,
    units,
    boundaries,
  );
  const callers = gatherCallers(gathered, summaries, input.check, units);
  const envReads = gatherEnvReads(summaries, units, boundaries);
  const tables = gatherTables(input.loaded, units, boundaries);
  const graphqlTypes = gatherGraphqlTypes(gathered, summaries, units);
  const coverage = gatherCoverage(
    summaries,
    gathered.entries,
    input.reads,
    units,
  );

  return {
    project: {
      name: input.projectName,
      languages: languagesOf(summaries, units),
      frameworks: [
        ...new Set(gathered.entries.map((entry) => entry.framework)),
      ].filter((name) => name !== ""),
    },
    reads: input.reads,
    repositories: units.repositories(),
    units: units.all(),
    boundaries: boundaries.all(),
    entries: gathered.entries,
    tables,
    envReads,
    operations: callers.operations,
    clients: callers.clients,
    pages: gathered.pages,
    findings: callers.findings,
    graphqlTypes,
    coverage,
    check: callers.check,
  };
}

/** The boundaries the page mentions, each once, in the order first seen. */
export class BoundaryTable {
  private readonly list: MapBoundary[] = [];
  private readonly index = new Map<string, number>();

  of(boundary: MapBoundary): number {
    const seen = this.index.get(boundary.label);
    if (seen !== undefined) {
      return seen;
    }
    this.list.push(boundary);
    this.index.set(boundary.label, this.list.length - 1);
    return this.list.length - 1;
  }

  all(): MapBoundary[] {
    return this.list;
  }
}
