/**
 * `suss infer intent`: turn what suss read out of the code into
 * starting boundary intent docs for somebody to curate. One document
 * per boundary, each saying `source: "inferred"`, which is what tells
 * the checker to downgrade findings against it until a person fills in
 * the purpose and the audience and moves it to `"inferred, curated"`.
 *
 * The mapping mostly moves fields across. What the code cannot supply
 * is left out rather than filled in with a placeholder, and a boundary
 * no document could be written for is named in the report.
 *
 * The transform lives in the CLI because it reads a BehavioralSummary
 * and writes an intent doc, and neither IR package depends on the other.
 */

import fs from "node:fs";
import { STATUS_CODES } from "node:http";
import path from "node:path";

import YAML from "yaml";

import {
  BOUNDARY_ROLE,
  boundaryKey,
  boundaryLabel,
  dispatchByType,
  displayLabel,
  goesThroughRelation,
  relationsOf,
  withDeclaredDelivery,
} from "@suss/behavioral-ir";
import { summaryWithDefinitionsInlined } from "@suss/checker";
import { whatWouldKeyIt } from "@suss/checker-intent";
import { loadIntentDoc } from "@suss/contract-intent";
import { EVERY_FIELD } from "@suss/ir-core";

import { parseSummaryFile, readSummariesFromDir } from "./inspect.js";
import { draftedWhen } from "./intentWhen.js";
import { UsageError } from "./usageError.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  DispatchTable,
  Interaction,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  AuthoredBoundary,
  AuthoredShape,
  EffectOutcome,
  When,
} from "@suss/intent-ir";

export interface IntentDraftOptions {
  /** Summaries file to read, the output of `suss extract`. */
  from: string;
  /** Where the documents go. Default: `intent/`. */
  out?: string;
  /** Same destination, but it refuses to write over existing intent docs. */
  into?: string;
}

export interface DraftedIntent {
  /** File name within the destination directory. */
  file: string;
  /** The document's `name`, which PRD scenarios link through. */
  name: string;
  /** The boundary key it was drafted for. */
  boundary: string;
  outcomes: number;
  yaml: string;
}

/** A boundary the summaries describe that no document could be written for. */
export interface UndraftedBoundary {
  boundary: string;
  reason: string;
}

export interface IntentDraftResult {
  drafted: DraftedIntent[];
  undrafted: UndraftedBoundary[];
}

/** The default destination, the folder `suss check --intent` reads. */
const DEFAULT_OUT = "intent";

// ---------------------------------------------------------------------------
// Outcomes: a code transition's terminal as a declared intent outcome
// ---------------------------------------------------------------------------

interface DraftedOutcome {
  id: string;
  when: When;
  response?: { status: number; body?: AuthoredShape };
  returns?: { body?: AuthoredShape };
  throws?: { errorType?: string };
  results?: EffectOutcome[];
}

const UNKNOWN_SHAPE: AuthoredShape = { type: "unknown" };

function literalShape(value: string | number | boolean): AuthoredShape {
  if (typeof value === "string") {
    return { type: "string" };
  }

  if (typeof value === "boolean") {
    return { type: "boolean" };
  }

  return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
}

// A shape the authoring vocabulary cannot spell becomes `unknown`, which
// the checker reads as "the intent says nothing here" rather than as a
// claim the code has to satisfy.
const AUTHORED_SHAPES: DispatchTable<TypeShape, AuthoredShape> = {
  record: (shape) => ({
    type: "object",
    properties: Object.fromEntries(
      Object.entries(shape.properties).map(([name, property]) => [
        name,
        toAuthoredShape(property),
      ]),
    ),
  }),
  array: (shape) => ({ type: "array", items: toAuthoredShape(shape.items) }),
  literal: (shape) => literalShape(shape.value),
  text: () => ({ type: "string" }),
  integer: () => ({ type: "integer" }),
  number: () => ({ type: "number" }),
  boolean: () => ({ type: "boolean" }),
  null: () => ({ type: "null" }),
  dictionary: () => UNKNOWN_SHAPE,
  undefined: () => UNKNOWN_SHAPE,
  union: () => UNKNOWN_SHAPE,
  ref: () => UNKNOWN_SHAPE,
  unknown: () => UNKNOWN_SHAPE,
};

export function toAuthoredShape(shape: TypeShape): AuthoredShape {
  return dispatchByType(AUTHORED_SHAPES, shape);
}

/** Null when the whole shape came back `unknown`, so no body is declared. */
function declaredBody(shape: TypeShape | null): AuthoredShape | null {
  if (shape === null) {
    return null;
  }
  const authored = toAuthoredShape(shape);
  return authored.type === "unknown" ? null : authored;
}

/** `404` becomes `404-not-found`; a status with no name keeps its number. */
export function statusOutcomeId(status: number): string {
  const name = STATUS_CODES[status];
  return name === undefined ? String(status) : `${status}-${slug(name)}`;
}

/**
 * What this transition did at other boundaries, written the way
 * `suss ask` asks about one: `- writes: aws.dynamodb:Invoices`. A
 * boundary with no name of its own is left out rather than written as
 * a string nobody would type back.
 */
function draftedEffects(transition: Transition): EffectOutcome[] {
  const results: EffectOutcome[] = [];
  const written = new Set<string>();
  for (const effect of transition.effects) {
    if (
      effect.type !== "interaction" ||
      goesThroughRelation(effect.interaction)
    ) {
      continue;
    }
    const names = boundaryLabel(effect.binding);
    if (names === null) {
      continue;
    }
    const touched = touchedBy(effect.interaction);
    for (const relation of relationsOf(effect.interaction)) {
      if (relation === "provides") {
        continue;
      }
      const key = `${relation} ${names}`;
      if (written.has(key)) {
        continue;
      }
      written.add(key);
      results.push({ [relation]: names, ...touched });
    }
  }
  return results;
}

/**
 * The columns an access states, when it states any. A DynamoDB write
 * records none, because nothing parses an UpdateExpression, so the
 * clause comes out with the boundary alone.
 */
function touchedBy(interaction: Interaction): {
  fields?: string[];
  by?: string[];
} {
  if (interaction.class !== "storage-access") {
    return {};
  }
  // An access that asked for every column says the same thing as one
  // that says nothing about columns, so the clause leaves it out.
  const fields = interaction.fields.filter((one) => one !== EVERY_FIELD);
  const by = interaction.selector ?? [];
  return {
    ...(fields.length > 0 ? { fields } : {}),
    ...(by.length > 0 ? { by } : {}),
  };
}

/** Null when the transition's terminal has no intent outcome to declare. */
function toDraftedOutcome(
  transition: Transition,
  summary: BehavioralSummary,
  isFirst: boolean,
): DraftedOutcome | null {
  const output = transition.output;
  const when = draftedWhen(transition, summary, isFirst);
  const results = draftedEffects(transition);
  const did = results.length > 0 ? { results } : {};

  if (output.type === "response") {
    const status =
      output.statusCode !== null && output.statusCode.type === "literal"
        ? Number(output.statusCode.value)
        : Number.NaN;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      return effectOnlyOutcome(when, results);
    }
    const body = declaredBody(output.body);
    return {
      id: statusOutcomeId(status),
      when,
      response: { status, ...(body !== null ? { body } : {}) },
      ...did,
    };
  }

  if (output.type === "return") {
    const body = declaredBody(output.value);
    return {
      id: "returns",
      when,
      returns: body !== null ? { body } : {},
      ...did,
    };
  }

  if (output.type === "throw") {
    const errorType = output.exceptionType;
    return {
      id: errorType === null ? "throws" : `throws-${slug(errorType)}`,
      when,
      throws: errorType === null ? {} : { errorType },
      ...did,
    };
  }

  return effectOnlyOutcome(when, results);
}

/**
 * A transition whose ending the schema has no words for still says what
 * it did, and that is the whole outcome for a unit whose ending nobody
 * declares anyway.
 */
function effectOnlyOutcome(
  when: When,
  results: EffectOutcome[],
): DraftedOutcome | null {
  const first = results[0];
  if (first === undefined) {
    return null;
  }
  const [verb, names] = Object.entries(first)[0] as [string, string];
  return { id: slug(`${verb} ${names}`), when, results };
}

// ---------------------------------------------------------------------------
// Boundaries: which ones a document can be written for
// ---------------------------------------------------------------------------

type Semantics = BoundaryBinding["semantics"];

/** Per protocol, the boundary block to write, or null for one v0.1 has no shape for. */
type BoundaryBlocks = {
  [K in Semantics["name"]]: (
    semantics: Extract<Semantics, { name: K }>,
    binding: BoundaryBinding,
  ) => AuthoredBoundary | null;
};

const BOUNDARY_BLOCKS: BoundaryBlocks = {
  rest: (semantics) => ({
    transport: "http",
    semantics: "rest",
    method: semantics.method ?? "",
    path: semantics.path ?? "",
  }),
  "function-call": (semantics, binding) => ({
    transport: binding.transport,
    semantics: "function-call",
    ...(semantics.module !== undefined ? { module: semantics.module } : {}),
    ...(semantics.exportName !== undefined
      ? { exportName: semantics.exportName }
      : {}),
    ...(semantics.package !== undefined ? { package: semantics.package } : {}),
    ...(semantics.exportPath !== undefined
      ? { exportPath: semantics.exportPath }
      : {}),
  }),
  // A field the source left unset stays out of the file. The schema
  // defaults it, and a key with nothing after it is one more thing for
  // the person curating the draft to read past.
  "message-bus": (semantics) => ({
    semantics: "message-bus",
    messageBus: semantics.messageBus,
    ...(semantics.channel !== null ? { channel: semantics.channel } : {}),
  }),
  storage: (semantics) => ({
    semantics: "storage",
    storageSystem: semantics.storageSystem,
    ...(semantics.scope !== "default" ? { scope: semantics.scope } : {}),
    ...(semantics.container !== null ? { container: semantics.container } : {}),
    ...(semantics.accessPath !== null
      ? { accessPath: semantics.accessPath }
      : {}),
  }),
  "graphql-resolver": () => null,
  "graphql-operation": () => null,
  "runtime-config": () => null,
  metric: () => null,
};

/** Null when boundary intent has no shape for this protocol yet. */
function boundaryBlock(binding: BoundaryBinding): AuthoredBoundary | null {
  // The one cast joins the per-protocol table, which narrows, to the
  // runtime lookup, the same way dispatchByType does it.
  const write = BOUNDARY_BLOCKS[binding.semantics.name] as (
    semantics: Semantics,
    binding: BoundaryBinding,
  ) => AuthoredBoundary | null;
  return write(binding.semantics, binding);
}

interface BoundaryGroup {
  key: string;
  block: AuthoredBoundary;
  summaries: BehavioralSummary[];
}

function groupByBoundary(input: BehavioralSummary[]): {
  groups: BoundaryGroup[];
  undrafted: UndraftedBoundary[];
} {
  // A queue consumer's behaviour and the queue that reaches it arrive
  // as two summaries. Drafting one document needs them in one group.
  const summaries = withDeclaredDelivery(input);
  const groups = new Map<string, BoundaryGroup>();
  const undrafted: UndraftedBoundary[] = [];
  const alreadySaid = new Set<string>();
  const sayOnce = (one: UndraftedBoundary) => {
    if (!alreadySaid.has(`${one.boundary}|${one.reason}`)) {
      alreadySaid.add(`${one.boundary}|${one.reason}`);
      undrafted.push(one);
    }
  };

  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    // A consumer of a boundary is a caller, and intent declares what a
    // boundary provides, so there is nothing here to say about one.
    if (binding === null || BOUNDARY_ROLE[summary.kind] !== "provider") {
      continue;
    }
    const block = boundaryBlock(binding);
    if (block === null) {
      sayOnce({
        boundary: displayLabel(binding),
        reason: `boundary intent declares rest, function-call, message-bus and storage boundaries, and this one is ${binding.semantics.name}`,
      });
      continue;
    }
    const key = boundaryKey(binding);
    if (key === null) {
      sayOnce({
        boundary: displayLabel(binding),
        reason: `it has no key the checker could pair intent against: ${whatWouldKeyIt(binding.semantics.name)}`,
      });
      continue;
    }
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { key, block, summaries: [summary] });
      continue;
    }
    existing.summaries.push(summary);
  }

  return { groups: [...groups.values()], undrafted };
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** `GET /users/{id}` becomes `get-users-id`, `checkAll` becomes `check-all`. */
export function slug(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The first spelling nothing has taken yet, `-2` onwards after that. */
function unique(candidate: string, taken: Set<string>): string {
  let chosen = candidate;
  for (let n = 2; taken.has(chosen); n += 1) {
    chosen = `${candidate}-${n}`;
  }
  taken.add(chosen);
  return chosen;
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

/** How many source files a header lists before a count takes over. */
const FILES_SHOWN = 3;

function header(group: BoundaryGroup, from: string): string[] {
  const files = [...new Set(group.summaries.map((s) => s.location.file))];
  const shown = files.slice(0, FILES_SHOWN).join(", ");
  const rest = files.length - Math.min(files.length, FILES_SHOWN);
  const read = rest > 0 ? `${shown} and ${rest} more` : shown;
  return [
    `# ${group.key}, as the code has it today.`,
    `# Read from ${read}, by way of ${from}.`,
    "#",
    "# Written from what the code does, so it says nothing about why. Fill in",
    "# purpose and audience, rename this document and its outcome ids to what",
    '# your team calls them, then set source to "inferred, curated" so findings',
    "# against it count at full severity.",
    "#",
    "# Until the blanks are filled the reader rejects this file and says so,",
    "# which is what keeps an uncurated draft from passing for finished.",
  ];
}

/** The blanks, and the hint written beside each one. */
const BLANKS: Record<string, string> = {
  purpose: "what this boundary is for, in your words",
  audience: "who observes it: a customer, an operator, another service",
};

/** What the blanks are filled with while the rest of the doc is validated. */
export const FILLED_IN = "curated";

/** Keys a blank line comes before, so the file reads in parts. */
const PARAGRAPHS = new Set(["name", "boundary", "transitions"]);

/**
 * The document as YAML, with the hint for each blank written beside it
 * wherever it turns up, since a PRD leaves its blanks inside scenarios
 * rather than at the top.
 */
export function render(
  doc: object,
  blanks: Record<string, string>,
  paragraphs: ReadonlySet<string>,
): string {
  const yamlDoc = new YAML.Document(doc);
  YAML.visit(yamlDoc, {
    Pair(_, pair, path) {
      if (!YAML.isScalar(pair.key)) {
        return;
      }
      const key = String(pair.key.value);
      if (paragraphs.has(key) && path.length <= 2) {
        pair.key.spaceBefore = true;
      }
      const hint = blanks[key];
      if (hint !== undefined && YAML.isScalar(pair.value)) {
        pair.value.comment = ` ${hint}`;
      }
    },
  });
  return yamlDoc.toString({ lineWidth: 0 });
}

function draftDocument(
  group: BoundaryGroup,
  names: Set<string>,
  from: string,
): DraftedIntent | UndraftedBoundary {
  const transitions = group.summaries.flatMap((s) => s.transitions);
  const outcomeIds = new Set<string>();
  const outcomes: DraftedOutcome[] = [];
  for (const summary of group.summaries) {
    summary.transitions.forEach((transition, index) => {
      const outcome = toDraftedOutcome(transition, summary, index === 0);
      if (outcome !== null) {
        outcomes.push({ ...outcome, id: unique(outcome.id, outcomeIds) });
      }
    });
  }

  if (outcomes.length === 0) {
    return {
      boundary: group.key,
      reason:
        transitions.length === 0
          ? "the summaries record no transition for it"
          : "no transition of it produces a response, a return, or a throw",
    };
  }

  const name = unique(slug(group.key) || "boundary", names);
  const doc = {
    kind: "boundary" as const,
    name,
    purpose: "",
    audience: "",
    source: "inferred" as const,
    boundary: group.block,
    transitions: outcomes,
  };

  // Filling the blanks first means the only thing the reader can
  // complain about in the file this writes is the blanks. Nothing today
  // reaches the catch; a mapping that grows a bad case would.
  try {
    loadIntentDoc({ ...doc, purpose: FILLED_IN, audience: FILLED_IN });
    /* v8 ignore start */
  } catch (error) {
    return {
      boundary: group.key,
      reason: `the intent reader would reject the drafted document: ${oneLine(error)}`,
    };
  }
  /* v8 ignore stop */

  const dropped = transitions.length - outcomes.length;
  const note =
    dropped === 0
      ? []
      : [
          "#",
          `# ${dropped} transition(s) here produce nothing this schema can`,
          "# declare, so no outcome below covers them.",
        ];

  return {
    file: `${name}.intent.yaml`,
    name,
    boundary: group.key,
    outcomes: outcomes.length,
    yaml: `${[...header(group, from), ...note].join("\n")}\n\n${render(doc, BLANKS, PARAGRAPHS)}`,
  };
}

/* v8 ignore start */
function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n").join(" ");
}
/* v8 ignore stop */

/** `from` is the summaries file, written into each document's header. */
export function intentDraftResult(
  summaries: BehavioralSummary[],
  from: string,
): IntentDraftResult {
  const { groups, undrafted } = groupByBoundary(summaries);
  const drafted: DraftedIntent[] = [];
  const names = new Set<string>();

  for (const group of groups) {
    const result = draftDocument(group, names, from);
    if ("file" in result) {
      drafted.push(result);
      continue;
    }

    undrafted.push(result);
  }

  return { drafted, undrafted };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const INTENT_DOC = /\.(intent|prd)\.(yaml|yml|json)$/;

/** The documents already in `dir` that `matching` claims. */
export function docsIn(dir: string, matching = INTENT_DOC): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matching.test(entry.name))
    .map((entry) => entry.name);
}

export function destinationOf(options: { out?: string; into?: string }): {
  dir: string;
  overExisting: "warn" | "refuse";
} {
  if (options.into !== undefined && options.out !== undefined) {
    throw new UsageError(
      "--out and --into name the same directory, so pass one of them. --into is the one that refuses to write where intent docs already are.",
    );
  }

  if (options.into !== undefined) {
    return { dir: options.into, overExisting: "refuse" };
  }

  return { dir: options.out ?? DEFAULT_OUT, overExisting: "warn" };
}

/**
 * A folder reads the same as a file, because extracting one file per
 * pack and pointing commands at the folder is the flow the docs teach.
 */
function readSummariesFile(from: string): BehavioralSummary[] {
  const resolved = path.resolve(from);
  if (!fs.existsSync(resolved)) {
    throw new UsageError(`No file or folder at ${resolved}.`);
  }

  const read = fs.statSync(resolved).isDirectory()
    ? readSummariesFromDir(resolved)
    : parseSummaryFile(resolved, fs.readFileSync(resolved, "utf-8"));
  return read.map(summaryWithDefinitionsInlined);
}

export function intentDraft(options: IntentDraftOptions): number {
  const result = intentDraftResult(
    readSummariesFile(options.from),
    options.from,
  );
  const destination = destinationOf(options);
  const dir = path.resolve(destination.dir);

  if (result.drafted.length === 0) {
    process.stderr.write(
      `No boundary in ${options.from} could be drafted as intent.${undraftedReport(result.undrafted)}\n`,
    );
    return 1;
  }

  const existing = docsIn(dir);
  if (existing.length > 0 && destination.overExisting === "refuse") {
    throw new UsageError(
      `${dir} already holds ${existing.length} intent doc(s). --into writes where the curated docs are not, so pick a folder that has none.`,
    );
  }
  if (existing.length > 0) {
    process.stderr.write(
      `${dir} already holds ${existing.length} intent doc(s), and re-inferring writes over them. Any curation in them goes too. ` +
        "Pass --into <dir> to put this run somewhere else and reconcile the two by hand.\n",
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const doc of result.drafted) {
    fs.writeFileSync(path.join(dir, doc.file), doc.yaml);
  }

  const count = result.drafted.length;
  process.stdout.write(
    `Drafted ${count} boundary intent doc${count === 1 ? "" : "s"} in ${dir}, ` +
      "each with purpose and audience left blank. Fill them in, rename the " +
      'outcome ids to what your team calls them, then set source to "inferred, curated". ' +
      "Until then `suss check --intent` says which files are still waiting." +
      `${undraftedReport(result.undrafted)}\n`,
  );
  return 0;
}

/** How many undrafted boundaries get written out before a count takes over. */
const UNDRAFTED_SHOWN = 10;

function undraftedReport(undrafted: UndraftedBoundary[]): string {
  if (undrafted.length === 0) {
    return "";
  }

  const lines = undrafted
    .slice(0, UNDRAFTED_SHOWN)
    .map((one) => `  - ${one.boundary}: ${one.reason}`);
  const left = undrafted.length - lines.length;
  if (left > 0) {
    lines.push(`  and ${left} more`);
  }

  const plural = undrafted.length === 1 ? "y" : "ies";
  return `\n\nNo document for ${undrafted.length} boundar${plural}:\n${lines.join("\n")}`;
}
