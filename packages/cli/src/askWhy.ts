/**
 * The two why questions: why a unit reaches a boundary, and why a
 * value resolves to what it does.
 *
 * A why answer reads two layers. The summaries on disk say which unit
 * calls which and where the boundary is touched. The witness proof
 * over the resolution rules says why each callee comes down to the
 * function it does, computed when the question is asked rather than
 * during a run: the question re-reads the relevant source files and
 * re-evaluates the resolution rules under the witness algebra. The
 * source has to be a TypeScript or JavaScript project; without it the
 * reach answer still prints the unit chain, and says what is missing.
 * A hop written in Python or Ruby prints without a proof.
 */

import fs from "node:fs";
import path from "node:path";

import { WhySession } from "@suss/adapter-typescript";
import { summaryIdentifier } from "@suss/behavioral-ir";

import { gapCaveats } from "./askCaveats.js";
import { groundedTouchesAt } from "./askGrounding.js";
import { boundariesTouchedBy } from "./boundaryReach.js";
import {
  functionsSpelled,
  reachTargetOfTouches,
  representativeUnit,
} from "./callFacts.js";
import { languageOfFile } from "./language.js";
import { providesKeyOf, resolveTarget } from "./target.js";

import type { ValueLocation, WhyExplained } from "@suss/adapter-typescript";
import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";
import type { Answer, AnswerItem, AskOptions, ParsedQuestion } from "./ask.js";
import type { TouchedBoundary } from "./boundaryReach.js";
import type {
  CallFacts,
  CallPath,
  CallRecord,
  FunctionKey,
  ReachTarget,
  SpelledFunctions,
} from "./callFacts.js";
import type { LoadedSummaries } from "./loadedSummaries.js";
import type { TargetTouch } from "./target.js";

export type WhyShape = "whyReaches" | "whyResolves";

/**
 * How the why questions are written. The resolve spelling is tried
 * first: its subject contains " at ", which the reach pattern would
 * otherwise cut at a " reach " inside the target's words.
 */
export const WHY_SHAPES: ReadonlyArray<{
  pattern: RegExp;
  read: (found: RegExpExecArray) => ParsedQuestion;
}> = [
  {
    pattern: /^why does\s+(.+?)\s+at\s+(.+?):(\d+)\s+resolve to\s+(.+)$/i,
    read: (found) => ({
      shape: "whyResolves",
      subject: found[1].trim(),
      at: { file: found[2].trim(), line: Number(found[3]) },
      object: found[4].trim(),
    }),
  },
  {
    pattern: /^why does\s+(.+?)\s+reach\s+(.+)$/i,
    read: (found) => ({
      shape: "whyReaches",
      subject: found[1].trim(),
      object: found[2].trim(),
    }),
  },
];

export function askWhy(
  question: ParsedQuestion,
  options: AskOptions,
  loadSummaries: () => LoadedSummaries,
): Answer {
  if (question.shape === "whyResolves") {
    return answerWhyResolves(question, options);
  }
  return answerWhyReaches(question, options, loadSummaries());
}

function miss(
  shape: WhyShape,
  subject: string,
  headline: string,
  needs: string[] = [],
): Answer {
  return {
    shape,
    subject,
    headline,
    items: [],
    needs,
    caveats: [],
    found: false,
  };
}

// ---------------------------------------------------------------------------
// Why a value resolves to what it does
// ---------------------------------------------------------------------------

function answerWhyResolves(
  question: ParsedQuestion,
  options: AskOptions,
): Answer {
  const at = question.at as { file: string; line: number };
  const asked = `${question.subject} at ${at.file}:${at.line}`;
  const root = path.resolve(options.project ?? process.cwd());

  if (!fs.existsSync(path.resolve(root, at.file))) {
    return miss("whyResolves", asked, `There is no ${at.file} under ${root}.`, [
      "--project says where the source is when it is not the working directory.",
    ]);
  }

  const session = new WhySession({ dir: root });
  const value = session.findExpression(at.file, at.line, question.subject);
  if (value === null) {
    return miss(
      "whyResolves",
      asked,
      `Nothing written as ${question.subject} is on line ${at.line} of ${at.file}.`,
    );
  }

  const explained = session.explain(value);
  if (explained === null) {
    return miss(
      "whyResolves",
      asked,
      `suss cannot follow ${asked} down to one function.`,
      [
        "The chain either leaves the source suss can read, or more than one value can end it.",
      ],
    );
  }

  const resolvedTo = `${explained.target.name} (${explained.target.file}:${explained.target.line})`;
  const matched = spellsValue(question.object ?? "", explained.target);
  return {
    shape: "whyResolves",
    subject: asked,
    headline: matched
      ? `${asked} resolves to ${resolvedTo}:`
      : `${asked} resolves to ${resolvedTo}, not ${question.object}.`,
    items: explanationItems(explained),
    needs: [],
    caveats: [],
    found: matched,
    detail: { resolution: resolutionJson(explained) },
  };
}

/** Whether the asked-for target is the resolved one, however spelled. */
function spellsValue(spec: string, target: ValueLocation): boolean {
  return (
    spec === target.name ||
    spec === target.file ||
    spec === `${target.file}:${target.line}`
  );
}

/**
 * The rendered chain as answer items: the arrow line, one reason per
 * hop with notes under it, the assumptions, and the depth cap when it
 * cut the walk short. Item text is what a person reads; item data is
 * the same fact for the JSON form.
 */
function explanationItems(explained: WhyExplained): AnswerItem[] {
  const { explanation, chain } = explained;
  const items: AnswerItem[] = [];
  if (explanation.steps.length === 0) {
    items.push({
      text: "it is written there itself; the chain has no hops",
      data: { chain },
    });
    return items;
  }

  items.push({ text: chain.join(" -> "), data: { chain } });
  for (const step of explanation.steps) {
    items.push({
      text: step.reason,
      data: { rule: step.rule, reason: step.reason },
    });
    for (const note of step.notes) {
      items.push({ text: `  ${note}`, data: { note } });
    }
  }
  for (const assumption of explanation.assumptions) {
    items.push({ text: `assuming ${assumption}`, data: { assumption } });
  }
  if (explanation.truncated) {
    items.push({
      text: "the chain goes on past the proof depth cap",
      data: { truncated: true },
    });
  }
  return items;
}

function resolutionJson(explained: WhyExplained): Record<string, unknown> {
  return {
    target: explained.target,
    chain: explained.chain,
    steps: explained.explanation.steps.map((step) => ({
      rule: step.rule,
      reason: step.reason,
      notes: step.notes,
      assumptions: step.assumptions,
    })),
    truncated: explained.explanation.truncated,
    cost: explained.stats,
  };
}

// ---------------------------------------------------------------------------
// Why a unit reaches a boundary
// ---------------------------------------------------------------------------

/** Where a why question ends, and which bindings count as touching it. */
interface WhyTarget {
  target: ReachTarget;
  label: string;
  /** The bindings at the boundary. Empty when the target is a function. */
  bindings: ReadonlySet<BoundaryBinding>;
}

type WhyTargetSpelled =
  | ({ found: true } & WhyTarget)
  | { found: false; headline: string; needs: string[] };

/** One call on the chain, with the summaries on both sides of it. */
interface WhyHop {
  from: BehavioralSummary;
  callee: string;
  /** Null when the call is to an export nothing here provides. */
  to: BehavioralSummary | null;
  recorded: CallRecord;
}

function answerWhyReaches(
  question: ParsedQuestion,
  options: AskOptions,
  { summaries, callFacts: facts }: LoadedSummaries,
): Answer {
  const subject = functionsSpelled(question.subject, summaries, facts);
  if (!subject.found) {
    return miss("whyReaches", question.subject, subject.headline);
  }

  const target = whyTargetSpelled(question.object ?? "", summaries, facts);
  if (!target.found) {
    return miss("whyReaches", question.subject, target.headline, target.needs);
  }

  const reaching = facts.reaching(target.target);
  if (reaching.size === 0) {
    return miss(
      "whyReaches",
      question.subject,
      `Nothing in these summaries goes through ${target.label}.`,
      [`Extract the code that goes through ${target.label}, then ask again.`],
    );
  }

  const found = shortestFrom(subject.target.functions, reaching);
  if (found === null) {
    const nearest = nearestTo(reaching, facts);
    return miss(
      "whyReaches",
      question.subject,
      `Nothing in these summaries says ${question.subject} reaches ${target.label}.`,
      [
        `${target.label} is where ${nearest.text} go${nearest.one ? "es" : ""}, and no call chain here connects ${question.subject} to ${nearest.one ? "it" : "any of them"}.`,
      ],
    );
  }

  const start = representativeUnit(facts, found.start);
  return reachAnswer(
    question.subject,
    start,
    hopsOf(start, found.path, facts),
    target,
    options,
  );
}

/**
 * Read the end of a why question. A function is spelled the way `what
 * calls` takes one, so a bare name that means two functions is refused
 * with both listed. Anything else is a boundary, spelled the way `what
 * reads` takes one, deployed names included.
 */
function whyTargetSpelled(
  spec: string,
  summaries: BehavioralSummary[],
  facts: CallFacts,
): WhyTargetSpelled {
  const resolution = resolveTarget(spec, summaries);
  const spelledAsUnit =
    resolution.matched && resolution.target.kind !== "boundary";
  if (spelledAsUnit) {
    return functionTarget(functionsSpelled(spec, summaries, facts));
  }

  const grounded = groundedTouchesAt(spec, summaries);
  if (grounded.touches.length > 0) {
    return {
      found: true,
      target: reachTargetOfTouches(grounded.touches),
      label: boundaryLabelFor(spec, grounded.touches),
      bindings: new Set(grounded.touches.map((touch) => touch.touched.binding)),
    };
  }

  // A name resolveTarget does not read, such as a method spelled
  // without its class, is still a function to the call facts.
  const spelled = functionsSpelled(spec, summaries, facts);
  if (spelled.found) {
    return functionTarget(spelled);
  }
  return {
    found: false,
    headline: `Nothing in these summaries goes through ${spec}.`,
    needs: [
      ...grounded.hints,
      `Extract the code that goes through ${spec}, then ask again.`,
    ],
  };
}

function functionTarget(spelled: SpelledFunctions): WhyTargetSpelled {
  if (!spelled.found) {
    return { found: false, headline: spelled.headline, needs: [] };
  }
  return {
    found: true,
    target: spelled.target,
    label: spelled.label,
    bindings: new Set(),
  };
}

/** The label the touches share, or the spelling when they disagree. */
function boundaryLabelFor(
  spec: string,
  touches: ReadonlyArray<TargetTouch>,
): string {
  const labels = new Set(touches.map((touch) => touch.touched.label));
  return labels.size === 1 ? [...labels][0] : spec;
}

/** The subject's function with the shortest path to the target, if any reaches it. */
function shortestFrom(
  starts: ReadonlyArray<FunctionKey>,
  reaching: ReadonlyMap<FunctionKey, CallPath>,
): { start: FunctionKey; path: CallPath } | null {
  let best: { start: FunctionKey; path: CallPath } | null = null;
  for (const start of starts) {
    const path = reaching.get(start);
    if (path === undefined) {
      continue;
    }
    if (best === null || path.length < best.path.length) {
      best = { start, path };
    }
  }
  return best;
}

const NEAREST_SHOWN = 5;

/**
 * The functions that touch the target or call it directly, as a phrase.
 * Several summaries can share a name, and a busy export has dozens of
 * direct callers, so the phrase is deduplicated and capped.
 */
function nearestTo(
  reaching: ReadonlyMap<FunctionKey, CallPath>,
  facts: CallFacts,
): { text: string; one: boolean } {
  const names = [
    ...new Set(
      [...reaching]
        .filter(([, path]) => path.length <= 1)
        .map(([fn]) => representativeUnit(facts, fn).identity.name),
    ),
  ];
  const shown = names.slice(0, NEAREST_SHOWN);
  const rest = names.length - shown.length;
  return {
    text: rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", "),
    one: names.length === 1,
  };
}

/** The path's hops with the summary on each side, starting from the subject. */
function hopsOf(
  start: BehavioralSummary,
  path: CallPath,
  facts: CallFacts,
): WhyHop[] {
  const hops: WhyHop[] = [];
  let from: BehavioralSummary | null = start;
  for (const hop of path) {
    if (from === null) {
      break;
    }
    const to = hop.to === null ? null : representativeUnit(facts, hop.to);
    hops.push({ from, callee: hop.callee, to, recorded: hop.recorded });
    from = to;
  }
  return hops;
}

/** Where a summary is, the way an answer prints it. */
function unitAt(summary: BehavioralSummary): string {
  return `${summary.location.file}:${summary.location.range.start}`;
}

/** Where a summary is, with the boundary it provides appended when it has one. */
function locationClause(summary: BehavioralSummary): string {
  const provides = providesKeyOf(summary);
  return `${unitAt(summary)}${provides === undefined ? "" : `, provides ${provides}`}`;
}

function reachAnswer(
  subject: string,
  start: BehavioralSummary,
  hops: WhyHop[],
  target: WhyTarget,
  options: AskOptions,
): Answer {
  const root = path.resolve(options.project ?? process.cwd());
  const startName = start.identity.name;
  const last = hops.length === 0 ? start : hops[hops.length - 1].to;
  const ending = last === null ? null : touchAtTarget(last, target);

  const chain = [
    startName,
    ...hops.map((hop) => hop.callee),
    ...(ending?.callee !== undefined ? [ending.callee] : []),
  ];

  const items: AnswerItem[] = [{ text: chain.join(" -> "), data: { chain } }];
  const caveats: string[] = [];
  const session = openSession(root);
  const hopsJson: Array<Record<string, unknown>> = [];
  let missingProofs = false;

  for (const hop of hops) {
    items.push({ text: hopLine(hop), data: hopJson(hop) });
    const explained = provable(hop) ? explainHop(session, hop) : null;
    if (provable(hop) && explained === null) {
      missingProofs = true;
    }
    for (const item of explained === null ? [] : explanationItems(explained)) {
      items.push({ text: `  ${item.text}`, data: item.data });
    }
    hopsJson.push({
      ...hopJson(hop),
      ...(explained === null ? {} : { resolution: resolutionJson(explained) }),
    });
  }

  if (last !== null && ending !== null) {
    const through =
      ending.callee === undefined ? "" : ` through ${ending.callee}`;
    const where =
      hops.length === 0
        ? `, in its own body (${locationClause(last)})`
        : ` (${locationClause(last)})`;
    const provides = providesKeyOf(last);
    items.push({
      text: `${last.identity.name} ${ending.relation} ${ending.label}${through}${where}`,
      data: {
        unit: summaryIdentifier(last),
        relation: ending.relation,
        boundary: ending.label,
        ...(ending.callee !== undefined ? { via: ending.callee } : {}),
        ...(provides !== undefined ? { provides } : {}),
      },
    });
  }

  if (missingProofs) {
    caveats.push(
      `The source under ${root} does not line up with these summaries, so some hops show without their resolution steps. --project says where the source is.`,
    );
  }
  const along = [start, ...hops.map((hop) => hop.to)].filter(
    (unit): unit is BehavioralSummary => unit !== null,
  );
  caveats.push(...gapCaveats(along));

  return {
    shape: "whyReaches",
    subject,
    headline: `${startName} reaches ${target.label}:`,
    items,
    needs: [],
    caveats,
    found: true,
    detail: {
      boundary: target.label,
      chain,
      hops: hopsJson,
    },
  };
}

/**
 * What the last function on the chain does at the target: its touch on
 * the boundary asked about, or the export it provides when the target
 * is a function. A function with no boundary of its own has nothing to
 * add past the hop that reached it.
 */
function touchAtTarget(
  unit: BehavioralSummary,
  target: WhyTarget,
): TouchedBoundary | null {
  const touches = boundariesTouchedBy(unit);
  if (target.bindings.size > 0) {
    return touches.find((touch) => target.bindings.has(touch.binding)) ?? null;
  }
  return touches.find((touch) => touch.relation === "provides") ?? null;
}

const HOP_LINE: Record<CallRecord, (hop: WhyHop) => string> = {
  // A bound hop already ends by saying what hop.to provides, so only
  // the written line appends it to hop.to's location.
  written: (hop) =>
    `${hop.from.identity.name} (${locationClause(hop.from)}) calls ${hop.callee}, and that call runs ${hop.to?.identity.name} (${hop.to === null ? "" : locationClause(hop.to)}):`,
  bound: (hop) =>
    hop.to === null
      ? `${hop.from.identity.name} (${locationClause(hop.from)}) is bound to ${hop.callee}, which nothing here provides`
      : `${hop.from.identity.name} (${locationClause(hop.from)}) is bound to ${hop.callee}, which ${hop.to.identity.name} (${unitAt(hop.to)}) provides`,
};

function hopLine(hop: WhyHop): string {
  return HOP_LINE[hop.recorded](hop);
}

function hopJson(hop: WhyHop): Record<string, unknown> {
  const fromProvides = providesKeyOf(hop.from);
  const toProvides = hop.to === null ? undefined : providesKeyOf(hop.to);
  return {
    from: summaryIdentifier(hop.from),
    ...(fromProvides !== undefined ? { fromProvides } : {}),
    callee: hop.callee,
    to: hop.to === null ? null : summaryIdentifier(hop.to),
    ...(toProvides !== undefined ? { toProvides } : {}),
    recorded: hop.recorded,
  };
}

/** The proof step reads TypeScript, so a hop written in Python or Ruby shows without one. */
function provable(hop: WhyHop): boolean {
  const language = languageOfFile(hop.from.location.file);
  return (
    hop.recorded === "written" &&
    (language === null || language === "typescript")
  );
}

/** Null when the root cannot be read as a project at all. */
function openSession(root: string): WhySession | null {
  try {
    return new WhySession({ dir: root });
  } catch {
    return null;
  }
}

/**
 * The witness proof for one hop: find the call the summary recorded,
 * in the caller's own lines, and explain what its callee resolves to.
 * Null when the source and the summaries disagree, which the caller
 * says once rather than per hop.
 */
function explainHop(
  session: WhySession | null,
  hop: WhyHop,
): WhyExplained | null {
  if (session === null) {
    return null;
  }
  const range = hop.from.location.range;
  const callee = session.findCallee(
    hop.from.location.file,
    range.start,
    range.end,
    hop.callee,
  );
  if (callee === null) {
    return null;
  }
  return session.explain(callee);
}
