/**
 * `suss ask`: one question about one boundary, answered from the
 * summaries already on disk.
 *
 * Four shapes, and no parser behind them. A question that is not one of
 * the four gets the four printed back rather than a guess at what it
 * meant, because a wrong answer to a question about a store is worse
 * than no answer.
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

import { boundariesTouchedBy, namesBoundary } from "./boundaryReach.js";
import { writeReport } from "./check.js";
import { parseSummaryFile, readSummariesFromDir } from "./inspect.js";
import { collapseTouches, resolveTarget, type TargetTouch } from "./target.js";
import { UsageError } from "./usageError.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export type QuestionShape = "declares" | "reads" | "writes" | "reaches";

export interface AskOptions {
  question: string;
  dir?: string;
  file?: string;
  json?: boolean;
  output?: string;
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
}

/** The four questions, and how each one is written. */
const SHAPES: ReadonlyArray<{ shape: QuestionShape; pattern: RegExp }> = [
  { shape: "declares", pattern: /^what can i project from\s+(.+)$/i },
  { shape: "declares", pattern: /^what does\s+(.+?)\s+declare$/i },
  { shape: "reads", pattern: /^what reads\s+(.+)$/i },
  { shape: "writes", pattern: /^what writes\s+(.+)$/i },
  { shape: "reaches", pattern: /^what does\s+(.+?)\s+reach$/i },
];

const HOW_TO_ASK = `suss ask takes one of four questions:
  suss ask 'what can I project from aws.dynamodb:editions#by-publication'
  suss ask 'what reads aws.dynamodb:editions'
  suss ask 'what writes aws.dynamodb:editions'
  suss ask 'what does src/editions/dao.ts reach'
Add --dir to say which summaries to read, or pass one summaries file.`;

export function ask(options: AskOptions): number {
  const question = parseQuestion(options.question);
  if (question === null) {
    writeReport(`${HOW_TO_ASK}\n`, options.output);
    return 1;
  }

  const summaries = loadSummaries(options);
  const answer = ANSWERS[question.shape](question.subject, summaries);
  const rendered = options.json
    ? `${JSON.stringify(asJson(options.question, answer), null, 2)}\n`
    : renderAnswer(answer);
  writeReport(rendered, options.output);
  return answer.found ? 0 : 1;
}

export function parseQuestion(
  raw: string,
): { shape: QuestionShape; subject: string } | null {
  const asked = raw.trim().replace(/\?$/, "").trim();
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
// The four answers
// ---------------------------------------------------------------------------

const ANSWERS: Record<
  QuestionShape,
  (subject: string, summaries: BehavioralSummary[]) => Answer
> = {
  declares: answerDeclares,
  reads: (subject, summaries) => answerDirection("reads", subject, summaries),
  writes: (subject, summaries) => answerDirection("writes", subject, summaries),
  reaches: answerReaches,
};

/** Every unit that does something at the boundary somebody asked about. */
function touchesAt(
  subject: string,
  summaries: ReadonlyArray<BehavioralSummary>,
): TargetTouch[] {
  return summaries.flatMap((summary) =>
    boundariesTouchedBy(summary)
      .filter((touched) => namesBoundary(subject, touched.binding))
      .map((touched) => ({ summary, touched })),
  );
}

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

function notHere(shape: QuestionShape, subject: string): Answer {
  return {
    shape,
    subject,
    headline: `Nothing in these summaries is at ${subject}.`,
    items: [],
    needs: [
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
  const touches = touchesAt(subject, summaries);
  if (touches.length === 0) {
    return notHere("declares", subject);
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
  const touches = touchesAt(subject, summaries);
  if (touches.length === 0) {
    return notHere(shape, subject);
  }

  const label = boundaryLabelFor(subject, touches);
  const matching = touches.filter((touch) => touch.touched.relation === shape);
  const items = matching.map(({ summary, touched }) => ({
    text: `${summaryIdentifier(summary)} (${summary.location.file}:${summary.location.range.start})${touched.label === label ? "" : `  at ${touched.label}`}${touched.callee === undefined ? "" : ` through ${touched.callee}`}`,
    data: {
      unit: summaryIdentifier(summary),
      file: summary.location.file,
      line: summary.location.range.start,
      ...(touched.callee !== undefined ? { via: touched.callee } : {}),
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
      needs: servedBy,
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
      ...gapCaveats(matching.map((touch) => touch.summary)),
      ...runCaveats(
        summaries,
        matching.map((touch) => touch.summary),
      ),
    ],
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
  for (const touch of collapseTouches(target.touches)) {
    const data = {
      boundary: touch.boundary,
      relations: touch.relations,
      unit: touch.unit,
      ...(touch.callee !== undefined ? { via: touch.callee } : {}),
    };
    const text = `${touch.relations.join(" and ")} ${touch.boundary}${touch.callee === undefined ? "" : `  through ${touch.callee}`}`;
    if (!seen.has(text)) {
      seen.add(text);
      items.push({ text, data });
    }
  }

  if (items.length === 0) {
    return {
      shape: "reaches",
      subject,
      headline: `${subject} crosses no boundary this run knows how to read.`,
      items: [],
      needs: [
        "A pack that reads the library this code calls would say more. suss extract -f <pack> lists what is built in.",
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
  (summary) =>
    (readHttpMetadata(summary)?.declaredContract?.responses ?? []).map(
      (response) => ({ what: "response", name: String(response.statusCode) }),
    ),
  (summary) =>
    (readRuntimeContractMetadata(summary)?.envVars ?? []).map((name) => ({
      what: "env var",
      name,
    })),
];

function declarationsOf(summary: BehavioralSummary): Declaration[] {
  return DECLARATION_READERS.flatMap((read) => read(summary));
}

function gapCaveats(summaries: ReadonlyArray<BehavioralSummary>): string[] {
  const withGaps = [...new Set(summaries)].filter(
    (summary) => summary.gaps.length > 0,
  );
  if (withGaps.length === 0) {
    return [];
  }
  return withGaps.map(
    (summary) =>
      `${summaryIdentifier(summary)} records ${summary.gaps.length} thing${summary.gaps.length === 1 ? "" : "s"} suss could not read: ${summary.gaps.map((gap) => gap.description).join("; ")}`,
  );
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
    `${withGaps.length} of ${summaries.length} summar${summaries.length === 1 ? "y" : "ies"} in this run record${withGaps.length === 1 ? "s" : ""} something suss could not read, so a unit could be missing from this answer.`,
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
