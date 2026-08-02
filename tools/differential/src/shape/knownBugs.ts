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
    value: "letReassigned",
    signature: "equivalence:summaries[0].transitions",
    wrong: "a reassigned binding is summarized from its first assignment",
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

/** Wrong behaviour at an HTTP registration call. */
export const HANDLER_BUGS: ReproducedBug[] = [
  {
    dimension: "reach",
    value: "throughName",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a handler that is not written at the registration call loses its boundary",
  },
  {
    dimension: "result",
    value: "wideNamedType",
    signature: "invariant:noRunawaySummary",
    wrong:
      "a wide type the project declares is walked across its whole breadth",
  },
];

/**
 * Wrong behaviour where a decorator announces the boundary. The pack
 * takes a list of class decorator names through its config, so naming
 * one project wrapper there is the path today. What the fuzzer adds is
 * the size of the space that config has to cover, and one case config
 * should not be needed for: `applyDecorators` is the framework's own
 * composition helper, not a project convention.
 */
export const ANNOUNCEMENT_BUGS: ReproducedBug[] = [
  {
    dimension: "announcement",
    value: "aliasedImport",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "importing Controller under another name loses the boundary, though it is the same decorator",
  },
  {
    dimension: "announcement",
    value: "wrappedDecorator",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong: "a project decorator that calls Controller loses the boundary",
  },
  {
    dimension: "announcement",
    value: "wrappedWithArgument",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a project decorator that hands its argument to Controller loses the boundary and the route path with it",
  },
  {
    dimension: "announcement",
    value: "composedDecorator",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "applyDecorators(Controller(...)), which NestJS documents as the way to compose, loses the boundary",
  },
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
