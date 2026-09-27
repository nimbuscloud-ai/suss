/**
 * Finds the summaries a PRD's `coveredBy` and `about` spellings mean,
 * for the intent pass in @suss/checker-intent to check.
 *
 * A test is spelled the way the runner prints it, the file and then its
 * titles joined with ` > `. The file goes through `filesMatching`, so a
 * repo-relative path matches a summary written relative to its package,
 * and the titles have to equal the test unit's name. A subject goes
 * through the same resolver `suss ask` uses.
 */

import { summaryIdentifier } from "@suss/behavioral-ir";
import { readCallFacts } from "@suss/checker";
import { loadIntentDirectory } from "@suss/contract-intent";
import { TEST_TITLE_SEPARATOR } from "@suss/intent-ir";

import { functionsSpelled } from "./reachTarget.js";
import { filesMatching } from "./target.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CallFacts } from "@suss/checker";
import type {
  CoveringTestLookup,
  FoundSubject,
  FoundTest,
} from "@suss/checker-intent";
import type { CoveringTestSpelling, IntentSummary } from "@suss/intent-ir";

/** How many of a file's tests a missing-test message lists. */
const TESTS_LISTED = 5;

export function coveringTestLookup(
  code: ReadonlyArray<BehavioralSummary>,
): CoveringTestLookup {
  // A run whose PRDs list no test never asks, so it never pays for the facts.
  let facts: CallFacts | undefined;
  const factsOnce = (): CallFacts => {
    facts ??= readCallFacts(code);
    return facts;
  };
  const tests = code.filter((summary) => summary.kind === "test");
  // Scenarios in one PRD share a subject, and each resolution walks
  // every summary, so each spelling is resolved once.
  const subjects = new Map<string, FoundSubject>();
  const subjectSpelled = (spelledAs: string): FoundSubject => {
    const found = functionsSpelled(spelledAs, code, factsOnce());
    return found.found
      ? { found: true, target: found.target, label: found.label }
      : { found: false, message: found.headline };
  };
  return {
    get facts() {
      return factsOnce();
    },
    test: (spelled) => testSpelled(spelled, tests),
    subject: (spelledAs) => {
      const known = subjects.get(spelledAs) ?? subjectSpelled(spelledAs);
      subjects.set(spelledAs, known);
      return known;
    },
  };
}

/**
 * The test files the PRDs list under `coveredBy`, for a test pack to
 * read and no others. A workspace written in front of a file is left
 * off, since the pack matches on the path alone.
 */
export function testFilesNamedIn(intents: readonly IntentSummary[]): string[] {
  const files = new Set<string>();
  for (const intent of intents) {
    if (intent.kind !== "prd") {
      continue;
    }
    for (const scenario of intent.scenarios) {
      for (const spelled of scenario.coveredBy) {
        files.add(withoutWorkspace(spelled.file).file);
      }
    }
  }
  return [...files].sort();
}

/** The same list for the intent documents in a directory, read the way `check --intent` reads them. */
export function testFilesListedIn(intentDir: string): string[] {
  return testFilesNamedIn(loadIntentDirectory(intentDir));
}

/** `@suss/cli::src/run.test.ts` says which workspace's `src/run.test.ts`. */
function withoutWorkspace(file: string): {
  workspace: string | null;
  file: string;
} {
  const at = file.indexOf("::");
  return at === -1
    ? { workspace: null, file }
    : { workspace: file.slice(0, at), file: file.slice(at + 2) };
}

function testSpelled(
  spelled: CoveringTestSpelling,
  tests: ReadonlyArray<BehavioralSummary>,
): FoundTest {
  if (tests.length === 0) {
    return {
      found: false,
      message:
        "and these summaries have no tests in them; extract the test files with a test pack, such as -f vitest",
    };
  }

  const { workspace, file } = withoutWorkspace(spelled.file);
  const inWorkspace =
    workspace === null
      ? tests
      : tests.filter((test) => test.location.workspace === workspace);
  const files = new Set(filesMatching(file, inWorkspace));
  const inFile = inWorkspace.filter((test) => files.has(test.location.file));
  if (inFile.length === 0) {
    return {
      found: false,
      message: `and no test here is in a file matching ${file}`,
    };
  }

  const name = spelled.titles.join(TEST_TITLE_SEPARATOR);
  const matched = inFile.filter((test) => test.identity.name === name);
  if (matched.length === 1) {
    return { found: true, unit: matched[0] };
  }

  if (matched.length > 1) {
    return {
      found: false,
      message: `which could mean ${matched.length} tests here (${matched.map((test) => summaryIdentifier(test)).join(", ")}); write the workspace in front of the file, as in ${matched[0].location.workspace ?? "<workspace>"}::${file}`,
    };
  }

  const near = inFile.slice(0, TESTS_LISTED).map((test) => test.identity.name);
  return {
    found: false,
    message: `and no test in ${file} has that title. Tests there: ${near.join("; ")}${inFile.length > TESTS_LISTED ? `, and ${inFile.length - TESTS_LISTED} more` : ""}`,
  };
}
