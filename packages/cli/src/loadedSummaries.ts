/**
 * Summaries read into memory once, with the call facts built over them
 * kept beside them.
 *
 * Reading a summary directory is most of what a question costs, and
 * building the call facts is most of the rest. A command that runs
 * once pays both once. A server answering many questions over one
 * directory should pay them once per directory, so a caller that keeps
 * one of these hands it to every question until the directory changes.
 *
 * The call facts are built on first use, since a question about what a
 * boundary declares never needs them.
 */

import { readCallFacts } from "./callFacts.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CallFacts } from "./callFacts.js";

export interface LoadedSummaries {
  readonly summaries: BehavioralSummary[];
  readonly callFacts: CallFacts;
}

export function loadedSummaries(
  summaries: BehavioralSummary[],
): LoadedSummaries {
  let facts: CallFacts | null = null;
  return {
    summaries,
    get callFacts(): CallFacts {
      facts ??= readCallFacts(summaries);
      return facts;
    },
  };
}
