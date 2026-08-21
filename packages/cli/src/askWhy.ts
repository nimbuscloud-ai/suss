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
 */

import fs from "node:fs";
import path from "node:path";

import { WhySession } from "@suss/adapter-typescript";
import { summaryIdentifier } from "@suss/behavioral-ir";

import { gapCaveats } from "./askCaveats.js";
import { groundedTouchesAt } from "./askGrounding.js";
import { boundariesTouchedBy, namesBoundary } from "./boundaryReach.js";
import { resolveTarget } from "./target.js";

import type { ValueLocation, WhyExplained } from "@suss/adapter-typescript";
import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Answer, AnswerItem, AskOptions, ParsedQuestion } from "./ask.js";
import type { TouchedBoundary } from "./boundaryReach.js";

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
  loadSummaries: () => BehavioralSummary[],
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

interface UnitHop {
  from: BehavioralSummary;
  /** The call as the caller writes it. */
  callee: string;
  to: BehavioralSummary;
}

interface BoundaryPath {
  start: BehavioralSummary;
  hops: UnitHop[];
  touch: TouchedBoundary;
}

function answerWhyReaches(
  question: ParsedQuestion,
  options: AskOptions,
  summaries: BehavioralSummary[],
): Answer {
  const boundarySpec = question.object ?? "";
  const units = unitsSpelled(question.subject, summaries);
  if (units.length === 0) {
    return miss(
      "whyReaches",
      question.subject,
      noUnitSpelled(question.subject),
    );
  }

  const goesThrough = crossesBoundary(boundarySpec, summaries);
  const touching = summaries.filter((summary) =>
    boundariesTouchedBy(summary).some((touch) => goesThrough(summary, touch)),
  );
  if (touching.length === 0) {
    return miss(
      "whyReaches",
      question.subject,
      `Nothing in these summaries goes through ${boundarySpec}.`,
      [`Extract the code that goes through ${boundarySpec}, then ask again.`],
    );
  }

  const found = pathToBoundary(units, goesThrough, summaries);
  if (found === null) {
    return miss(
      "whyReaches",
      question.subject,
      `Nothing in these summaries says ${question.subject} reaches ${boundarySpec}.`,
      [
        `${boundarySpec} is where ${touching
          .map((summary) => summary.identity.name)
          .join(
            ", ",
          )} go${touching.length === 1 ? "es" : ""}, and no call chain here connects ${question.subject} to ${touching.length === 1 ? "it" : "any of them"}.`,
      ],
    );
  }

  return reachAnswer(question.subject, found, options);
}

/** What to print when nothing in the summaries is the spelled unit. */
export function noUnitSpelled(spec: string): string {
  return `No summary here is ${spec}. Spell the unit as a file, a summary id, or its function name.`;
}

/**
 * The units somebody spelled: whatever the `--at` spellings resolve
 * to, and failing those, the units whose function name is what was
 * typed, so `getOrder` works without its file.
 */
export function unitsSpelled(
  spec: string,
  summaries: BehavioralSummary[],
): BehavioralSummary[] {
  const resolution = resolveTarget(spec, summaries);
  if (resolution.matched) {
    return resolution.target.summaries;
  }
  return summaries.filter(
    (summary) =>
      summary.identity.name === spec ||
      summary.identity.name.endsWith(`.${spec}`),
  );
}

/** The call edges out of one unit, to the units this run resolved them to. */
function invocationEdges(
  summary: BehavioralSummary,
  byId: ReadonlyMap<string, BehavioralSummary>,
): UnitHop[] {
  const edges: UnitHop[] = [];
  const seen = new Set<string>();
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (effect.type !== "invocation" || effect.summary === undefined) {
        continue;
      }
      const to = byId.get(effect.summary);
      if (to === undefined || seen.has(effect.summary)) {
        continue;
      }
      seen.add(effect.summary);
      edges.push({ from: summary, callee: effect.callee, to });
    }
  }
  return edges;
}

/**
 * Breadth-first over the run's own call edges, so the chain found is
 * the shortest one the summaries state. The path is summary-level; the
 * resolution proof under each hop comes later, from source.
 */
/**
 * Whether one unit goes through the boundary somebody asked about.
 * A why question takes the same spellings a `what reads` question
 * takes, deployed names included, so one store cannot be reachable by
 * one question and absent from the other.
 */
type CrossesBoundary = (
  summary: BehavioralSummary,
  touch: TouchedBoundary,
) => boolean;

function crossesBoundary(
  boundarySpec: string,
  summaries: BehavioralSummary[],
): CrossesBoundary {
  const grounded = new Set(
    groundedTouchesAt(boundarySpec, summaries).touches.map(
      (touch) => touch.touched.binding,
    ),
  );
  return (_summary, touch) =>
    touch.relation !== "provides" &&
    (namesBoundary(boundarySpec, touch.binding) || grounded.has(touch.binding));
}

function pathToBoundary(
  starts: BehavioralSummary[],
  goesThrough: CrossesBoundary,
  summaries: BehavioralSummary[],
): BoundaryPath | null {
  const byId = new Map(
    summaries.map((summary) => [summaryIdentifier(summary), summary]),
  );
  const visited = new Set<BehavioralSummary>();
  const queue = starts.map((start) => ({
    start,
    at: start,
    hops: [] as UnitHop[],
  }));

  while (queue.length > 0) {
    const entry = queue.shift() as (typeof queue)[number];
    if (visited.has(entry.at)) {
      continue;
    }
    visited.add(entry.at);

    const touch = boundariesTouchedBy(entry.at).find((candidate) =>
      goesThrough(entry.at, candidate),
    );
    if (touch !== undefined) {
      return { start: entry.start, hops: entry.hops, touch };
    }

    for (const edge of invocationEdges(entry.at, byId)) {
      if (!visited.has(edge.to)) {
        queue.push({
          start: entry.start,
          at: edge.to,
          hops: [...entry.hops, edge],
        });
      }
    }
  }
  return null;
}

/** Where a summary is, the way an answer prints it. */
function unitAt(summary: BehavioralSummary): string {
  return `${summary.location.file}:${summary.location.range.start}`;
}

function reachAnswer(
  subject: string,
  found: BoundaryPath,
  options: AskOptions,
): Answer {
  const root = path.resolve(options.project ?? process.cwd());
  const startName = found.start.identity.name;
  const finalUnit =
    found.hops.length === 0
      ? found.start
      : found.hops[found.hops.length - 1].to;
  const touch = found.touch;

  const chain = [
    startName,
    ...found.hops.map((hop) => hop.to.identity.name),
    ...(touch.callee !== undefined ? [touch.callee] : []),
  ];

  const items: AnswerItem[] = [{ text: chain.join(" -> "), data: { chain } }];
  const caveats: string[] = [];
  const session = openSession(root);
  const hopsJson: Array<Record<string, unknown>> = [];
  let missingProofs = false;

  for (const hop of found.hops) {
    items.push({
      text: `${hop.from.identity.name} (${unitAt(hop.from)}) calls ${hop.callee}, and that call runs ${hop.to.identity.name} (${unitAt(hop.to)}):`,
      data: {
        from: summaryIdentifier(hop.from),
        callee: hop.callee,
        to: summaryIdentifier(hop.to),
      },
    });
    const explained = explainHop(session, hop);
    if (explained === null) {
      missingProofs = true;
    } else {
      for (const item of explanationItems(explained)) {
        items.push({ text: `  ${item.text}`, data: item.data });
      }
    }
    hopsJson.push({
      from: summaryIdentifier(hop.from),
      callee: hop.callee,
      to: summaryIdentifier(hop.to),
      ...(explained === null ? {} : { resolution: resolutionJson(explained) }),
    });
  }

  const through = touch.callee === undefined ? "" : ` through ${touch.callee}`;
  items.push({
    text:
      found.hops.length === 0
        ? `${finalUnit.identity.name} ${touch.relation} ${touch.label}${through}, in its own body (${unitAt(finalUnit)})`
        : `${finalUnit.identity.name} ${touch.relation} ${touch.label}${through} (${unitAt(finalUnit)})`,
    data: {
      unit: summaryIdentifier(finalUnit),
      relation: touch.relation,
      boundary: touch.label,
      ...(touch.callee !== undefined ? { via: touch.callee } : {}),
    },
  });

  if (missingProofs) {
    caveats.push(
      `The source under ${root} does not line up with these summaries, so some hops show without their resolution steps. --project says where the source is.`,
    );
  }
  caveats.push(
    ...gapCaveats([found.start, ...found.hops.map((hop) => hop.to)]),
  );

  return {
    shape: "whyReaches",
    subject,
    headline: `${startName} reaches ${touch.label}:`,
    items,
    needs: [],
    caveats,
    found: true,
    detail: {
      boundary: touch.label,
      chain,
      hops: hopsJson,
    },
  };
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
  hop: UnitHop,
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
