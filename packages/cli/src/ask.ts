/**
 * `suss ask`: one question, answered from the summaries already on
 * disk, and for a why question from the source as well.
 *
 * Seven shapes, and no parser behind them. A question that is not one
 * of the seven gets the seven printed back rather than a guess at what
 * it meant: a wrong answer about a store is worse than no answer.
 *
 * An answer says what it is missing. Nothing on disk declares what most
 * stores serve until somebody reads the deploy template in, and a list
 * of fields assembled from call sites would look like the same thing
 * while meaning something weaker.
 */

import fs from "node:fs";

import {
  readHttpMetadata,
  readRuntimeContractMetadata,
  readStorageContractMetadata,
  summaryIdentifier,
} from "@suss/behavioral-ir";

import { answerCalls } from "./askCalls.js";
import { gapCaveats } from "./askCaveats.js";
import { groundedTouchesAt } from "./askGrounding.js";
import { expandShorthand, looksLikeShorthand } from "./askShorthand.js";
import { askWhy, invocationEdges, WHY_SHAPES } from "./askWhy.js";
import { writeReport } from "./check.js";
import { parseSummaryFile, readSummariesFromDir } from "./inspect.js";
import {
  collapseTouches,
  type ResolvedTarget,
  resolveTarget,
  type TargetTouch,
  touchesOfUnits,
} from "./target.js";
import { UsageError } from "./usageError.js";

import type {
  BehavioralSummary,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";
import type { GroundingNote } from "./askGrounding.js";
import type { WhyShape } from "./askWhy.js";

export type QuestionShape =
  | "declares"
  | "reads"
  | "writes"
  | "calls"
  | "reaches"
  | "reachedBy"
  | WhyShape;

export interface AskOptions {
  question: string;
  dir?: string;
  file?: string;
  json?: boolean;
  /** Print every item, rather than the first few and a count. */
  all?: boolean;
  output?: string;
  /** Where the source is, for a why question. Defaults to the cwd. */
  project?: string;
}

/** A parsed question: the shape, and the words it was asked with. */
export interface ParsedQuestion {
  shape: QuestionShape;
  subject: string;
  /** The other half of a why question: a boundary, or a target. */
  object?: string;
  /** Where a why-resolve question points. */
  at?: { file: string; line: number };
}

export interface AnswerItem {
  text: string;
  data: Record<string, unknown>;
}

export interface Answer {
  shape: QuestionShape;
  subject: string;
  /** The answer in one sentence. */
  headline: string;
  items: AnswerItem[];
  /** What this run would need to say more. */
  needs: string[];
  /** What could make the answer wrong, said plainly. */
  caveats: string[];
  /** False when the subject is not in these summaries at all. */
  found: boolean;
  /** Structure only the JSON form prints: chains, hops, costs. */
  detail?: Record<string, unknown>;
}

/** The summary questions, and how each one is written. */
const SHAPES: ReadonlyArray<{ shape: QuestionShape; pattern: RegExp }> = [
  { shape: "declares", pattern: /^what can i project from\s+(.+)$/i },
  { shape: "declares", pattern: /^what does\s+(.+?)\s+declare$/i },
  { shape: "reads", pattern: /^what reads\s+(.+)$/i },
  { shape: "writes", pattern: /^what writes\s+(.+)$/i },
  { shape: "calls", pattern: /^what calls\s+(.+)$/i },
  { shape: "reaches", pattern: /^what does\s+(.+?)\s+reach$/i },
  { shape: "reachedBy", pattern: /^what reaches\s+(.+)$/i },
];

const HOW_TO_ASK = `suss ask takes one of eight questions:
  suss ask 'what can I project from aws.dynamodb:editions#by-publication'
  suss ask 'what reads aws.dynamodb:editions'
  suss ask 'what writes aws.dynamodb:editions'
  suss ask 'what calls src/editions/dao.ts'
  suss ask 'what does src/editions/dao.ts reach'
  suss ask 'what reaches src/editions/dao.ts'
  suss ask 'why does src/editions/dao.ts reach aws.dynamodb:editions'
  suss ask 'why does handler at src/app.ts:12 resolve to createHandler'
The same five, in symbols: '<- <unit>', '<unit> ->',
'<unit> -> <boundary> ?', 'r<- <boundary>', 'w<- <boundary>'.
Add --dir to say which summaries to read, or pass one summaries file.
A why question reads the source too; --project says where it is when it
is not the working directory.`;

export function ask(options: AskOptions): number {
  return answerQuestion(options).exitCode;
}

/**
 * The same run as `ask`, with the answer handed back rather than only
 * written out.
 *
 * A caller inside the same process wants the answer as data. Reading it
 * back off stdout is the only other way, and a long-lived caller asking
 * many questions should not have to.
 */
export function answerQuestion(options: AskOptions): {
  exitCode: number;
  answer: AnswerJson | null;
} {
  const question = parseQuestion(options.question);
  if (question === null) {
    const report =
      options.json === true
        ? `${JSON.stringify(
            {
              question: options.question,
              answer: null,
              message:
                "Not one of the questions suss answers. Run suss --help for the forms.",
            },
            null,
            2,
          )}\n`
        : `${HOW_TO_ASK}\n`;
    writeReport(report, options.output);
    return { exitCode: 1, answer: null };
  }

  const answer =
    question.shape === "whyReaches" || question.shape === "whyResolves"
      ? askWhy(question, options, () => loadSummaries(options))
      : ANSWERS[question.shape](question.subject, loadSummaries(options));
  const rendered = options.json
    ? `${JSON.stringify(asJson(options.question, answer), null, 2)}\n`
    : renderAnswer(answer, options.all === true);
  writeReport(rendered, options.output);
  return {
    exitCode: answer.found ? 0 : 1,
    answer: asJson(options.question, answer),
  };
}

export function parseQuestion(raw: string): ParsedQuestion | null {
  // Symbols first, since the shorthand ends in a `?` that the written
  // form treats as punctuation and cuts.
  const written = looksLikeShorthand(raw) ? expandShorthand(raw) : null;
  if (looksLikeShorthand(raw) && written === null) {
    return null;
  }
  const asked = (written ?? raw).trim().replace(/\?$/, "").trim();
  for (const { pattern, read } of WHY_SHAPES) {
    const found = pattern.exec(asked);
    if (found !== null) {
      return read(found);
    }
  }
  for (const { shape, pattern } of SHAPES) {
    const found = pattern.exec(asked);
    if (found !== null) {
      return { shape, subject: found[1].trim() };
    }
  }
  return null;
}

function loadSummaries(options: AskOptions): BehavioralSummary[] {
  if (options.dir !== undefined) {
    return readSummariesFromDir(options.dir);
  }
  if (options.file !== undefined) {
    return parseSummaryFile(
      options.file,
      fs.readFileSync(options.file, "utf-8"),
    );
  }
  throw new UsageError(
    "ask needs summaries to read. Try: suss ask 'what reads aws.dynamodb:editions' --dir summaries/",
  );
}

// ---------------------------------------------------------------------------
// The five summary answers
// ---------------------------------------------------------------------------

const ANSWERS: Record<
  Exclude<QuestionShape, WhyShape>,
  (subject: string, summaries: BehavioralSummary[]) => Answer
> = {
  declares: answerDeclares,
  reads: (subject, summaries) => answerDirection("reads", subject, summaries),
  writes: (subject, summaries) => answerDirection("writes", subject, summaries),
  calls: answerCalls,
  reaches: answerReaches,
  reachedBy: answerReachedBy,
};

/**
 * What to call the boundary in the answer. A subject that picked out
 * one boundary is answered in that boundary's own spelling; one that
 * picked out several is answered in the words somebody typed, and each
 * line says which boundary it is about.
 */
function boundaryLabelFor(
  subject: string,
  touches: ReadonlyArray<{ touched: { label: string } }>,
): string {
  const labels = new Set(touches.map((touch) => touch.touched.label));
  return labels.size === 1 ? [...labels][0] : subject;
}

/** "2 units read", "1 unit reads". */
const PLURAL_VERB: Record<"reads" | "writes", string> = {
  reads: "read",
  writes: "write",
};

/** Who the unfollowed call could be hiding, for each question. */
const HIDDEN_ACTOR: Record<"reads" | "writes", string> = {
  reads: "a reader",
  writes: "a writer",
};

/**
 * What to call a unit in a list, given the location prints beside it.
 *
 * A summary identifier is `workspace::file::symbol`, and the file is
 * already in the parentheses that follow, so printing the identifier
 * whole says the path twice. The workspace only tells two units apart
 * when the answer spans more than one, so it comes back only then.
 */
function unitLabel(summary: BehavioralSummary, withWorkspace: boolean): string {
  const parts = summaryIdentifier(summary).split("::");
  const symbol = parts[parts.length - 1] ?? summary.identity.name;
  return withWorkspace && parts.length > 2 ? `${parts[0]}::${symbol}` : symbol;
}

/** Whether one answer covers units from more than one workspace. */
function spansWorkspaces(summaries: ReadonlyArray<BehavioralSummary>): boolean {
  return new Set(summaries.map((s) => s.location.workspace)).size > 1;
}

/** ", which grounds to prod-x via wrangler.toml", or nothing. */
function groundsClause(grounding: GroundingNote[] | undefined): string {
  if (grounding === undefined) {
    return "";
  }
  const spelled = grounding
    .map((note) => `${note.to} via ${note.by}`)
    .join(" and ");
  return `, which grounds to ${spelled}`;
}

function notHere(
  shape: QuestionShape,
  subject: string,
  hints: string[],
): Answer {
  return {
    shape,
    subject,
    headline: `Nothing in these summaries is at ${subject}.`,
    items: [],
    needs:
      hints.length > 0
        ? hints
        : [
            `Extract the code that goes through ${subject}, or read its deploy template in with suss contract, then ask again.`,
          ],
    caveats: [],
    found: false,
  };
}

function answerDeclares(
  subject: string,
  summaries: BehavioralSummary[],
): Answer {
  const { touches, hints } = groundedTouchesAt(subject, summaries);
  if (touches.length === 0) {
    return notHere("declares", subject, hints);
  }

  const label = boundaryLabelFor(subject, touches);
  const providers = touches
    .filter((touch) => touch.touched.relation === "provides")
    .map((touch) => touch.summary);
  const declared = providers.flatMap((provider) =>
    declarationsOf(provider).map((entry) => ({
      text: `${entry.what} ${entry.name}${entry.detail === undefined ? "" : ` (${entry.detail})`}  from ${summaryIdentifier(provider)}`,
      data: { ...entry, from: summaryIdentifier(provider) },
    })),
  );

  if (declared.length > 0) {
    return {
      shape: "declares",
      subject,
      headline: `${label} declares ${declared.length} thing${declared.length === 1 ? "" : "s"} you can ask it for:`,
      items: declared,
      needs: [],
      caveats: gapCaveats(providers),
      found: true,
    };
  }

  return {
    shape: "declares",
    subject,
    headline: `Nothing here declares what ${label} serves.`,
    items: touchedFields(touches),
    needs: [
      providers.length === 0
        ? `No summary here provides ${label}. Read the schema or deploy template that declares it: suss contract --from terraform <path> -o summaries/infra.json`
        : `${summaryIdentifier(providers[0])} provides ${label} and declares nothing about it. Whatever suss read it from does not say what the boundary serves.`,
    ],
    caveats: gapCaveats(touches.map((touch) => touch.summary)),
    found: true,
  };
}

/**
 * What code does at the boundary, rather than what any of it says. A
 * field list gathered from call sites is what somebody happened to ask
 * for, so it is offered as that and never as the declaration.
 */
function touchedFields(touches: ReadonlyArray<TargetTouch>): AnswerItem[] {
  const items: AnswerItem[] = [];
  for (const { summary, touched } of touches) {
    if (touched.relation === "provides") {
      continue;
    }
    items.push({
      text: `code here ${touched.relation} it${touched.callee === undefined ? "" : ` through ${touched.callee}`}, in ${summaryIdentifier(summary)}`,
      data: {
        unit: summaryIdentifier(summary),
        relation: touched.relation,
        ...(touched.callee !== undefined ? { via: touched.callee } : {}),
      },
    });
  }
  return items;
}

function answerDirection(
  shape: "reads" | "writes",
  subject: string,
  summaries: BehavioralSummary[],
): Answer {
  const { touches, hints } = groundedTouchesAt(subject, summaries);
  if (touches.length === 0) {
    return notHere(shape, subject, hints);
  }

  const label = boundaryLabelFor(subject, touches);
  const matching = touches.filter((touch) => touch.touched.relation === shape);
  const named = spansWorkspaces(matching.map((touch) => touch.summary));
  const items = matching.map(({ summary, touched, grounding }) => ({
    text: `${unitLabel(summary, named)} (${summary.location.file}:${summary.location.range.start})${touched.label === label ? "" : `  at ${touched.label}`}${touched.callee === undefined ? "" : ` through ${touched.callee}`}${groundsClause(grounding)}`,
    data: {
      unit: summaryIdentifier(summary),
      file: summary.location.file,
      line: summary.location.range.start,
      ...(touched.callee !== undefined ? { via: touched.callee } : {}),
      ...(grounding !== undefined ? { grounding } : {}),
    },
  }));

  const providers = touches
    .filter((touch) => touch.touched.relation === "provides")
    .map((touch) => summaryIdentifier(touch.summary));
  const servedBy =
    providers.length === 0
      ? []
      : [`${label} is provided by ${providers.join(", ")}.`];

  if (items.length === 0) {
    return {
      shape,
      subject,
      headline: `Nothing in these summaries ${shape} ${label}.`,
      items: [],
      needs: [...servedBy, ...hints],
      caveats: runCaveats(summaries, shape),
      found: true,
    };
  }

  return {
    shape,
    subject,
    headline: `${items.length} unit${items.length === 1 ? "" : "s"} ${items.length === 1 ? shape : PLURAL_VERB[shape]} ${label}:`,
    items,
    needs: servedBy,
    caveats: [
      ...hints,
      ...gapCaveats(matching.map((touch) => touch.summary)),
      ...runCaveats(
        summaries,
        shape,
        matching.map((touch) => touch.summary),
      ),
    ],
    found: true,
  };
}

/**
 * The boundaries a target goes on to touch. A unit does not reach the
 * boundary it serves, it is that boundary, and being told a route
 * serves itself buries what it calls. Asked about a boundary, the
 * question is about the units serving it, so what they touch has to be
 * gathered from them rather than from what the spelling picked out.
 */
function reachedFrom(
  target: ResolvedTarget,
  summaries: BehavioralSummary[],
): ReachedTouch[] {
  const start =
    target.kind === "boundary" ? unitsServing(target) : target.summaries;
  const direct = (
    target.kind === "boundary" ? touchesOfUnits(start) : target.touches
  ).filter((touch) => !servesItself(touch));
  return [...direct, ...throughCalls(start, direct, summaries)];
}

/** A touch, and the calls between it and the unit somebody asked about. */
interface ReachedTouch extends TargetTouch {
  through?: string[];
}

/**
 * What the units a target picked out reach through the calls they
 * make. A route handler calling a service that reads a table does
 * reach that table, and an answer built from the handler's own body
 * says it reaches nothing while a why question proves it does.
 */
function throughCalls(
  start: readonly BehavioralSummary[],
  direct: readonly TargetTouch[],
  summaries: BehavioralSummary[],
): ReachedTouch[] {
  const byId = new Map(
    summaries.map((summary) => [summaryIdentifier(summary), summary]),
  );
  const seen = new Set<BehavioralSummary>(start);
  const already = new Set(direct.map((touch) => touchKey(touch)));
  const found: ReachedTouch[] = [];
  let frontier = start.map((summary) => ({
    at: summary,
    through: [] as string[],
  }));

  while (frontier.length > 0) {
    const next: Array<{ at: BehavioralSummary; through: string[] }> = [];
    for (const { at, through } of frontier) {
      for (const edge of invocationEdges(at, byId)) {
        if (seen.has(edge.to)) {
          continue;
        }
        seen.add(edge.to);
        const path = [...through, edge.callee];
        for (const touch of touchesOfUnits([edge.to])) {
          if (servesItself(touch) || already.has(touchKey(touch))) {
            continue;
          }
          already.add(touchKey(touch));
          found.push({ ...touch, through: path });
        }
        next.push({ at: edge.to, through: path });
      }
    }
    frontier = next;
  }
  return found;
}

function touchKey(touch: TargetTouch): string {
  return `${touch.touched.label} ${touch.touched.relation}`;
}

/**
 * The units serving a boundary, which are the ones whose downstream a
 * question about it is asking after. A client of the boundary reaches
 * it rather than through it, so its calls belong to its own answer.
 */
function unitsServing(target: ResolvedTarget): BehavioralSummary[] {
  return [
    ...new Set(
      target.touches
        .filter((touch) => touch.touched.relation === "provides")
        .map((touch) => touch.summary),
    ),
  ];
}

function servesItself(touch: TargetTouch): boolean {
  return (
    touch.touched.relation === "provides" &&
    touch.touched.binding === touch.summary.identity.boundaryBinding
  );
}

/**
 * Calls these summaries record but never resolved to a unit. Any one of
 * them could have been a step into the chain, so a backward walk that
 * ignores them reports fewer boundaries than really reach the target.
 */
function unresolvedCallCount(summaries: BehavioralSummary[]): number {
  let count = 0;
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type === "invocation" && effect.summary === undefined) {
          count += 1;
        }
      }
    }
  }
  return count;
}

/** Who calls each unit, over the same edges `reaches` walks forward. */
function callersByUnit(
  summaries: BehavioralSummary[],
): Map<BehavioralSummary, Array<{ from: BehavioralSummary; callee: string }>> {
  const byId = new Map(
    summaries.map((summary) => [summaryIdentifier(summary), summary]),
  );
  const callers = new Map<
    BehavioralSummary,
    Array<{ from: BehavioralSummary; callee: string }>
  >();
  for (const summary of summaries) {
    for (const edge of invocationEdges(summary, byId)) {
      const list = callers.get(edge.to) ?? [];
      list.push({ from: edge.from, callee: edge.callee });
      callers.set(edge.to, list);
    }
  }
  return callers;
}

/** The boundary a unit serves, when it serves one. */
function ownBoundaryOf(summary: BehavioralSummary): TargetTouch | null {
  return touchesOfUnits([summary]).find(servesItself) ?? null;
}

/**
 * Every boundary whose unit ends up calling into the target, and the
 * calls it took to get there.
 *
 * The mirror of `reaches`, walked backwards. Somebody changing a unit
 * wants the boundaries that behave differently afterwards rather than
 * the list of functions in between, so the walk reports a unit only
 * when it serves a boundary of its own.
 */
function answerReachedBy(
  subject: string,
  summaries: BehavioralSummary[],
): Answer {
  const resolution = resolveTarget(subject, summaries);
  if (!resolution.matched) {
    return {
      shape: "reachedBy",
      subject,
      headline: resolution.message,
      items: [],
      needs: [],
      caveats: [],
      found: false,
    };
  }

  const target = resolution.target;
  // A store is touched rather than served, so the walk starts from
  // every unit that goes through the target, not only one serving it.
  // A unit that provides the target is the target, not something
  // reaching it, so the walk starts from the units that go through it.
  const provides = new Set(unitsServing(target));
  const start = [
    ...new Set(target.touches.map((touch) => touch.summary)),
  ].filter((summary) => !provides.has(summary));
  const callers = callersByUnit(summaries);
  const unresolved = unresolvedCallCount(summaries);
  const walkCaveats =
    unresolved === 0
      ? []
      : [
          `warning: ${unresolved} call${unresolved === 1 ? "" : "s"} here resolved to no unit, so a boundary reaching ${subject} through one of them is missing from this answer.`,
        ];
  const seen = new Set<BehavioralSummary>(start);
  const items: AnswerItem[] = [];
  const said = new Set<string>();
  // A unit that goes through the target in its own body reaches it in
  // no hops, and is the answer somebody most expects to see.
  for (const at of start) {
    const own = ownBoundaryOf(at);
    if (own !== null && !said.has(own.touched.label)) {
      said.add(own.touched.label);
      items.push({
        text: own.touched.label,
        data: {
          boundary: own.touched.label,
          unit: summaryIdentifier(at),
          through: [],
        },
      });
    }
  }

  let frontier = start.map((at) => ({ at, through: [] as string[] }));

  while (frontier.length > 0) {
    const next: Array<{ at: BehavioralSummary; through: string[] }> = [];
    for (const { at, through } of frontier) {
      for (const caller of callers.get(at) ?? []) {
        if (seen.has(caller.from)) {
          continue;
        }
        seen.add(caller.from);
        const path = [caller.callee, ...through];
        const own = ownBoundaryOf(caller.from);
        if (own !== null) {
          const hops =
            path.length === 0 ? "" : `, by calling ${path.join(", then ")}`;
          const text = `${own.touched.label}${hops}`;
          if (!said.has(text)) {
            said.add(text);
            items.push({
              text,
              data: {
                boundary: own.touched.label,
                unit: summaryIdentifier(caller.from),
                through: path,
              },
            });
          }
        }
        next.push({ at: caller.from, through: path });
      }
    }
    frontier = next;
  }

  if (items.length === 0) {
    return {
      shape: "reachedBy",
      subject,
      headline: `Nothing in these summaries reaches ${subject}.`,
      items: [],
      needs: [
        "A caller outside these summaries would not be here. Extract the code that calls it into the same folder, then ask again.",
      ],
      caveats: gapCaveats(target.summaries),
      found: true,
    };
  }

  return {
    shape: "reachedBy",
    subject,
    headline: `${items.length} boundar${items.length === 1 ? "y" : "ies"} reach ${subject}:`,
    items,
    needs: [],
    caveats: [...walkCaveats, ...gapCaveats(target.summaries)],
    found: true,
  };
}

function answerReaches(
  subject: string,
  summaries: BehavioralSummary[],
): Answer {
  const resolution = resolveTarget(subject, summaries);
  if (!resolution.matched) {
    return {
      shape: "reaches",
      subject,
      headline: resolution.message,
      items: [],
      needs: [],
      caveats: [],
      found: false,
    };
  }

  const target = resolution.target;
  const seen = new Set<string>();
  const items: AnswerItem[] = [];
  for (const touch of collapseTouches(reachedFrom(target, summaries))) {
    const data = {
      boundary: touch.boundary,
      relations: touch.relations,
      unit: touch.unit,
      ...(touch.callee !== undefined ? { via: touch.callee } : {}),
      ...(touch.through !== undefined ? { through: touch.through } : {}),
    };
    const hops =
      touch.through === undefined || touch.through.length === 0
        ? ""
        : `, by calling ${touch.through.join(", then ")}`;
    const text = `${touch.relations.join(" and ")} ${touch.boundary}${touch.callee === undefined ? "" : `  through ${touch.callee}`}${hops}`;
    if (!seen.has(text)) {
      seen.add(text);
      items.push({ text, data });
    }
  }

  if (items.length === 0) {
    const noProvider =
      target.kind === "boundary" && unitsServing(target).length === 0;
    return {
      shape: "reaches",
      subject,
      headline: noProvider
        ? `Nothing in these summaries serves ${subject}, so there is nothing here that goes on from it.`
        : `${subject} crosses no boundary this run knows how to read.`,
      items: [],
      needs: [
        noProvider
          ? `Extract the code serving ${subject} into the same folder, then ask again.`
          : "A pack that reads the library this code calls would say more. suss extract -f <pack> lists what is built in.",
      ],
      caveats: gapCaveats(target.summaries),
      found: true,
    };
  }

  return {
    shape: "reaches",
    subject,
    headline: `${subject}, ${target.summaries.length} summar${target.summaries.length === 1 ? "y" : "ies"}, reaches ${items.length} boundar${items.length === 1 ? "y" : "ies"}:`,
    items,
    needs: [],
    caveats: gapCaveats(target.summaries),
    found: true,
  };
}

// ---------------------------------------------------------------------------
// Declarations, and what is missing
// ---------------------------------------------------------------------------

interface Declaration {
  what: string;
  name: string;
  detail?: string;
}

/**
 * What a provider says its boundary serves. Each reader returns nothing
 * for a summary with no declaration of its kind, so a boundary whose
 * provider declares two kinds at once reports both.
 */
const DECLARATION_READERS: ReadonlyArray<
  (summary: BehavioralSummary) => Declaration[]
> = [
  (summary) =>
    (readStorageContractMetadata(summary)?.fields ?? []).map((field) => ({
      what: "field",
      name: field.name,
      ...(field.type !== undefined ? { detail: field.type } : {}),
    })),
  (summary) => {
    const contract = readHttpMetadata(summary)?.declaredContract;
    return [
      ...(contract?.responses ?? []).map((response) => ({
        what: "response",
        name: String(response.statusCode),
      })),
      ...(contract?.responseRanges ?? []).map((range) => ({
        what: "response",
        name: range.spec,
      })),
      ...(contract?.defaultResponse !== undefined
        ? [{ what: "response", name: "default" }]
        : []),
    ];
  },
  (summary) =>
    (readRuntimeContractMetadata(summary)?.envVars ?? []).map((name) => ({
      what: "env var",
      name,
    })),
  respondsWith,
];

/**
 * The responses a handler produces, for a boundary suss read from code
 * rather than from a document.
 *
 * The readers above ask what a contract declares, which answers only
 * for a boundary somebody wrote a spec for. A route extracted from
 * source declares the same thing by returning it, and a caller wanting
 * to know what it can expect back should not have to care which of the
 * two the answer came from.
 *
 * A status the run could not settle is reported as the expression that
 * decides it. A reader who knows the code can finish the thought, and a
 * reader who does not at least learns there is another branch.
 */
function respondsWith(summary: BehavioralSummary): Declaration[] {
  const seen = new Map<string, Declaration>();
  for (const transition of summary.transitions) {
    const output = transition.output;
    if (output.type !== "response") {
      continue;
    }
    const name = statusName(output.statusCode);
    if (name === null || seen.has(name)) {
      continue;
    }
    const fields = bodyFields(output.body);
    seen.set(name, {
      what: "response",
      name,
      ...(fields === undefined ? {} : { detail: fields }),
    });
  }
  return [...seen.values()];
}

/** How to write a status, or null when there is nothing to write. */
function statusName(status: ValueRef | null): string | null {
  if (status === null) {
    return null;
  }
  if (status.type === "literal") {
    return String(status.value);
  }
  return status.type === "unresolved"
    ? `decided by ${status.sourceText}`
    : null;
}

/** The top-level fields of a response body, on one line. */
function bodyFields(body: TypeShape | null): string | undefined {
  if (body === null || body.type !== "record") {
    return undefined;
  }
  const fields = Object.keys(body.properties ?? {});
  return fields.length === 0 ? undefined : fields.join(", ");
}

function declarationsOf(summary: BehavioralSummary): Declaration[] {
  return DECLARATION_READERS.flatMap((read) => read(summary));
}

/**
 * A unit suss could not read all of could go through the boundary
 * without this run seeing it, which is worth saying whenever the answer
 * is a list of who does. Units the answer already named are left out,
 * since their gaps are printed one by one above this.
 */
function runCaveats(
  summaries: ReadonlyArray<BehavioralSummary>,
  shape: "reads" | "writes",
  listed: ReadonlyArray<BehavioralSummary> = [],
): string[] {
  const already = new Set(listed);
  const withGaps = summaries.filter(
    (summary) => summary.gaps.length > 0 && !already.has(summary),
  );
  if (withGaps.length === 0) {
    return [];
  }
  return [hiddenBehindLine(unfollowedCalls(withGaps), HIDDEN_ACTOR[shape])];
}

/** The distinct calls the run stopped at across these units. */
export function unfollowedCalls(summaries: ReadonlyArray<BehavioralSummary>): {
  count: number;
  callees: string[];
} {
  const callees = new Set<string>();
  let nameless = 0;
  for (const summary of summaries) {
    for (const gap of summary.gaps) {
      if (gap.type !== "unfollowedCall") {
        continue;
      }

      if (gap.callee !== undefined) {
        callees.add(gap.callee);
      } else {
        nameless += 1;
      }
    }
  }
  return {
    count: Math.max(callees.size + nameless, 1),
    callees: [...callees].sort(),
  };
}

/**
 * The one warning under an answer whose gaps sit in units the answer
 * did not list. A few stopped calls are worth spelling out, so a
 * reader can judge whether any could reach what they asked about; past
 * that the list stops working as a warning and the count has to do.
 */
export function hiddenBehindLine(
  stops: { count: number; callees: string[] },
  actor: string,
): string {
  if (stops.count === 1) {
    const called = stops.callees.length === 1 ? ` to ${stops.callees[0]}` : "";
    return `warning: ${actor} could be hidden behind an unfollowed call${called} elsewhere in this run.`;
  }
  const listed =
    stops.count <= 3 && stops.callees.length === stops.count
      ? ` (${stops.callees.join(", ")})`
      : "";
  return `warning: ${actor} could be hidden behind one of ${stops.count} unfollowed calls${listed} elsewhere in this run. Run with --json to see them.`;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * An answer as the shape `--json` writes and a caller in the same
 * process reads. A why question adds its chain under `detail`, so the
 * type stays open past the fields every shape has.
 */
export interface AnswerJson {
  question: string;
  shape: QuestionShape;
  subject: string;
  found: boolean;
  headline: string;
  items: unknown[];
  needs: string[];
  caveats: string[];
  [extra: string]: unknown;
}

function asJson(question: string, answer: Answer): AnswerJson {
  return {
    question,
    shape: answer.shape,
    subject: answer.subject,
    found: answer.found,
    headline: answer.headline,
    items: answer.items.map((item) => item.data),
    needs: answer.needs,
    caveats: answer.caveats,
    ...(answer.detail ?? {}),
  };
}

/**
 * How many items an answer prints before it stops and says the count.
 *
 * A question over a repository can pick out hundreds of units, and a
 * screen of them buries the two lines under the list that say what was
 * provided and what suss could not follow.
 */
const ITEMS_SHOWN = 10;

function renderAnswer(answer: Answer, all: boolean): string {
  const shown = all ? answer.items : answer.items.slice(0, ITEMS_SHOWN);
  const hidden = answer.items.length - shown.length;
  const lines = [answer.headline];
  for (const item of shown) {
    lines.push(`  ${item.text}`);
  }
  if (hidden > 0) {
    lines.push(
      `  ... and ${hidden} more. Run the same command with --all to see them.`,
    );
  }
  for (const need of answer.needs) {
    lines.push("", need);
  }
  if (answer.caveats.length > 0) {
    lines.push("", ...answer.caveats);
  }
  return `${lines.join("\n")}\n`;
}
