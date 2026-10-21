/**
 * `what else sends the data <unit> sends`: the other paths that read or
 * send the same columns and fields as one unit, and send data out.
 *
 * It is the lookup `inspect --diff` makes for each unit a change moved,
 * made here for one unit with every datum it reads or sends.
 */

import { gapCaveats } from "./askCaveats.js";
import { datumText, placeText, sharedDataOf } from "./siblingExits.js";
import { resolveTarget, unitsServing } from "./target.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Answer, AnswerItem } from "./ask.js";
import type { LoadedSummaries } from "./loadedSummaries.js";

function notFound(subject: string, headline: string): Answer {
  return {
    shape: "sendsSame",
    subject,
    headline,
    items: [],
    needs: [],
    caveats: [],
    found: false,
  };
}

/** The units a subject means: the ones serving a boundary, or the ones it spells. */
function unitsOf(
  subject: string,
  summaries: readonly BehavioralSummary[],
): BehavioralSummary[] | string {
  const resolution = resolveTarget(subject, summaries);
  if (!resolution.matched) {
    return resolution.message;
  }
  const target = resolution.target;
  if (target.kind !== "boundary") {
    return [...target.summaries];
  }
  const serving = unitsServing(target.touches);
  return serving.length > 0
    ? serving
    : [...new Set(target.touches.map((touch) => touch.summary))];
}

export function answerSendsSame(
  subject: string,
  { summaries, callFacts }: LoadedSummaries,
): Answer {
  const units = unitsOf(subject, summaries);
  if (typeof units === "string") {
    return notFound(subject, units);
  }

  if (units.length === 0) {
    return notFound(subject, `Nothing in these summaries is at ${subject}.`);
  }
  const { data, notes, found } = sharedDataOf(units, summaries, callFacts);
  const caveats = [...notes, ...gapCaveats(units)];
  if (data.length === 0) {
    return {
      shape: "sendsSame",
      subject,
      headline: `${subject} doesn't read a column or send a field that suss could read.`,
      items: [],
      needs: [],
      caveats,
      found: true,
    };
  }

  const items: AnswerItem[] = [
    ...found.siblings.map((sibling) => ({
      text: `${placeText(sibling)}  shares ${sibling.shares.map(datumText).join(", ")}; ${sibling.sends.join(", ")}`,
      data: {
        unit: sibling.unit,
        file: sibling.file,
        line: sibling.line,
        ...(sibling.boundary === null ? {} : { boundary: sibling.boundary }),
        shares: sibling.shares.map(datumText),
        sends: sibling.sends,
      },
    })),
    ...found.unchecked.map((path) => ({
      text: `not checked: ${placeText(path)}  ${path.reasons.join("; ")}`,
      data: {
        unit: path.unit,
        file: path.file,
        line: path.line,
        ...(path.boundary === null ? {} : { boundary: path.boundary }),
        unchecked: path.reasons,
        sends: path.sends,
      },
    })),
  ];
  const count = found.siblings.length;
  return {
    shape: "sendsSame",
    subject,
    headline:
      count === 0
        ? `No other path sends the data ${subject} reads or sends.`
        : `${count} other unit${count === 1 ? "" : "s"} send${count === 1 ? "s" : ""} data ${subject} reads or sends:`,
    items,
    needs: [],
    caveats,
    found: true,
    detail: { data: data.map(datumText) },
  };
}
