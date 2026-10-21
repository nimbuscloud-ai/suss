/**
 * Which paths use the same data and send something out, as datalog
 * rules over one-hop facts read off the summaries.
 *
 * A datum is a column a path reads from a store, or a field of a body on
 * one side of a boundary. Two paths share a datum only when both use it.
 * When suss could not read which columns or fields a read takes, the
 * read uses no datum. It comes back as unread with the reason, and a
 * caller lists it as unchecked.
 *
 * A path uses what its own effects and output use, and what the
 * functions it calls use. The README beside this file lists the
 * relations, the rules that join them, and what counts as sending out.
 */

import {
  BOUNDARY_ROLE,
  leavesTheProcess,
  messageBodyReadSet,
  summaryIdentifier,
} from "@suss/behavioral-ir";
import {
  Database,
  evaluate,
  lit,
  notLit,
  rule,
  variable as v,
} from "@suss/datalog";
import {
  bindingIs,
  boundaryKey,
  dispatchByType,
  displayLabel,
  exchangesHttpResponses,
} from "@suss/ir-core";

import { functionOf, readCallFacts } from "../calls/callFacts.js";
import { unwrapBodyField } from "../contract/declaredContract.js";
import { isTestCode } from "../pairing/testCode.js";
import { summaryWithDefinitionsInlined } from "../spelledOut.js";
import { storageBoundaryKey } from "../storage/storagePairing.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
  Output,
  StandDown,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type { Atom, Rule } from "@suss/datalog";
import type { DispatchTable } from "@suss/ir-core";
import type { CallFacts } from "../calls/callFacts.js";

/**
 * `column` is a column read from a store. `sends` is a field a path puts
 * on a boundary, and `reads` is a field a path takes off one.
 */
export type DatumKind = "column" | "sends" | "reads";

export interface Datum {
  readonly kind: DatumKind;
  /** The store or boundary, as a report prints it. */
  readonly at: string;
  /** What both sides of a match spell alike: the store's key, or the boundary's pairing key. */
  readonly scope: string;
  /** The column, or the field's path off the body with dots between. */
  readonly field: string;
}

/** A read of a store or a body whose columns or fields suss could not read. */
export interface UnreadData {
  readonly kind: DatumKind;
  readonly at: string;
  readonly scope: string;
  readonly reason: string;
}

export interface DataPath {
  readonly summary: BehavioralSummary;
  readonly transition: Transition;
}

/** What one path uses, its own and through the functions it calls. */
export interface PathData {
  readonly named: readonly Datum[];
  readonly unread: readonly UnreadData[];
}

/** A path outside the change that uses some of the same data and sends data out. */
export interface SharingPath extends DataPath {
  readonly shares: readonly Datum[];
  /** How it sends data out, such as `responds 200` or `writes postgresql:reports`. */
  readonly sends: readonly string[];
}

/** A path outside the change that reads the same store or boundary in a way suss could not read. */
export interface UncheckedPath extends DataPath {
  readonly unread: readonly UnreadData[];
  readonly sends: readonly string[];
}

export interface Sharing {
  readonly sharing: readonly SharingPath[];
  readonly unchecked: readonly UncheckedPath[];
}

export interface DataFacts {
  /** What each of these paths uses. A path from other summaries is left out. */
  dataOn(paths: readonly DataPath[]): Map<Transition, PathData>;
  /**
   * The paths that use any of these data and send data out. The changed
   * units are left out, and so is every unit that calls into one and
   * every unit one of them calls.
   */
  sharing(
    data: readonly Datum[],
    changed: readonly BehavioralSummary[],
  ): Sharing;
}

/** The key a datum is joined on: its kind, scope and field. */
export function datumKey(datum: Datum): string {
  return JSON.stringify([datum.kind, datum.scope, datum.field]);
}

function scopeKey(kind: DatumKind, scope: string): string {
  return JSON.stringify([kind, scope]);
}

function unreadKey(unread: UnreadData): string {
  return JSON.stringify([unread.kind, unread.scope, unread.reason]);
}

/** The base facts, read once and loaded into a fresh database per question. */
interface BaseFacts {
  readonly rows: Array<[string, Atom[]]>;
  readonly paths: Map<Transition, string>;
  readonly pathsByKey: Map<string, DataPath>;
  readonly data: Map<string, Datum>;
  readonly unread: Map<string, UnreadData>;
}

export function readDataFacts(
  summaries: readonly BehavioralSummary[],
  calls: CallFacts = readCallFacts(summaries),
): DataFacts {
  const base = baseFacts(summaries, calls);
  const database = (): Database => {
    const db = new Database();
    for (const [relation, tuple] of base.rows) {
      db.add(relation, tuple);
    }
    return db;
  };

  return {
    dataOn: (paths) => dataOnPaths(database(), base, paths),
    sharing: (data, changed) => sharingPaths(database(), base, data, changed),
  };
}

function baseFacts(
  summaries: readonly BehavioralSummary[],
  calls: CallFacts,
): BaseFacts {
  const facts: BaseFacts = {
    rows: [],
    paths: new Map(),
    pathsByKey: new Map(),
    data: new Map(),
    unread: new Map(),
  };
  const byId = new Map(
    summaries.map((summary) => [summaryIdentifier(summary), summary]),
  );

  summaries.forEach((summary, index) => {
    const unit = `u${index}`;
    const fn = functionOf(summary);
    facts.rows.push(["unitFunction", [unit, fn]]);
    if (isTestCode(summary)) {
      facts.rows.push(["testUnit", [unit]]);
    }
    const spelled = summaryWithDefinitionsInlined(summary);
    const consumed = consumerReads(spelled);
    summary.transitions.forEach((transition, at) => {
      const path = `${unit}:${at}`;
      facts.paths.set(transition, path);
      facts.pathsByKey.set(path, { summary, transition });
      facts.rows.push(["onPath", [path, unit]]);
      const read = [
        ...pathReads(spelled, spelled.transitions[at] ?? transition),
        ...consumed,
      ];
      for (const datum of read.flatMap((one) => one.named)) {
        const key = datumKey(datum);
        facts.data.set(key, datum);
        facts.rows.push(["pathUses", [path, key]]);
        facts.rows.push(["functionUses", [fn, key]]);
        facts.rows.push([
          "datumScope",
          [key, scopeKey(datum.kind, datum.scope)],
        ]);
      }

      for (const unread of read.flatMap((one) => one.unread)) {
        const key = unreadKey(unread);
        const scope = scopeKey(unread.kind, unread.scope);
        facts.unread.set(key, unread);
        facts.rows.push(["pathUnread", [path, scope, key]]);
        facts.rows.push(["functionUnread", [fn, scope, key]]);
      }

      for (const exit of pathExits(summary, transition)) {
        facts.rows.push(["pathExit", [path, exit]]);
      }

      for (const exit of transition.effects.flatMap(effectExits)) {
        facts.rows.push(["functionExit", [fn, exit]]);
      }

      for (const effect of transition.effects) {
        const to =
          effect.type === "invocation" && effect.summary !== undefined
            ? byId.get(effect.summary)
            : undefined;
        if (to !== undefined) {
          facts.rows.push(["pathCalls", [path, functionOf(to)]]);
        }
      }
    });
  });

  for (const edge of calls.edges()) {
    facts.rows.push(["calls", [edge.from, edge.to]]);
  }

  return facts;
}

// ---------------------------------------------------------------------------
// What one path uses
// ---------------------------------------------------------------------------

const MAX_FIELD_DEPTH = 4;

/**
 * Every field path of a body, outermost first. An array's items add no
 * segment, since a list of rows has the same fields as one row. Null
 * when the body has fields suss cannot see, such as a spread or a type it
 * could not spell out.
 */
function fieldPaths(shape: TypeShape, depth = 0): string[] | null {
  if (depth > MAX_FIELD_DEPTH) {
    return [];
  }
  return dispatchByType(FIELD_PATHS, shape)(depth);
}

const NO_FIELDS = () => (): string[] => [];
const UNSEEN_FIELDS = () => (): null => null;

const FIELD_PATHS: DispatchTable<
  TypeShape,
  (depth: number) => string[] | null
> = {
  record: (shape) => (depth) => {
    if ((shape.spreads ?? []).length > 0) {
      return null;
    }
    const paths: string[] = [];
    for (const [field, inner] of Object.entries(shape.properties)) {
      paths.push(field);
      for (const below of fieldPaths(inner, depth + 1) ?? []) {
        paths.push(`${field}.${below}`);
      }
    }
    return paths;
  },
  array: (shape) => (depth) => fieldPaths(shape.items, depth),
  union: (shape) => (depth) => {
    const paths = new Set<string>();
    for (const variant of shape.variants) {
      for (const one of fieldPaths(variant, depth) ?? []) {
        paths.add(one);
      }
    }
    return [...paths];
  },
  dictionary: UNSEEN_FIELDS,
  ref: UNSEEN_FIELDS,
  unknown: UNSEEN_FIELDS,
  literal: NO_FIELDS,
  text: NO_FIELDS,
  integer: NO_FIELDS,
  number: NO_FIELDS,
  boolean: NO_FIELDS,
  null: NO_FIELDS,
  undefined: NO_FIELDS,
};

interface ReadOff {
  readonly named: Datum[];
  readonly unread: UnreadData[];
}

const NOTHING: ReadOff = { named: [], unread: [] };

/** The fields of a body as data on one side of a boundary, or why they could not be read. */
function bodyData(
  kind: DatumKind,
  binding: BoundaryBinding,
  shape: TypeShape,
  unreadReason: string,
): ReadOff {
  const scope = boundaryKey(binding) ?? displayLabel(binding);
  const at = displayLabel(binding);
  const paths = fieldPaths(shape);
  if (paths === null) {
    return { named: [], unread: [{ kind, at, scope, reason: unreadReason }] };
  }
  return {
    named: paths.map((field) => ({ kind, at, scope, field })),
    unread: [],
  };
}

/** The unit's own binding, when it is on a boundary that leaves the process. */
function outsideBinding(summary: BehavioralSummary): BoundaryBinding | null {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || !leavesTheProcess(binding)) {
    return null;
  }
  return binding;
}

/** What one path's effects and output use. */
function pathReads(
  summary: BehavioralSummary,
  transition: Transition,
): ReadOff[] {
  return [
    ...transition.effects.map(effectReads),
    sentBody(summary, transition.output),
    readBody(summary, transition),
  ];
}

/** A column read, a message a path publishes, or nothing. */
function effectReads(effect: Effect): ReadOff {
  if (effect.type !== "interaction") {
    return NOTHING;
  }
  const { interaction, binding } = effect;
  if (interaction.class === "message-send") {
    return isShape(interaction.body)
      ? bodyData(
          "sends",
          binding,
          interaction.body,
          `sends a message to ${displayLabel(binding)} whose fields suss could not read`,
        )
      : NOTHING;
  }

  if (interaction.class !== "storage-access" || interaction.kind !== "read") {
    return NOTHING;
  }
  const scope = storageBoundaryKey(binding.semantics);
  if (scope === null) {
    return NOTHING;
  }
  const at = displayLabel(binding);
  const unread = (reason: string): ReadOff => ({
    named: [],
    unread: [{ kind: "column", at, scope, reason }],
  });
  const relationPath = interaction.relationPath ?? [];
  if (relationPath.length > 0) {
    return unread(
      `reads ${at} through ${relationPath.join(".")}, and only the store's contract says which columns that reaches`,
    );
  }

  if (interaction.fields.length === 0 || interaction.fields.includes("*")) {
    return unread(
      `reads every column of ${at}, so suss cannot tell which of them it uses`,
    );
  }
  return {
    named: interaction.fields.map((field) => ({
      kind: "column",
      at,
      scope,
      field,
    })),
    unread: [],
  };
}

function isShape(value: unknown): value is TypeShape {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    (value as { type: string }).type in FIELD_PATHS
  );
}

/** The fields a route responds with, at the route. */
function sentBody(summary: BehavioralSummary, output: Output): ReadOff {
  const binding = outsideBinding(summary);
  if (
    binding === null ||
    BOUNDARY_ROLE[summary.kind] !== "provider" ||
    output.type !== "response" ||
    output.body === null
  ) {
    return NOTHING;
  }
  return bodyData(
    "sends",
    binding,
    output.body,
    "responds with a body whose fields suss could not read",
  );
}

/** The fields a client takes off the response it gets back. */
function readBody(summary: BehavioralSummary, transition: Transition): ReadOff {
  const binding = outsideBinding(summary);
  if (
    binding === null ||
    BOUNDARY_ROLE[summary.kind] !== "consumer" ||
    !exchangesHttpResponses(binding) ||
    transition.expectedInput === undefined
  ) {
    return NOTHING;
  }
  return bodyData(
    "reads",
    binding,
    unwrapBodyField(transition.expectedInput, summary),
    `takes the ${displayLabel(binding)} response whole, so suss cannot tell which fields it uses`,
  );
}

const STAND_DOWN_WORDS: Record<StandDown, string> = {
  "no-reads": "reads no field of the message that suss could see",
  "rest-parameter":
    "takes the message through a rest parameter, which can hold any field",
  "payload-used-whole":
    "passes the whole message on, so any field of it could be read elsewhere",
  "sender-opaque": "reads a message suss could not inspect",
  "different-object": "reads fields of something other than the message",
  "platform-envelope":
    "reads the platform's envelope rather than the message body",
  "unmapped-protocol": "reads its input in a way this protocol does not map",
};

/** The fields a message consumer reads, which apply to every path of it. */
function consumerReads(summary: BehavioralSummary): ReadOff[] {
  const binding = outsideBinding(summary);
  if (!bindingIs(binding, "message-bus")) {
    return [];
  }
  const result = messageBodyReadSet(summary, binding.semantics.messageBus);
  const scope = boundaryKey(binding) ?? displayLabel(binding);
  const at = displayLabel(binding);
  if (!result.read) {
    const reason = STAND_DOWN_WORDS[result.reason];
    return [{ named: [], unread: [{ kind: "reads", at, scope, reason }] }];
  }
  return [
    {
      named: result.reads.paths.map((path) => ({
        kind: "reads",
        at,
        scope,
        field: path.join("."),
      })),
      unread: [],
    },
  ];
}

// ---------------------------------------------------------------------------
// How one path sends data out
// ---------------------------------------------------------------------------

/** Methods that ask another service for something and hand it nothing to keep. */
const ASKING_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Interaction = Extract<Effect, { type: "interaction" }>["interaction"];

/** What an interaction sends out, by its class, given the boundary's label. */
const INTERACTION_EXITS: {
  [K in Interaction["class"]]: (
    interaction: Extract<Interaction, { class: K }>,
    label: string,
  ) => string[];
} = {
  "storage-access": (interaction, label) =>
    interaction.kind === "write" ? [`writes ${label}`] : [],
  "message-send": (_interaction, label) => [`publishes to ${label}`],
  "stream-write": (_interaction, label) => [`writes ${label}`],
  "unit-invoke": (_interaction, label) => [`invokes ${label}`],
  "service-call": (interaction, label) =>
    ASKING_METHODS.has(interaction.method.toUpperCase())
      ? []
      : [`calls ${label}`],
  "message-receive": () => [],
  "config-read": () => [],
  "metadata-read": () => [],
  schedule: () => [],
};

/** What one effect sends out of the process, in the words a report prints. */
function effectExits(effect: Effect): string[] {
  if (effect.type !== "interaction" || !leavesTheProcess(effect.binding)) {
    return [];
  }
  const exits = INTERACTION_EXITS[effect.interaction.class] as (
    interaction: Interaction,
    label: string,
  ) => string[];
  return exits(effect.interaction, displayLabel(effect.binding));
}

const OUTPUT_EXITS: DispatchTable<
  Output,
  (summary: BehavioralSummary) => string[]
> = {
  response: (output) => (summary) =>
    BOUNDARY_ROLE[summary.kind] === "provider"
      ? [`responds ${statusWords(output)}`]
      : [],
  render: (output) => () => [`renders ${output.component}`],
  emit: (output) => () => [`emits ${output.event}`],
  return: () => (summary) => {
    const binding = outsideBinding(summary);
    return binding !== null && BOUNDARY_ROLE[summary.kind] === "provider"
      ? [`returns to ${displayLabel(binding)}`]
      : [];
  },
  throw: () => () => [],
  delegate: () => () => [],
  void: () => () => [],
  exit: () => () => [],
};

function statusWords(output: Extract<Output, { type: "response" }>): string {
  const status = output.statusCode;
  if (status === null || status.type !== "literal") {
    return "with a status suss could not read";
  }
  return String(status.value);
}

function pathExits(
  summary: BehavioralSummary,
  transition: Transition,
): string[] {
  return [
    ...dispatchByType(OUTPUT_EXITS, transition.output)(summary),
    ...transition.effects.flatMap(effectExits),
  ];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const P = v("p");
const Q = v("q");
const U = v("u");
const F = v("f");
const G = v("g");
const D = v("d");
const S = v("s");
const W = v("w");
const H = v("h");

/** What each asked path uses, through the functions it calls. */
const DATA_ON: Rule[] = [
  rule("fromPath", [P, F], [lit("startPath", P), lit("pathCalls", P, F)]),
  rule("fromPath", [P, G], [lit("fromPath", P, F), lit("calls", F, G)]),
  rule("usedOn", [P, D], [lit("startPath", P), lit("pathUses", P, D)]),
  rule("usedOn", [P, D], [lit("fromPath", P, F), lit("functionUses", F, D)]),
  rule("unreadOn", [P, W], [lit("startPath", P), lit("pathUnread", P, S, W)]),
  rule(
    "unreadOn",
    [P, W],
    [lit("fromPath", P, F), lit("functionUnread", F, S, W)],
  ),
];

/**
 * The paths outside the change that use an asked datum, or read its
 * store or boundary in a way suss could not read, and send data out. The
 * change covers the changed units, their callers, and what they call.
 */
const SHARING: Rule[] = [
  rule("askedScope", [S], [lit("asked", D), lit("datumScope", D, S)]),

  rule("hasData", [F, D], [lit("asked", D), lit("functionUses", F, D)]),
  rule("hasData", [F, D], [lit("calls", F, G), lit("hasData", G, D)]),
  rule("pathHas", [P, D], [lit("asked", D), lit("pathUses", P, D)]),
  rule("pathHas", [P, D], [lit("pathCalls", P, F), lit("hasData", F, D)]),

  rule(
    "mayHave",
    [F, S, W],
    [lit("askedScope", S), lit("functionUnread", F, S, W)],
  ),
  rule("mayHave", [F, S, W], [lit("calls", F, G), lit("mayHave", G, S, W)]),
  rule(
    "pathMay",
    [P, S, W],
    [lit("askedScope", S), lit("pathUnread", P, S, W)],
  ),
  rule("pathMay", [P, S, W], [lit("pathCalls", P, F), lit("mayHave", F, S, W)]),

  rule("candidate", [P], [lit("pathHas", P, D)]),
  rule("candidate", [P], [lit("pathMay", P, S, W)]),
  rule("wantsExit", [F], [lit("candidate", P), lit("pathCalls", P, F)]),
  rule("wantsExit", [G], [lit("wantsExit", F), lit("calls", F, G)]),
  rule("exitsFrom", [F, H], [lit("wantsExit", F), lit("functionExit", F, H)]),
  rule(
    "exitsFrom",
    [F, H],
    [lit("wantsExit", F), lit("calls", F, G), lit("exitsFrom", G, H)],
  ),
  rule("pathSends", [P, H], [lit("candidate", P), lit("pathExit", P, H)]),
  rule(
    "pathSends",
    [P, H],
    [lit("candidate", P), lit("pathCalls", P, F), lit("exitsFrom", F, H)],
  ),
  rule("sending", [P], [lit("pathSends", P, H)]),

  rule("callsChanged", [F], [lit("changed", F)]),
  rule("callsChanged", [F], [lit("calls", F, G), lit("callsChanged", G)]),
  rule("calledByChanged", [G], [lit("changed", F), lit("calls", F, G)]),
  rule("calledByChanged", [G], [lit("calledByChanged", F), lit("calls", F, G)]),
  rule("inChange", [U], [lit("unitFunction", U, F), lit("callsChanged", F)]),
  rule("inChange", [U], [lit("unitFunction", U, F), lit("calledByChanged", F)]),
  rule("leftOut", [U], [lit("inChange", U)]),
  rule("leftOut", [U], [lit("testUnit", U)]),

  rule(
    "shares",
    [P, D],
    [
      lit("pathHas", P, D),
      lit("sending", P),
      lit("onPath", P, U),
      notLit("leftOut", U),
    ],
  ),
  rule(
    "mayShare",
    [P, W],
    [
      lit("pathMay", P, S, W),
      lit("sending", P),
      lit("onPath", P, U),
      notLit("leftOut", U),
    ],
  ),

  // A listed path that another listed path calls into is shown once,
  // under the outer one, since that is the exit a reviewer would edit.
  rule("listed", [P], [lit("shares", P, D)]),
  rule("listed", [P], [lit("mayShare", P, W)]),
  rule("under", [P, F], [lit("listed", P), lit("pathCalls", P, F)]),
  rule("under", [P, G], [lit("under", P, F), lit("calls", F, G)]),
  rule(
    "nested",
    [Q, P],
    [lit("under", P, F), lit("unitFunction", U, F), lit("onPath", Q, U)],
  ),
];

function dataOnPaths(
  db: Database,
  base: BaseFacts,
  paths: readonly DataPath[],
): Map<Transition, PathData> {
  const asked = new Map<string, Transition>();
  for (const { transition } of paths) {
    const key = base.paths.get(transition);
    if (key !== undefined) {
      asked.set(key, transition);
      db.add("startPath", [key]);
    }
  }
  evaluate(db, DATA_ON);

  const out = new Map<Transition, PathData>();
  for (const [key, transition] of asked) {
    const named = db
      .lookup("usedOn", 0, key)
      .map((tuple) => base.data.get(String(tuple[1])))
      .filter((datum): datum is Datum => datum !== undefined);
    const unread = db
      .lookup("unreadOn", 0, key)
      .map((tuple) => base.unread.get(String(tuple[1])))
      .filter((one): one is UnreadData => one !== undefined);
    out.set(transition, {
      named: uniqueBy(named, datumKey),
      unread: uniqueBy(unread, unreadKey),
    });
  }
  return out;
}

function sharingPaths(
  db: Database,
  base: BaseFacts,
  data: readonly Datum[],
  changed: readonly BehavioralSummary[],
): Sharing {
  for (const datum of data) {
    const key = datumKey(datum);
    db.add("asked", [key]);
    db.add("datumScope", [key, scopeKey(datum.kind, datum.scope)]);
  }

  for (const summary of changed) {
    db.add("changed", [functionOf(summary)]);
  }
  evaluate(db, SHARING);

  const nested = new Set<string>();
  for (const [inner, outer] of db.facts("nested")) {
    if (inner !== outer && db.has("listed", [inner])) {
      nested.add(String(inner));
    }
  }

  const sends = (path: string): string[] =>
    uniqueBy(
      db.lookup("pathSends", 0, path).map((tuple) => String(tuple[1])),
      (exit) => exit,
    );

  const shared = new Map<string, Datum[]>();
  for (const [path, key] of db.facts("shares")) {
    const datum = base.data.get(String(key));
    if (datum === undefined || nested.has(String(path))) {
      continue;
    }
    shared.set(String(path), [...(shared.get(String(path)) ?? []), datum]);
  }

  const unread = new Map<string, UnreadData[]>();
  for (const [path, key] of db.facts("mayShare")) {
    const one = base.unread.get(String(key));
    const at = String(path);
    if (one === undefined || nested.has(at)) {
      continue;
    }
    unread.set(at, [...(unread.get(at) ?? []), one]);
  }

  return {
    sharing: [...shared.entries()].flatMap(([path, shares]) => {
      const at = base.pathsByKey.get(path);
      return at === undefined
        ? []
        : [{ ...at, shares: uniqueBy(shares, datumKey), sends: sends(path) }];
    }),
    unchecked: [...unread.entries()].flatMap(([path, reasons]) => {
      const at = base.pathsByKey.get(path);
      return at === undefined
        ? []
        : [{ ...at, unread: uniqueBy(reasons, unreadKey), sends: sends(path) }];
    }),
  };
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    if (!seen.has(key(item))) {
      seen.set(key(item), item);
    }
  }
  return [...seen.values()];
}
