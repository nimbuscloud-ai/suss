/**
 * Summaries read into memory once, together with the call facts built
 * from them.
 *
 * Reading a summary directory is most of what a question costs, and
 * building the call facts is most of the rest. A command that runs once
 * pays both once. A server answering many questions about one directory
 * should also pay them once, so it keeps one of these and passes it to
 * every question until the directory changes.
 *
 * The call facts are built on first use, because a question about what a
 * boundary declares never needs them. A method a call runs on one
 * construction of its receiver gets a copy with that construction's tables.
 */

import { withConstructions } from "@suss/behavioral-ir";
import { readCallFacts } from "@suss/checker";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CallFacts } from "@suss/checker";

export interface LoadedSummaries {
  readonly summaries: BehavioralSummary[];
  readonly callFacts: CallFacts;
}

export function loadedSummaries(read: BehavioralSummary[]): LoadedSummaries {
  const summaries = withConstructions(read);
  let facts: CallFacts | null = null;
  return {
    summaries,
    get callFacts(): CallFacts {
      facts ??= readCallFacts(summaries);
      return facts;
    },
  };
}
