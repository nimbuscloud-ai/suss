/**
 * `what calls <unit>`: the direct callers of one function.
 *
 * The callers come off the one-hop call facts, so a call the run
 * resolved and a call recorded on the caller's binding are the same
 * answer, and the function is the same one whichever way the question
 * spells it. The one thing that can hide a caller is a call suss could
 * not follow, and the answer says when the run recorded any, so an
 * empty list reads as "nothing calls this" only when it is.
 */

import { summaryIdentifier } from "@suss/behavioral-ir";

import { hiddenBehindLine, unfollowedCalls } from "./ask.js";
import { gapCaveats } from "./askCaveats.js";
import { functionsSpelled, representativeUnit } from "./callFacts.js";
import { providesKeyOf } from "./target.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Answer, AnswerItem } from "./ask.js";
import type { LoadedSummaries } from "./loadedSummaries.js";

export function answerCalls(
  subject: string,
  { summaries, callFacts: facts }: LoadedSummaries,
): Answer {
  const spelled = functionsSpelled(subject, summaries, facts);
  if (!spelled.found) {
    return {
      shape: "calls",
      subject,
      headline: spelled.headline,
      items: [],
      needs: [],
      caveats: [],
      found: false,
    };
  }

  const { label } = spelled;
  const calls = facts.callersOf(spelled.target);
  const callers = [...new Set(calls.map((call) => call.caller))].map((fn) =>
    representativeUnit(facts, fn),
  );

  if (calls.length === 0) {
    return {
      shape: "calls",
      subject,
      headline: `Nothing in these summaries calls ${label}.`,
      items: [],
      needs: [],
      caveats: unfollowedCaveat(summaries, label),
      found: true,
    };
  }

  const items: AnswerItem[] = calls.map((call) => {
    const caller = representativeUnit(facts, call.caller);
    const provides = providesKeyOf(caller);
    const at = `${caller.location.file}:${caller.location.range.start}${provides === undefined ? "" : `, provides ${provides}`}`;
    return {
      text: `${summaryIdentifier(caller)} (${at}) calls ${call.callee}`,
      data: {
        unit: summaryIdentifier(caller),
        file: caller.location.file,
        line: caller.location.range.start,
        ...(provides !== undefined ? { provides } : {}),
        call: call.callee,
      },
    };
  });

  return {
    shape: "calls",
    subject,
    headline: `${callers.length} unit${callers.length === 1 ? "" : "s"} call${callers.length === 1 ? "s" : ""} ${label}:`,
    items,
    needs: [],
    caveats: [
      ...gapCaveats(callers),
      ...unfollowedCaveat(summaries, label, callers),
    ],
    found: true,
  };
}

/**
 * The distinction between "nothing calls this" and "no call suss
 * could follow calls this". Units the answer already listed report
 * their own gaps line by line, so they are left out here.
 */
function unfollowedCaveat(
  summaries: ReadonlyArray<BehavioralSummary>,
  label: string,
  listed: ReadonlyArray<BehavioralSummary> = [],
): string[] {
  const already = new Set(listed);
  const stopped = summaries.filter(
    (summary) =>
      !already.has(summary) &&
      summary.gaps.some((gap) => gap.type === "unfollowedCall"),
  );
  if (stopped.length === 0) {
    return [];
  }
  return [hiddenBehindLine(unfollowedCalls(stopped), `a caller of ${label}`)];
}
