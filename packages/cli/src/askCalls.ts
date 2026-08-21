/**
 * `what calls <unit>`: the reverse of the reach questions.
 *
 * Every call the run resolved records which summary it reaches, so
 * the callers of a unit are a scan over everyone else's invocation
 * effects. The one thing that can hide a caller is a call suss could
 * not follow, and the answer says when the run recorded any, so an
 * empty list reads as "nothing calls this" only when it is.
 */

import { summaryIdentifier } from "@suss/behavioral-ir";

import { gapCaveats } from "./askCaveats.js";
import { noUnitSpelled, unitsSpelled } from "./askWhy.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Answer, AnswerItem } from "./ask.js";

/** One caller, and the call as its source writes it. */
interface CallSite {
  caller: BehavioralSummary;
  callee: string;
}

export function answerCalls(
  subject: string,
  summaries: BehavioralSummary[],
): Answer {
  const units = unitsSpelled(subject, summaries);
  if (units.length === 0) {
    return {
      shape: "calls",
      subject,
      headline: noUnitSpelled(subject),
      items: [],
      needs: [],
      caveats: [],
      found: false,
    };
  }

  const label = units.length === 1 ? summaryIdentifier(units[0]) : subject;
  const sites = callSitesInto(units, summaries);
  const callers = [...new Set(sites.map((site) => site.caller))];

  if (sites.length === 0) {
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

  const items: AnswerItem[] = sites.map((site) => ({
    text: `${summaryIdentifier(site.caller)} (${site.caller.location.file}:${site.caller.location.range.start}) calls ${site.callee}`,
    data: {
      unit: summaryIdentifier(site.caller),
      file: site.caller.location.file,
      line: site.caller.location.range.start,
      call: site.callee,
    },
  }));

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

/** Every recorded call that reaches one of these units. */
function callSitesInto(
  units: ReadonlyArray<BehavioralSummary>,
  summaries: ReadonlyArray<BehavioralSummary>,
): CallSite[] {
  const ids = new Set(units.map((unit) => summaryIdentifier(unit)));
  const sites: CallSite[] = [];
  const seen = new Set<string>();
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (
          effect.type !== "invocation" ||
          effect.summary === undefined ||
          !ids.has(effect.summary)
        ) {
          continue;
        }
        const key = `${summaryIdentifier(summary)}\u0000${effect.callee}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        sites.push({ caller: summary, callee: effect.callee });
      }
    }
  }
  return sites;
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
  return [
    `suss met a call it could not follow in ${stopped.length === 1 ? "one unit" : `${stopped.length} units`}, so a caller of ${label} could be hiding there. suss inspect says which calls.`,
  ];
}
