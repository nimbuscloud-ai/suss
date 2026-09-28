/**
 * Checks the tests a PRD scenario lists under `coveredBy`: that each
 * one exists, that it runs, and that its calls reach what the scenario
 * is about without going through a mock.
 *
 * Turning a spelled test or subject into summaries is the caller's
 * job, through the resolver its commands already use, and arrives here
 * as a `CoveringTestLookup`. The reach question is asked once for every
 * test, through the call facts in @suss/checker, rather than once per
 * scenario. It is asked a second time without honouring mocks only for
 * the tests that missed, to tell a test that never reaches its subject
 * from one that reaches it only through something it replaced.
 */

import { readTestMetadata } from "@suss/behavioral-ir";
import { callSpellings, functionOf } from "@suss/checker";

import type {
  BehavioralSummary,
  ReceiverClass,
  TestMock,
} from "@suss/behavioral-ir";
import type {
  CallFacts,
  CallPath,
  FunctionKey,
  Reached,
  ReachTarget,
} from "@suss/checker";
import type {
  CoveringTestSpelling,
  IntentFinding,
  IntentFindingKind,
  PrdSummary,
} from "@suss/intent-ir";
import type { UncheckedIntent } from "./index.js";

export type FoundTest =
  | { found: true; unit: BehavioralSummary }
  | { found: false; message: string };

export type FoundSubject =
  | {
      found: true;
      target: ReachTarget;
      label: string;
      /**
       * The classes the subject is, when it was spelled as a class or as
       * a file a class is written in. A call a test sends to one of them
       * reaches the subject. Empty for a single unit or a boundary.
       */
      classes?: ReadonlyArray<ReceiverClass>;
    }
  | { found: false; message: string };

/** How the check finds the summaries a PRD's spellings mean. */
export interface CoveringTestLookup {
  /** The call facts over the summaries being checked. */
  facts: CallFacts;
  /** The test unit a `coveredBy` entry means, or why there is none. */
  test(spelled: CoveringTestSpelling): FoundTest;
  /** What a boundary or unit spelling means, the way `suss ask` reads it. */
  subject(spelledAs: string): FoundSubject;
}

/** One `coveredBy` entry to check, with where it was written. */
export interface CoveringTestClaim {
  prd: PrdSummary;
  scenarioTitle: string | null;
  /** The scenario as a finding quotes it: its title, or its position. */
  label: string;
  spelled: CoveringTestSpelling;
  /** What the test has to reach: the `about` spellings, or the PRD's linked boundaries. */
  subjects: string[];
}

interface Subject {
  target: ReachTarget;
  label: string;
  classes: ReadonlyArray<ReceiverClass>;
}

type Verdict =
  | { kind: "covered" }
  | { kind: "finding"; finding: IntentFinding }
  | { kind: "unchecked"; unchecked: UncheckedIntent };

/**
 * One verdict per claim, in the order given. A claim whose test and
 * subject both resolve waits for the reach question, which runs once
 * over every such test.
 */
export function checkCoveringTests(
  claims: readonly CoveringTestClaim[],
  lookup: CoveringTestLookup,
): Verdict[] {
  const verdicts: Array<Verdict | null> = [];
  const waiting: Array<{
    at: number;
    unit: BehavioralSummary;
    test: FunctionKey;
    subject: Subject;
  }> = [];

  for (const [at, claim] of claims.entries()) {
    const found = lookup.test(claim.spelled);
    if (!found.found) {
      verdicts.push(finding(claim, "missingCoveringTest", found.message));
      continue;
    }

    if (readTestMetadata(found.unit)?.skipped === true) {
      verdicts.push(
        finding(
          claim,
          "coveringTestSkipped",
          "which is marked to be skipped, so it does not run",
        ),
      );
      continue;
    }

    const subject = subjectOf(claim, lookup);
    if ("message" in subject) {
      verdicts.push(finding(claim, "testMissesSubject", subject.message));
      continue;
    }

    verdicts.push(null);
    waiting.push({
      at,
      unit: found.unit,
      test: functionOf(found.unit),
      subject,
    });
  }

  if (waiting.length === 0) {
    return verdicts.map((verdict) => verdict ?? { kind: "covered" });
  }

  const honouring = lookup.facts.reachedFromEach(
    waiting.map((one) => one.test),
    { pastMocks: true },
  );
  const missed = waiting.filter(
    (one) =>
      pathInto(one.test, honouring.get(one.test), one.subject) === null &&
      callOnSubjectClass(one.test, one.subject, lookup, true) === null,
  );
  const ignoring =
    missed.length === 0
      ? new Map<FunctionKey, Reached>()
      : lookup.facts.reachedFromEach(missed.map((one) => one.test));

  for (const one of waiting) {
    const claim = claims[one.at];
    if (!missed.includes(one)) {
      verdicts[one.at] = { kind: "covered" };
      continue;
    }

    const reached = ignoring.get(one.test);
    const throughMock =
      pathInto(one.test, reached, one.subject) ??
      callOnSubjectClass(one.test, one.subject, lookup, false);
    if (throughMock !== null) {
      verdicts[one.at] = finding(
        claim,
        "testMissesSubject",
        `which reaches ${one.subject.label} only through a call its mocks replace (${mocksOf(lookup, one.test).join(", ")}), by ${callSpellings(throughMock).join(" -> ")}`,
      );
      continue;
    }
    const unfollowed = unfollowedOnTheWay(one.unit, one.test, reached, lookup);
    const nameMatches = unfollowedToSubject(one.unit, one.subject, lookup);
    verdicts[one.at] =
      unfollowed.length === 0 && nameMatches.length === 0
        ? finding(
            claim,
            "testMissesSubject",
            `which never reaches ${one.subject.label}`,
          )
        : notChecked(claim, one.subject, nameMatches, unfollowed);
  }

  return verdicts.map((verdict) => verdict ?? { kind: "covered" });
}

/** How many calls an unchecked test's detail lists. */
const CALLS_LISTED = 3;

/**
 * A test that does not reach its subject through the calls suss
 * followed, and makes calls suss could not follow, might reach it
 * through one of those. It is reported as unchecked, with the calls.
 */
function notChecked(
  claim: CoveringTestClaim,
  subject: Subject,
  nameMatches: readonly string[],
  unfollowed: readonly string[],
): Verdict {
  const calls = nameMatches.length > 0 ? nameMatches : unfollowed;
  const listed = calls.slice(0, CALLS_LISTED).join(", ");
  const more =
    calls.length > CALLS_LISTED
      ? `, and ${calls.length - CALLS_LISTED} more`
      : "";
  const why =
    nameMatches.length > 0
      ? `it calls ${listed}${more}, and suss could not follow that call to ${subject.label}`
      : `it never reaches ${subject.label} through the calls suss followed, and suss could not follow ${listed}${more}`;
  return {
    kind: "unchecked",
    unchecked: {
      intent: claim.prd.title,
      reason: "unfollowedCall",
      scenario: claim.label,
      coveredBy: claim.spelled.spelledAs,
      detail: `Scenario ${claim.label} lists the test "${claim.spelled.spelledAs}": ${why}.`,
    },
  };
}

/**
 * The calls suss could not follow in the test and in every function it
 * reaches, each once, in the order they were recorded.
 */
function unfollowedOnTheWay(
  test: BehavioralSummary,
  key: FunctionKey,
  reached: Reached | undefined,
  lookup: CoveringTestLookup,
): string[] {
  const units = [
    test,
    ...[...(reached?.functions.keys() ?? [])]
      .filter((fn) => fn !== key)
      .flatMap((fn) => lookup.facts.units.get(fn) ?? []),
  ];
  const found = new Set<string>();
  for (const unit of units) {
    for (const gap of unit.gaps) {
      if (gap.type === "unfollowedCall" && gap.callee !== undefined) {
        found.add(gap.callee);
      }
    }
  }
  return [...found];
}

/**
 * The subject every spelling resolves to, merged. Asking for one
 * spelling that resolves to nothing is a message, since a subject that
 * silently shrank would pass tests it should not.
 */
function subjectOf(
  claim: CoveringTestClaim,
  lookup: CoveringTestLookup,
): Subject | { message: string } {
  if (claim.subjects.length === 0) {
    return {
      message:
        "and the PRD links to no boundary a test could be checked against; say what it has to reach under about",
    };
  }

  const found: Subject[] = [];
  for (const spelledAs of claim.subjects) {
    const one = lookup.subject(spelledAs);
    if (!one.found) {
      return {
        message: `and what it has to reach, ${spelledAs}, is nothing in these summaries: ${one.message.replace(/\.$/, "")}`,
      };
    }
    found.push({ ...one, classes: one.classes ?? [] });
  }
  return {
    target: {
      functions: found.flatMap((one) => one.target.functions),
      keys: found.flatMap((one) => one.target.keys),
      at: found.flatMap((one) => one.target.at ?? []),
    },
    label: found.map((one) => one.label).join(" or "),
    classes: found.flatMap((one) => one.classes),
  };
}

/** The shortest path from the test into the subject, or null when it never gets there. */
function pathInto(
  test: FunctionKey,
  reached: Reached | undefined,
  subject: Subject,
): CallPath | null {
  const into = [...subject.target.functions, ...(subject.target.at ?? [])];
  if (into.includes(test)) {
    return [];
  }

  const paths = [
    ...into.map((fn) => reached?.functions.get(fn)),
    ...subject.target.keys.map((key) => reached?.keys.get(key)),
  ].filter((path): path is CallPath => path !== undefined);
  if (paths.length === 0) {
    return null;
  }
  return paths.reduce((shortest, path) =>
    path.length < shortest.length ? path : shortest,
  );
}

/**
 * A call in the test's own body sent to one of the subject's classes. A
 * concern's or the library's method on that class runs outside the
 * subject's file, so the call graph alone misses it. A mock stops it.
 */
function callOnSubjectClass(
  test: FunctionKey,
  subject: Subject,
  lookup: CoveringTestLookup,
  honourMocks: boolean,
): CallPath | null {
  const classes = new Set(subject.classes.map(classKey));
  if (classes.size === 0) {
    return null;
  }
  const units = lookup.facts.units.get(test) ?? [];
  const mocks = honourMocks
    ? units.flatMap((unit) => readTestMetadata(unit)?.mocks ?? [])
    : [];
  for (const effect of units.flatMap((unit) =>
    unit.transitions.flatMap((transition) => transition.effects),
  )) {
    if (
      effect.type !== "invocation" ||
      effect.receiverClass === undefined ||
      !classes.has(classKey(effect.receiverClass))
    ) {
      continue;
    }
    const method = lastName(effect.callee);
    if (mocks.some((mock) => replaces(mock, effect.receiverClass, method))) {
      continue;
    }
    return [{ callee: effect.callee, to: null, recorded: "written" }];
  }
  return null;
}

function classKey(sentTo: ReceiverClass): string {
  return `${sentTo.file}#${sentTo.name}`;
}

/** Whether a mock replaces this method on this class: the class's whole file, the method on it, or the method by name alone. */
function replaces(
  mock: TestMock,
  sentTo: ReceiverClass | undefined,
  method: string,
): boolean {
  if (mock.module === undefined) {
    return mock.name === method;
  }
  return (
    mock.module === sentTo?.file &&
    (mock.name === undefined || mock.name === method)
  );
}

/**
 * The calls in the test's own body with the subject's name that suss
 * could not follow, which are the likeliest way it reaches the subject.
 */
function unfollowedToSubject(
  test: BehavioralSummary,
  subject: Subject,
  lookup: CoveringTestLookup,
): string[] {
  const names = new Set([
    ...[...subject.target.functions, ...(subject.target.at ?? [])].flatMap(
      (fn) =>
        (lookup.facts.units.get(fn) ?? []).map((unit) =>
          lastName(unit.identity.name),
        ),
    ),
    ...subject.target.keys.map(lastName),
  ]);
  const unfollowed = test.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "invocation" &&
      effect.summary === undefined &&
      names.has(lastName(effect.callee))
        ? [effect.callee]
        : [],
    ),
  );
  return [...new Set(unfollowed)];
}

/** `Orders.cancel`, `fn:@acme/orders::cancel` and `cancel` all end in `cancel`. */
function lastName(spelled: string): string {
  return spelled.split(/::|\./).at(-1) ?? spelled;
}

function mocksOf(lookup: CoveringTestLookup, test: FunctionKey): string[] {
  const units = lookup.facts.units.get(test) ?? [];
  return [
    ...new Set(
      units.flatMap((unit) =>
        (readTestMetadata(unit)?.mocks ?? []).map((mock) => mock.written),
      ),
    ),
  ];
}

function finding(
  claim: CoveringTestClaim,
  kind: IntentFindingKind,
  why: string,
): Verdict {
  return {
    kind: "finding",
    finding: {
      kind,
      severity: "warning",
      boundary: `prd:${claim.prd.title}`,
      intent: { name: claim.prd.title },
      scenario: {
        ...(claim.scenarioTitle !== null ? { title: claim.scenarioTitle } : {}),
        coveredBy: claim.spelled.spelledAs,
      },
      message: `Scenario ${claim.label} in PRD "${claim.prd.title}" lists the test "${claim.spelled.spelledAs}", ${why}.`,
    },
  };
}
