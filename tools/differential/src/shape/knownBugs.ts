// knownBugs.ts: the bugs the shape fuzzer finds in the tree today.
//
// Everything here describes behaviour that is wrong and has not been
// fixed yet. Two readers depend on it. The test suite asserts each one
// still reproduces, so fixing a bug breaks a test and whoever fixed it
// promotes the dimension value into the sound tier. The scheduled run
// compares what it found against this list and fails on anything that
// is not in it, so a night that turns up something new is loud rather
// than a log nobody reads.

export interface ReproducedBug {
  dimension:
    | "form"
    | "binding"
    | "route"
    | "reach"
    | "result"
    | "announcement"
    | "method";
  value: string;
  /** The finding the fuzzer reports for this shape today. */
  signature: string;
  /** What suss gets wrong, in a sentence. */
  wrong: string;
}

/** Wrong behaviour at the render boundary, one dimension value each. */
export const COMPONENT_BUGS: ReproducedBug[] = [
  {
    dimension: "form",
    value: "overloaded",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong: "a component with overload signatures is not discovered at all",
  },
  {
    dimension: "binding",
    value: "destructured",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong: "a component bound by destructuring is not discovered",
  },
  {
    dimension: "binding",
    value: "withDefault",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong: "a component bound with a default is not discovered",
  },
  {
    dimension: "route",
    value: "defaultOfName",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "`export default Panel`, where Panel is a binding, is not discovered",
  },
  {
    dimension: "route",
    value: "defaultDeclaration",
    signature: "invariant:aNamedUnitKeepsItsName",
    wrong: "a named function exported as the default is reported as `default`",
  },
  {
    dimension: "route",
    value: "throughProperty",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong: "`export default views.Panel` is not discovered",
  },
  {
    dimension: "route",
    value: "throughFactoryArg",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a component handed to a factory in an object argument is not discovered",
  },
  {
    dimension: "route",
    value: "barrel",
    signature: "invariant:noTwoSummariesShareAnIdentity",
    wrong: "a barrel re-export produces a second summary on the same identity",
  },
];

/**
 * The reach paths a registration call follows to the handler behind it.
 * Everything not listed below resolves, and the sound tier asserts it.
 */
export const SOUND_REACH_PATHS = [
  "direct",
  "throughName",
  "throughProperty",
  "throughIndex",
  "throughAlias",
  "throughImport",
  "throughBarrel",
  "throughTwoBarrels",
] as const;

/**
 * The three that do not, each for its own reason rather than for want
 * of a rule. A call's return would need the rule to ask whether the
 * callee unwraps, which is negation over a relation derived from the
 * rule doing the asking, and that does not stratify. A factory's object
 * argument is the `unwrapsProperty` rule that was tried and taken out,
 * because a wrapper reading several callbacks off one config made each
 * of them a candidate. A parameter is supplied by whoever calls the
 * registering function, so no chain reaches it from here; that one
 * should read as a boundary whose handler is unknown rather than as no
 * boundary at all.
 */
export const REACH_BUGS: ReproducedBug[] = [
  {
    dimension: "reach",
    value: "throughCallReturn",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong: "a handler a call returns loses its boundary",
  },
  {
    dimension: "reach",
    value: "throughFactoryArg",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a handler handed to a factory in an object argument loses its boundary",
  },
  {
    dimension: "reach",
    value: "throughParameter",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a handler arriving as a parameter loses its boundary, where it should read as one whose handler is unknown",
  },
];

/** Wrong behaviour at an HTTP registration call. */
export const HANDLER_BUGS: ReproducedBug[] = [
  ...REACH_BUGS,
  {
    dimension: "result",
    value: "wideNamedType",
    signature: "invariant:noRunawaySummary",
    wrong:
      "a wide type the project declares is walked across its whole breadth",
  },
];

/**
 * Every way a class can announce a controller now resolves, so the
 * sound tier carries the announcement dimension and nothing is listed
 * here. What is left is on the class's inside rather than its outside:
 * which members the walk reads once the class is recognized.
 */
export const ANNOUNCEMENT_BUGS: ReproducedBug[] = [
  {
    dimension: "method",
    value: "arrowProperty",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a handler written as a decorated arrow property, rather than a method, loses the boundary",
  },
];

/**
 * Every finding a run is expected to produce. A signature outside this
 * set means the fuzzer found something nobody has written down.
 */
export const KNOWN_SIGNATURES: ReadonlySet<string> = new Set([
  ...COMPONENT_BUGS.map((bug) => bug.signature),
  ...HANDLER_BUGS.map((bug) => bug.signature),
  ...ANNOUNCEMENT_BUGS.map((bug) => bug.signature),
  // A lost or duplicated boundary always shows up a second time as a
  // count that differs from the plainest spelling.
  "equivalence:summaries.length",
  "invariant:noBoundarySummarizedTwice",
  // A summary that lost its transitions usually lost its inputs too.
  "equivalence:summaries[0].inputs",
  "invariant:noEmptySummaryAtHighConfidence",
]);
