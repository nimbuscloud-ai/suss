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
    | "method"
    | "site"
    | "field"
    | "operation"
    | "build"
    | "config";
  value: string;
  /** The finding the fuzzer reports for this shape today. */
  signature: string;
  /** What suss gets wrong, in a sentence. */
  wrong: string;
  /**
   * Other dimensions the bug needs, for one that takes two values to
   * show. The reproducing test starts from the plainest spelling and
   * applies these along with the dimension above.
   */
  alongside?: Record<string, string>;
}

/**
 * Wrong behaviour at the render boundary. How a component is written,
 * how its name is bound, and every way it leaves the module all resolve
 * now, so the sound tier covers those three dimensions. What is left is
 * the one route that hands the component to a factory, where the value
 * arrives inside an object argument and no rule reads it back out.
 */
export const COMPONENT_BUGS: ReproducedBug[] = [
  {
    dimension: "route",
    value: "throughFactoryArg",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a component handed to a factory in an object argument is not discovered",
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
  "throughCallReturn",
] as const;

/**
 * The reach path where the handler is supplied by whoever calls the
 * registering function. No chain reaches it from the file the route is
 * written in, so the summary keeps the route and says the handler was
 * not read, rather than agreeing with a spelling that does state a
 * body. Comparing it against the plainest spelling would report the one
 * difference it is meant to have, so the differential asserts the shape
 * it should be instead.
 */
export const REACH_PATHS_FROM_A_CALLER = ["throughParameter"] as const;

/**
 * The one that resolves to nothing at all, for its own reason rather
 * than for want of a rule. A call's return now resolves through a
 * second question asked after the unwrapping one declines. A factory's
 * object argument is the `unwrapsProperty` rule that was tried and
 * taken out, because a wrapper reading several callbacks off one
 * config made each of them a candidate.
 */
export const REACH_BUGS: ReproducedBug[] = [
  {
    dimension: "reach",
    value: "throughFactoryArg",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a handler handed to a factory in an object argument loses its boundary",
  },
];

/**
 * Wrong behaviour at an HTTP registration call.
 *
 * A wide type the project declares used to be walked across its whole
 * breadth at every mention. It is now written down once and named
 * everywhere else, so the sound tier covers the result dimension.
 */
export const HANDLER_BUGS: ReproducedBug[] = [...REACH_BUGS];

/**
 * Every way a class can announce a controller now resolves, so the
 * sound tier covers the announcement dimension and nothing is listed
 * here. What is left is on the class's inside rather than its outside:
 * which members the walk reads once the class is recognized.
 */
export const ANNOUNCEMENT_BUGS: ReproducedBug[] = [];

/**
 * Wrong behaviour where a GraphQL field says which function resolves it.
 * Apollo reads the object the constructor is handed, and every route to
 * that object now resolves, spreads included, so the sound tier covers
 * the whole route dimension and nothing is listed here.
 */
export const APOLLO_RESOLVER_BUGS: ReproducedBug[] = [];

/**
 * Wrong behaviour on a decorated resolver class. The arrow property is
 * the same shape the REST pack loses, in the pack next to it.
 */
export const NEST_RESOLVER_BUGS: ReproducedBug[] = [
  {
    dimension: "method",
    value: "arrowProperty",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a resolver written as a decorated arrow property, rather than a method, loses the boundary",
  },
];

/**
 * Every place a unit can read its runtime configuration and every way
 * the read can be spelled now resolve, so the sound tier covers both
 * dimensions whole and nothing is listed here. A read at module scope
 * is reported against the module that performs it rather than against
 * any unit the module declares.
 */
export const ENV_BUGS: ReproducedBug[] = [];

/**
 * Wrong behaviour at a queue consumer. All four entries here were the
 * same shape, a subject one hop away from the factory call that the
 * walk could not follow, and all four went when the consumer stopped
 * taking its channel from the factory config at all.
 */
export const QUEUE_BUGS: ReproducedBug[] = [];

/**
 * Wrong behaviour at the package boundary. Every publish route and
 * every import form now resolves, so both sides of the dimension are
 * in the sound tier and nothing is listed here.
 */
export const PACKAGE_BUGS: ReproducedBug[] = [];

/**
 * Every finding a run is expected to produce. A signature outside this
 * set means the fuzzer found something nobody has written down.
 */
export const KNOWN_SIGNATURES: ReadonlySet<string> = new Set([
  ...COMPONENT_BUGS.map((bug) => bug.signature),
  ...HANDLER_BUGS.map((bug) => bug.signature),
  ...ANNOUNCEMENT_BUGS.map((bug) => bug.signature),
  ...APOLLO_RESOLVER_BUGS.map((bug) => bug.signature),
  ...NEST_RESOLVER_BUGS.map((bug) => bug.signature),
  ...ENV_BUGS.map((bug) => bug.signature),
  ...QUEUE_BUGS.map((bug) => bug.signature),
  ...PACKAGE_BUGS.map((bug) => bug.signature),
  // A read nothing reports also disagrees with the plainest spelling
  // of the same read, on the transitions that would have carried it.
  "equivalence:summaries[0].transitions",
  "equivalence:summaries[1].transitions",
  // A resolver whose boundary was lost has nothing left to bind the
  // field it answers, so every lost resolver reports twice.
  "invariant:aResolverBindsToTheFieldItAnswers",
  // A lost or duplicated boundary always shows up a second time as a
  // count that differs from the plainest spelling.
  "equivalence:summaries.length",
  "invariant:noBoundarySummarizedTwice",
  // A summary that lost its transitions usually lost its inputs too.
  "equivalence:summaries[0].inputs",
  "invariant:noEmptySummaryAtHighConfidence",
]);

/**
 * How a class writes the handler the framework calls. A method, an
 * async method, and a property holding an arrow are one callable as far
 * as the framework is concerned, and the walk reads all three.
 */
export const SOUND_METHOD_FORMS = [
  "method",
  "asyncMethod",
  "arrowProperty",
] as const;
