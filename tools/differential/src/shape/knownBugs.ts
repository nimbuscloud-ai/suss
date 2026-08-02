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
 * now, so the sound tier carries those three dimensions. What is left is
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
 * Wrong behaviour where a GraphQL field says which function answers
 * it. Apollo reads the object the constructor is handed, and every
 * route to that object resolves except the one that builds a type's
 * fields elsewhere and spreads them in.
 */
export const APOLLO_RESOLVER_BUGS: ReproducedBug[] = [
  {
    dimension: "route",
    value: "spreadIntoLiteral",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a type's fields built in one object and spread into the resolver map are not discovered, so the field pairs with nothing",
  },
];

/**
 * Wrong behaviour on a decorated resolver class. The arrow property is
 * the same shape the REST pack loses, in the pack next to it. The
 * second one is a claim rather than a loss: a field resolver on a class
 * that names no type is reported as a root query field, which is a
 * field no schema has.
 */
export const NEST_RESOLVER_BUGS: ReproducedBug[] = [
  {
    dimension: "method",
    value: "arrowProperty",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a resolver written as a decorated arrow property, rather than a method, loses the boundary",
  },
  {
    dimension: "operation",
    value: "ResolveField",
    alongside: { announcement: "noTypeArgument" },
    signature: "invariant:aResolverBindsToTheFieldItAnswers",
    wrong:
      "a field resolver on a class that names no type binds to Query, so it claims a root operation field the schema does not have",
  },
];

/**
 * Wrong behaviour where a unit reads its runtime configuration. Two
 * spellings the node pack does not read at all, and one place it never
 * looks: a read above the unit, where a service puts the configuration
 * it wants read once.
 */
export const ENV_BUGS: ReproducedBug[] = [
  {
    dimension: "form",
    value: "bracket",
    signature: "invariant:everyConfigReadIsReported",
    wrong:
      'a read written as process.env["NAME"] is reported by nothing, though the pack documents that spelling as recognized',
  },
  {
    dimension: "form",
    value: "destructured",
    signature: "invariant:everyConfigReadIsReported",
    wrong:
      "a variable destructured off process.env is reported by nothing, so the unit looks like it needs no configuration",
  },
  {
    dimension: "site",
    value: "atModuleScope",
    signature: "invariant:everyConfigReadIsReported",
    wrong:
      "a read at module scope, above every unit, is reported by nothing however it is spelled",
  },
];

/**
 * Wrong behaviour at a queue consumer. Every one is the same shape:
 * the subject sits one hop away from the call that names the factory,
 * so the consumer keeps a function-call binding and pairs with no
 * producer. Nothing warns about it, and a service whose subjects live
 * in one shared file gets this on every consumer it has.
 */
export const QUEUE_BUGS: ReproducedBug[] = [
  {
    dimension: "build",
    value: "subjectFromConst",
    signature: "invariant:everyConsumerNamesItsChannel",
    wrong:
      "a subject bound to a const before the factory call loses the channel",
  },
  {
    dimension: "build",
    value: "subjectFromSharedMap",
    signature: "invariant:everyConsumerNamesItsChannel",
    wrong:
      "a subject read off the object a service keeps its subjects in loses the channel",
  },
  {
    dimension: "build",
    value: "spreadCarriesSubject",
    signature: "invariant:everyConsumerNamesItsChannel",
    wrong:
      "a subject arriving through a spread into the config loses the channel",
  },
  {
    dimension: "build",
    value: "wrappedFactoryResult",
    signature: "invariant:everyConsumerNamesItsChannel",
    wrong:
      "a handler wrapped after the factory built it loses the channel the factory named",
  },
];

/**
 * Wrong behaviour at the package boundary. Every way of publishing a
 * function resolves, so the provider side carries the whole publish
 * dimension. Both of these are on the calling side, and both leave a
 * call site nothing pairs against: the summary set says the package is
 * imported by nobody.
 */
export const PACKAGE_BUGS: ReproducedBug[] = [
  {
    dimension: "form",
    value: "namespaceImport",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a call through a namespace import produces no caller unit, so the call site pairs with nothing",
  },
  {
    dimension: "form",
    value: "throughLocalBinding",
    signature: "invariant:everyAnnouncedBoundaryIsSummarized",
    wrong:
      "a call through a local name bound to the import produces no caller unit",
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
  ...APOLLO_RESOLVER_BUGS.map((bug) => bug.signature),
  ...NEST_RESOLVER_BUGS.map((bug) => bug.signature),
  ...ENV_BUGS.map((bug) => bug.signature),
  ...QUEUE_BUGS.map((bug) => bug.signature),
  ...PACKAGE_BUGS.map((bug) => bug.signature),
  // A read nothing reports also disagrees with the plainest spelling
  // of the same read, on the transitions that would have carried it.
  "equivalence:summaries[0].transitions",
  "equivalence:summaries[1].transitions",
  // A consumer that lost its channel also disagrees with the plainest
  // spelling on every part of the binding it fell back from.
  "equivalence:summaries[0].identity.boundaryBinding.transport",
  "equivalence:summaries[0].identity.boundaryBinding.semantics.name",
  "equivalence:summaries[0].identity.boundaryBinding.semantics.messageBus",
  "equivalence:summaries[0].identity.boundaryBinding.semantics.channel",
  // A lost or duplicated boundary always shows up a second time as a
  // count that differs from the plainest spelling.
  "equivalence:summaries.length",
  "invariant:noBoundarySummarizedTwice",
  // A summary that lost its transitions usually lost its inputs too.
  "equivalence:summaries[0].inputs",
  "invariant:noEmptySummaryAtHighConfidence",
]);
