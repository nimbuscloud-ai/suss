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

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { GroundingNote } from "./askGrounding.js";
import type { WhyShape } from "./askWhy.js";

export type QuestionShape =
  | "declares"
  | "reads"
  | "writes"
  | "calls"
  | "reaches"
  | WhyShape;

export interface AskOptions {
  question: string;
  dir?: string;
  file?: string;
  json?: boolean;
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
];

const HOW_TO_ASK = `suss ask takes one of seven questions:
  suss ask 'what can I project from aws.dynamodb:editions#by-publication'
  suss ask 'what reads aws.dynamodb:editions'
  suss ask 'what writes aws.dynamodb:editions'
  suss ask 'what calls src/editions/dao.ts'
  suss ask 'what does src/editions/dao.ts reach'
  suss ask 'why does src/editions/dao.ts reach aws.dynamodb:editions'
  suss ask 'why does handler at src/app.ts:12 resolve to createHandler'
The same five, in symbols: '<- <unit>', '<unit> ->',
'<unit> -> <boundary> ?', 'r<- <boundary>', 'w<- <boundary>'.
Add --dir to say which summaries to read, or pass one summaries file.
A why question reads the source too; --project says where it is when it
is not the working directory.`;

export function ask(options: AskOptions): number {
  const question = parseQuestion(options.question);
  if (question === null) {
    writeReport(`${HOW_TO_ASK}\n`, options.output);
    return 1;
  }

  const answer =
    question.shape === "whyReaches" || question.shape === "whyResolves"
      ? askWhy(question, options, () => loadSummaries(options))
      : ANSWERS[question.shape](question.subject, loadSummaries(options));
  const rendered = options.json
    ? `${JSON.stringify(asJson(options.question, answer), null, 2)}\n`
    : renderAnswer(answer);
  writeReport(rendered, options.output);
  return answer.found ? 0 : 1;
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
  const items = matching.map(({ summary, touched, grounding }) => ({
    text: `${summaryIdentifier(summary)} (${summary.location.file}:${summary.location.range.start})${touched.label === label ? "" : `  at ${touched.label}`}${touched.callee === undefined ? "" : ` through ${touched.callee}`}${groundsClause(grounding)}`,
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
      caveats: runCaveats(summaries),
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
];

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
  listed: ReadonlyArray<BehavioralSummary> = [],
): string[] {
  const already = new Set(listed);
  const withGaps = summaries.filter(
    (summary) => summary.gaps.length > 0 && !already.has(summary),
  );
  if (withGaps.length === 0) {
    return [];
  }
  return [
    `suss met a call it could not follow in ${withGaps.length === 1 ? "one unit" : `${withGaps.length} units`}, of ${summaries.length}, so a reader could be hiding in ${withGaps.length === 1 ? "it" : "one of them"}.`,
  ];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function asJson(question: string, answer: Answer): unknown {
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

function renderAnswer(answer: Answer): string {
  const lines = [answer.headline];
  for (const item of answer.items) {
    lines.push(`  ${item.text}`);
  }
  for (const need of answer.needs) {
    lines.push("", need);
  }
  for (const caveat of answer.caveats) {
    lines.push("", caveat);
  }
  return `${lines.join("\n")}\n`;
}
