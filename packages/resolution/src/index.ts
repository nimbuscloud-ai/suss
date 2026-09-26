export {
  type CalleeOutcome,
  calleeOutcomeOf,
  calleeOutcomes,
  couldBeSettled,
  writtenSourcesOf,
} from "./callee.js";
export { checkFactContract, FACT_CONTRACT_CASES } from "./contract.js";
export { declaredTypesOf } from "./declaredType.js";
export { explainResolutionProof, renderExplanation } from "./explain.js";
export {
  agreedMountPrefix,
  joinMountedPath,
  type MountEdge,
  type MountEdges,
  mountPathsOf,
} from "./mount.js";
export {
  type ChainReads,
  type NameReads,
  type OrderedWrite,
  type ReadNode,
  startsAtName,
  writesRunInOrder,
} from "./nameReads.js";
export { nodeOfKey, type SpannedNode } from "./nodeKey.js";
export {
  type AssociationConstructor,
  addPackWords,
  type EntersAsSelf,
  type GivesBackOne,
  type GivesBackOneOfArgument,
  type GivesBackOneOfImport,
  type PackWords,
  type UnwrapsByName,
} from "./packWords.js";
export {
  ASKING_RELATIONS,
  askResolution,
  askResolutionUnder,
  queryFacts,
  resolutionProgram,
  resolutionUnderProgram,
  UNDER_QUESTION_ROW_BUDGET,
  UNDER_RUN_ROW_BUDGET,
  type UnderOutcome,
  underQuestionSpend,
} from "./program.js";
export { explainResolvedKey, proofRules } from "./session.js";
export {
  answersByKey,
  type OverrideRelations,
  placeholderValues,
  singleAnswers,
  WANTED_OVERRIDES,
  withoutOverridden,
} from "./singleAnswer.js";
export {
  allocationSitesOf,
  comesToUnder,
  isWrittenAsUnder,
  objectOfUnder,
  writtenValueUnder,
} from "./underContext.js";
export { type NameWrite, valueLeftByWrites } from "./writes.js";
export {
  fallbackWrittenAs,
  writtenValueOf,
  writtenValuesByKey,
  writtenValuesOf,
} from "./writtenValue.js";

export type {
  CaseFiles,
  ContractCase,
  ContractOptions,
  FactsOf,
} from "./contract.js";
export type {
  DescribeAtom,
  ExplainOptions,
  ResolutionExplanation,
  ResolutionStep,
  StepContext,
  StepPhrase,
} from "./explain.js";
export type {
  ExplainResolvedKeyOptions,
  ExplainStats,
  ValueLocation,
  WhyExplained,
} from "./session.js";

// @suss/resolution: following a value to the function it comes down to.
//
// These rules are about programming languages rather than about any one
// of them. A name binds to a value, a call puts an argument in a
// parameter, an object holds a value under a name, a module exports a
// name and another module can forward it, and a function that returns a
// function calling its parameter hands back the argument it was given.
// That last one is a decorator in Python and a closure in Go.
//
// So an adapter reads source into facts and leaves their meaning to the
// rules. Anything particular to one language, like JavaScript's `.bind`,
// belongs with that language's adapter and composes on top.
//
// Every fact an adapter supplies and every word a pack declares has a line
// in DESIGN.md, under "The facts an adapter supplies". Check there before
// adding a fact. `npm run check:fact-vocabulary` fails until it has a line.
//
// Node identity is the adapter's business. The rules only join on it.
// Making one of a class is a call of the class, however the language
// writes it: `Foo()`, `new Foo()`, `Foo.new`. The adapter says `call`
// about whichever of those it reads, and lists the constructor's
// parameters as `paramOf` of the class. The hop from that call to the
// class is an instance step. The receiver inside a method is one of
// the class, and `instanceOf` says so. A property its body writes is
// `storesProperty` about that method.

import { constant, lit, rule, variable as v } from "@suss/datalog";

import type { Rule } from "@suss/datalog";

/** A step to the value x is written as. */
export const VALUE_STEP = constant("value");

/**
 * The name a whole-module import records itself under, whatever the
 * language spells it as: `import * as ns` in TypeScript, `import
 * module` in Python. Adapters emit this name; the member-read rule
 * joins on it.
 */
export const NAMESPACE_IMPORT_NAME = "*";
export const NAMESPACE_IMPORT = constant(NAMESPACE_IMPORT_NAME);

/** The name a default import records itself under, `import React from "react"`. */
export const DEFAULT_IMPORT_NAME = "default";
const DEFAULT_IMPORT = constant(DEFAULT_IMPORT_NAME);

/**
 * The module an adapter records a global under, with the global's full
 * dotted name: `Object.assign` in JavaScript. A pack word keys on it the
 * way it keys on any other import.
 */
export const GLOBAL_MODULE = "global";

/**
 * The label on the `comesFrom` rule for a member read off a whole-module
 * import. `explain` tells that proof from the two import ones by it.
 */
export const NAMESPACE_MEMBER_RULE = "namespace member";

/**
 * The label on the `contains` rule that walks a class's ancestry.
 * `explain` says a name came from a base class when it fired.
 */
export const BASE_CLASS_RULE = "base class";

/**
 * The label on the `hop` rule that takes a name hop. `explain` gives the
 * name hop's own reason for that step, since this rule adds nothing to it.
 */
export const NAME_HOP_RULE = "name hop";

/** A step from an instance to the class it is one of. */
export const INSTANCE_STEP = constant("instance");

/** The `callArgCount` of a call written with nothing between its parentheses. */
const NO_ARGUMENTS = constant("0");

/** A step to what running the call x is handed back. */
export const RESULT_STEP = constant("result");

/** The context a value read outside every allocation site is read under. */
export const NO_CONTEXT_NAME = "none";
export const NO_CONTEXT = constant(NO_CONTEXT_NAME);

/**
 * How two steps in a row combine: value is weaker than instance, which
 * is weaker than result. One table for both closures, so `reaches` and
 * `reachesUnder` cannot drift apart.
 */
const STEP_LATTICE = [
  { soFar: VALUE_STEP, next: v("kind"), took: v("kind") },
  { soFar: INSTANCE_STEP, next: VALUE_STEP, took: INSTANCE_STEP },
  { soFar: INSTANCE_STEP, next: INSTANCE_STEP, took: INSTANCE_STEP },
  { soFar: INSTANCE_STEP, next: RESULT_STEP, took: RESULT_STEP },
  { soFar: RESULT_STEP, next: VALUE_STEP, took: RESULT_STEP },
  { soFar: RESULT_STEP, next: INSTANCE_STEP, took: RESULT_STEP },
  { soFar: RESULT_STEP, next: RESULT_STEP, took: RESULT_STEP },
];

/**
 * The rules every language adapter shares. Concatenate a language's own
 * rules onto these before evaluating.
 *
 * Every construct states its hops once, as `stepsTo(x, y, kind)`, which
 * says x leads to y. A value step goes to the value x is written as, an
 * instance step goes from an instance to the class it is one of, and a
 * result step runs the call x is and goes to what that call handed back.
 * `reaches` is the closure of those steps, and a walk takes the strongest
 * kind it stepped: value, then instance, then result.
 *
 * Each question is that one closure with its own stopping condition, so
 * adding a construct is one step and every question gets it, and adding
 * a question is a stopping condition and no steps at all.
 */
const STATED_RULES = [
  // Aliasing: const x = y, or an identifier referencing a declaration.
  // Every chain that follows a name takes the name hops, so a hop added
  // here reaches all of them.
  rule("nameHop", [v("x"), v("y")], [lit("binds", v("x"), v("y"))], "alias"),

  // A name written more than once has the value the last write left
  // there. The adapter works out which write that is, and stays quiet
  // when control flow decides; the rule below takes that name instead.
  rule(
    "nameHop",
    [v("x"), v("y")],
    [lit("endsHolding", v("x"), v("y"))],
    "last write",
  ),

  // A name whose writes nothing orders leads to each of them, so a
  // caller that can use several values gets them all and one that needs
  // a single value gets none. A write stating no value stops every step.
  rule(
    "nameHop",
    [v("x"), v("y")],
    [lit("mayHold", v("x"), v("y")), lit("writesAllStated", v("x"))],
    "one of several writes",
  ),

  // A fallback says the value is one of its branches, so each branch is
  // a step. A branch that resolves to nothing makes no claim, and two
  // branches resolving to different things fail the single-answer policy.
  rule(
    "nameHop",
    [v("x"), v("b")],
    [lit("fallbackBranch", v("x"), v("b"))],
    "fallback",
  ),

  // Every name hop is a value step. A language with a hop of its own, like
  // JavaScript's `.bind`, states it as a step too, or every question but
  // `comesTo` misses it.
  rule(
    "hop",
    [v("x"), v("y"), VALUE_STEP],
    [lit("nameHop", v("x"), v("y"))],
    NAME_HOP_RULE,
  ),

  // An import steps to what the module exports under that name. It is
  // not a name hop, because the call-origin chains stop at the import.
  rule(
    "hop",
    [v("x"), v("value"), VALUE_STEP],
    [
      lit("imports", v("x"), v("m"), v("n")),
      lit("moduleExport", v("m"), v("n"), v("value")),
    ],
    "import",
  ),

  // A parameter steps to what a call passes it. A function called from
  // several places leaves its parameter with more than one value, and a
  // caller that needs those apart asks `paramAt`.
  rule(
    "stepsTo",
    [v("p"), v("a"), VALUE_STEP],
    [lit("passesArgument", v("r"), v("p"), v("a"))],
    "argument",
  ),

  // Reading a property steps to what the object contains under that
  // name, whichever way the object arrived: `routes.list` off a name,
  // or `make(body).handle` off a call.
  rule(
    "stepsTo",
    [v("x"), v("held"), VALUE_STEP],
    [
      lit("readsProperty", v("x"), v("o"), v("n")),
      lit("objectOf", v("o"), v("obj")),
      lit("contains", v("obj"), v("n"), v("held")),
    ],
    "property read",
  ),

  // Calling a class makes one of it, so the call steps to the class and
  // a method read off the result is the one the class declares. The
  // caveat below is about a factory function, and a class is not one.
  rule(
    "hop",
    [v("r"), v("cls"), INSTANCE_STEP],
    [
      lit("call", v("r"), v("c")),
      lit("comesTo", v("c"), v("cls")),
      lit("objectValue", v("cls")),
    ],
    "class instance",
  ),

  // The receiver a method is called on. Being one of a class is the
  // same hop a construction takes, so a method read off `self` finds
  // what the class declares.
  rule(
    "hop",
    [v("x"), v("cls"), INSTANCE_STEP],
    [lit("instanceOf", v("x"), v("cls"))],
    "receiver instance",
  ),

  // A finder the library declares, keyed on the base a pack named so a
  // project class with a method of the same name on another hierarchy is
  // left alone. The DESIGN says what a chain of them composes into.
  rule(
    "hop",
    [v("r"), v("cls"), INSTANCE_STEP],
    [
      lit("call", v("r"), v("c")),
      lit("readsProperty", v("c"), v("o"), v("m")),
      lit("objectOf", v("o"), v("cls")),
      lit("objectValue", v("cls")),
      // Before `libraryBase`, so the demand rewrite asks it with the base
      // bound and walks an ancestry only for a method a pack declared.
      lit("givesBackOne", v("n"), v("m")),
      lit("libraryBase", v("cls"), v("n")),
    ],
    "declared finder",
  ),

  // The same word, for a library that takes the class as an argument
  // instead of as the receiver. The argument having to reach the base a
  // pack named is what keeps an unrelated `get` out.
  rule(
    "hop",
    [v("r"), v("cls"), INSTANCE_STEP],
    [
      lit("call", v("r"), v("c")),
      lit("readsProperty", v("c"), v("o"), v("m")),
      lit("callArg", v("r"), v("k"), v("a")),
      // Before `libraryBase`, so the demand rewrite asks it with the base
      // bound and walks an ancestry only for a method a pack declared.
      lit("givesBackOneOfArgument", v("n"), v("m"), v("k")),
      lit("objectOf", v("a"), v("cls")),
      lit("libraryBase", v("cls"), v("n")),
    ],
    "declared argument finder",
  ),

  // The same again for a function called on its own rather than read off
  // anything, keyed on the module it was imported from so a project
  // function spelled the same way is not mistaken for it.
  rule(
    "hop",
    [v("r"), v("cls"), INSTANCE_STEP],
    [
      lit("call", v("r"), v("c")),
      lit("comesFrom", v("c"), v("mod"), v("n")),
      lit("givesBackOneOfImport", v("mod"), v("n"), v("k")),
      lit("callArg", v("r"), v("k"), v("a")),
      lit("objectOf", v("a"), v("cls")),
    ],
    "declared import finder",
  ),

  // A block opened over a library's own constructor. The pack says
  // entering one gives back the object it built, so the name the block
  // opens is that call.
  rule(
    "hop",
    [v("y"), v("r"), VALUE_STEP],
    [
      lit("entersAs", v("y"), v("r")),
      lit("call", v("r"), v("c")),
      lit("comesFrom", v("c"), v("mod"), v("n")),
      lit("entersAsSelf", v("mod"), v("n")),
    ],
    "context manager returns self",
  ),

  // Wrapper transparency, derived: calling a factory that returns a
  // function which calls its parameter k steps to argument k.
  rule(
    "hop",
    [v("r"), v("a"), VALUE_STEP],
    [
      lit("call", v("r"), v("c")),
      lit("comesTo", v("c"), v("f")),
      lit("unwraps", v("f"), v("k")),
      lit("callArg", v("r"), v("k"), v("a")),
    ],
    "factory unwrap",
  ),

  // Wrapper transparency, declared: a pack says module m's n hands back
  // argument k. DESIGN.md says why the argument has to describe a value.
  rule(
    "hop",
    [v("r"), v("a"), VALUE_STEP],
    [
      lit("call", v("r"), v("c")),
      lit("comesFrom", v("c"), v("m"), v("n")),
      lit("unwrapsByName", v("m"), v("n"), v("k")),
      lit("callArg", v("r"), v("k"), v("a")),
      lit("describesValue", v("a")),
    ],
    "declared wrapper",
  ),
  // Every value but an object written with nothing in it. The demand
  // rewrite refuses negation, so each kind of value gets a rule.
  ...[
    lit("func", v("a")),
    lit("writtenValue", v("a")),
    lit("holdsProperty", v("a"), v("p"), v("x")),
    lit("imports", v("a"), v("m"), v("n")),
    lit("stepsTo", v("a"), v("y"), v("kind")),
  ].map((kind) => rule("describesValue", [v("a")], [kind])),

  // The one step that runs a function forwards: a call steps to what
  // the function it invokes returns.
  rule(
    "hop",
    [v("r"), v("ret"), RESULT_STEP],
    [lit("invokes", v("r"), v("f")), lit("returnsValue", v("f"), v("ret"))],
    "call result",
  ),

  // What a function says it gives back when its body never states a
  // value. The adapter stays quiet about the annotation whenever the
  // body does state one, so the two never answer the same question.
  rule(
    "hop",
    [v("r"), v("cls"), RESULT_STEP],
    [
      lit("invokes", v("r"), v("f")),
      lit("returnsClass", v("f"), v("x")),
      lit("comesTo", v("x"), v("cls")),
      lit("objectValue", v("cls")),
    ],
    "declared return type",
  ),

  // Where a walk gets to, under the strongest step it took: value, then
  // instance, then result. The walk so far comes first, so demand stays
  // on the value asked about; the README says what the other order cost.
  rule(
    "reaches",
    [v("x"), v("z"), v("kind")],
    [lit("stepsTo", v("x"), v("z"), v("kind"))],
  ),
  // A rule per pair rather than one leaving the next step's kind free. A
  // free kind is a second question about the same relation, and a
  // demand-driven run then derives both to answer either.
  ...STEP_LATTICE.map(({ soFar, next, took }) =>
    rule(
      "reaches",
      [v("x"), v("z"), took],
      [
        lit("reaches", v("x"), v("y"), soFar),
        lit("stepsTo", v("y"), v("z"), next),
      ],
    ),
  ),

  // A context is an allocation site, or nothing at all for a value read
  // outside every site. Both are stated, so a rule that starts a walk
  // binds its context from a premise rather than from a negation.
  rule("context", [NO_CONTEXT], [], "no context"),
  rule(
    "context",
    [v("site")],
    [lit("allocates", v("site"), v("cls"))],
    "site context",
  ),

  // The same closure, with the context the walk started under and the
  // context it arrived under. It takes `hop`, because an argument and a
  // property read have their own rules below.
  rule(
    "reachesUnder",
    [v("x"), v("c"), v("z"), v("c"), v("kind")],
    [lit("context", v("c")), lit("hop", v("x"), v("z"), v("kind"))],
    "under one hop",
  ),
  ...STEP_LATTICE.map(({ soFar, next, took }) =>
    rule(
      "reachesUnder",
      [v("x"), v("c"), v("z"), v("c2"), took],
      [
        lit("reachesUnder", v("x"), v("c"), v("y"), v("c2"), soFar),
        lit("hop", v("y"), v("z"), next),
      ],
    ),
  ),

  // The receiver read under a site is that site. The ordinary hop from a
  // receiver to its class stays in `hop`, so `self` under any context
  // still comes to the class a single-answer reader wants.
  rule(
    "reachesUnder",
    [v("x"), v("c"), v("c"), v("c"), VALUE_STEP],
    [lit("instanceOf", v("x"), v("cls")), lit("allocates", v("c"), v("cls"))],
    "receiver is the site",
  ),
  rule(
    "reachesUnder",
    [v("x"), v("c"), v("c2"), v("c2"), v("kind")],
    [
      lit("reachesUnder", v("x"), v("c"), v("y"), v("c2"), v("kind")),
      lit("instanceOf", v("y"), v("cls")),
      lit("allocates", v("c2"), v("cls")),
    ],
    "reached receiver is the site",
  ),

  // The object an expression refers to under a context. A site is an
  // answer here, unlike `objectOf`, and the class an instance is one of
  // is an answer only under no context.
  rule(
    "objectOfUnder",
    [v("site"), v("c"), v("site")],
    [lit("context", v("c")), lit("allocates", v("site"), v("cls"))],
    "site is its own object",
  ),
  rule(
    "objectOfUnder",
    [v("o"), v("c"), v("site")],
    [
      lit("reachesUnder", v("o"), v("c"), v("site"), v("c2"), VALUE_STEP),
      lit("allocates", v("site"), v("cls")),
    ],
    "name of a site",
  ),
  rule(
    "objectOfUnder",
    [v("o"), v("c"), v("obj")],
    [
      lit("reachesUnder", v("o"), v("c"), v("obj"), v("c2"), VALUE_STEP),
      lit("objectValue", v("obj")),
    ],
    "written object under a context",
  ),
  rule(
    "objectOfUnder",
    [v("o"), v("c"), v("obj")],
    [
      lit("reachesUnder", v("o"), v("c"), v("obj"), v("c2"), RESULT_STEP),
      lit("objectValue", v("obj")),
    ],
    "returned object under a context",
  ),
  rule(
    "objectOfUnder",
    [v("o"), NO_CONTEXT, v("cls")],
    [
      lit(
        "reachesUnder",
        v("o"),
        NO_CONTEXT,
        v("cls"),
        NO_CONTEXT,
        INSTANCE_STEP,
      ),
      lit("objectValue", v("cls")),
    ],
    "class reached with no context",
  ),
  rule(
    "objectOfUnder",
    [v("o"), NO_CONTEXT, v("cls")],
    [lit("instanceOf", v("o"), v("cls"))],
    "receiver class with no context",
  ),
  rule(
    "objectOfUnder",
    [v("o"), v("c"), v("o")],
    [lit("context", v("c")), lit("objectValue", v("o"))],
    "object under a context is itself",
  ),

  // A property read goes on under the site the object was made at, so a
  // field read off two constructions gives each one its own value. A
  // class or a literal object keeps the context the walk was already in.
  rule(
    "reachesUnder",
    [v("x"), v("c"), v("held"), v("site"), VALUE_STEP],
    [
      lit("context", v("c")),
      lit("readsProperty", v("x"), v("o"), v("n")),
      lit("objectOfUnder", v("o"), v("c"), v("site")),
      lit("allocates", v("site"), v("cls")),
      lit("contains", v("site"), v("n"), v("held")),
    ],
    "property read at a site",
  ),
  rule(
    "reachesUnder",
    [v("x"), v("c"), v("held"), v("c"), VALUE_STEP],
    [
      lit("context", v("c")),
      lit("readsProperty", v("x"), v("o"), v("n")),
      lit("objectOfUnder", v("o"), v("c"), v("obj")),
      lit("objectValue", v("obj")),
      lit("contains", v("obj"), v("n"), v("held")),
    ],
    "property read off an object",
  ),
  rule(
    "reachesUnder",
    [v("x"), v("c"), v("held"), v("site"), v("kind")],
    [
      lit("reachesUnder", v("x"), v("c"), v("y"), v("c2"), v("kind")),
      lit("readsProperty", v("y"), v("o"), v("n")),
      lit("objectOfUnder", v("o"), v("c2"), v("site")),
      lit("allocates", v("site"), v("cls")),
      lit("contains", v("site"), v("n"), v("held")),
    ],
    "reached property read at a site",
  ),
  rule(
    "reachesUnder",
    [v("x"), v("c"), v("held"), v("c2"), v("kind")],
    [
      lit("reachesUnder", v("x"), v("c"), v("y"), v("c2"), v("kind")),
      lit("readsProperty", v("y"), v("o"), v("n")),
      lit("objectOfUnder", v("o"), v("c2"), v("obj")),
      lit("objectValue", v("obj")),
      lit("contains", v("obj"), v("n"), v("held")),
    ],
    "reached property read off an object",
  ),

  // A parameter goes on at the argument, under the context its caller
  // was read in, and only from the calls that run the function under the
  // context the walk is in. This is the one hop that changes context.
  rule(
    "reachesUnder",
    [v("p"), v("c"), v("a"), v("c3"), VALUE_STEP],
    [
      lit("context", v("c")),
      lit("paramOf", v("f"), v("i"), v("p")),
      lit("entersUnder", v("r"), v("f"), v("c"), v("c3")),
      lit("callArg", v("r"), v("i"), v("a")),
    ],
    "argument under a context",
  ),
  rule(
    "reachesUnder",
    [v("p"), v("c"), v("a"), v("c3"), VALUE_STEP],
    [
      lit("context", v("c")),
      lit("paramNamed", v("f"), v("n"), v("p")),
      lit("entersUnder", v("r"), v("f"), v("c"), v("c3")),
      lit("callKeywordArg", v("r"), v("n"), v("a")),
    ],
    "keyword argument under a context",
  ),
  rule(
    "reachesUnder",
    [v("x"), v("c"), v("a"), v("c3"), v("kind")],
    [
      lit("reachesUnder", v("x"), v("c"), v("p"), v("c2"), v("kind")),
      lit("paramOf", v("f"), v("i"), v("p")),
      lit("entersUnder", v("r"), v("f"), v("c2"), v("c3")),
      lit("callArg", v("r"), v("i"), v("a")),
    ],
    "reached argument under a context",
  ),
  rule(
    "reachesUnder",
    [v("x"), v("c"), v("a"), v("c3"), v("kind")],
    [
      lit("reachesUnder", v("x"), v("c"), v("p"), v("c2"), v("kind")),
      lit("paramNamed", v("f"), v("n"), v("p")),
      lit("entersUnder", v("r"), v("f"), v("c2"), v("c3")),
      lit("callKeywordArg", v("r"), v("n"), v("a")),
    ],
    "reached keyword argument under a context",
  ),

  // Which call runs which function under which context. A construction
  // runs its constructor under the site it makes, a method call runs
  // under the site its receiver is, and anything else under no context.
  rule(
    "entersUnder",
    [v("site"), v("ctor"), v("site"), v("caller")],
    [
      lit("allocates", v("site"), v("cls")),
      lit("runsConstructor", v("cls"), v("ctor")),
      lit("callUnder", v("site"), v("caller")),
    ],
    "construction enters its constructor",
  ),
  rule(
    "entersUnder",
    [v("r"), v("f"), v("site"), v("caller")],
    [
      lit("call", v("r"), v("cal")),
      lit("readsProperty", v("cal"), v("o"), v("m")),
      lit("objectOfUnder", v("o"), v("caller"), v("site")),
      lit("allocates", v("site"), v("cls")),
      lit("contains", v("site"), v("m"), v("f")),
      lit("callUnder", v("r"), v("caller")),
    ],
    "method call enters under its receiver",
  ),
  // A call written as a name runs with whatever receiver the body
  // around it has, so a plain function called from a method keeps the
  // site rather than taking every caller of it.
  rule(
    "entersUnder",
    [v("r"), v("f"), v("c"), v("c")],
    [
      lit("context", v("c")),
      lit("callsNamed", v("r"), v("f")),
      lit("callUnder", v("r"), v("c")),
    ],
    "named call enters under the site it is made in",
  ),
  rule(
    "entersUnder",
    [v("r"), v("f"), NO_CONTEXT, v("caller")],
    [
      lit("callsFunction", v("r"), v("f")),
      lit("callUnder", v("r"), v("caller")),
    ],
    "call enters with no context",
  ),

  // The constructor a construction runs, the ancestry included, so a
  // subclass that declares none still fills in what it inherits.
  rule(
    "runsConstructor",
    [v("cls"), v("f")],
    [lit("initializes", v("cls"), v("f"))],
  ),
  rule(
    "runsConstructor",
    [v("cls"), v("f")],
    [
      lit("extends", v("cls"), v("b")),
      lit("comesTo", v("b"), v("base")),
      lit("runsConstructor", v("base"), v("f")),
    ],
  ),

  // Which body a call is written in, a closure's calls included. Joining
  // `bodyCalls` on the callee would put every call of a bare name in
  // Python or Ruby in every body that calls that name.
  rule("callInBody", [v("f"), v("r")], [lit("makesCall", v("f"), v("r"))]),
  rule(
    "callInBody",
    [v("f"), v("r")],
    [lit("containsFn", v("f"), v("g")), lit("callInBody", v("g"), v("r"))],
  ),

  // The context a call is made under: every site of the class whose
  // method or constructor it is written in, and no context for a call
  // outside every method body.
  rule(
    "callUnder",
    [v("r"), v("site")],
    [
      lit("callInBody", v("f"), v("r")),
      lit("holdsProperty", v("cls"), v("m"), v("f")),
      lit("allocates", v("site"), v("cls")),
    ],
    "call in a method",
  ),
  rule(
    "callUnder",
    [v("r"), v("site")],
    [
      lit("callInBody", v("f"), v("r")),
      lit("initializes", v("cls"), v("f")),
      lit("allocates", v("site"), v("cls")),
    ],
    "call in a constructor",
  ),
  // A plain function entered under a site makes its own calls under
  // that site, so a chain of plain functions off one method keeps it.
  rule(
    "callUnder",
    [v("r"), v("c")],
    [
      lit("callOutsideMethod", v("r")),
      lit("callInBody", v("f"), v("r")),
      lit("entersUnder", v("into"), v("f"), v("c"), v("c4")),
    ],
    "call in a function entered under a site",
  ),
  rule(
    "callUnder",
    [v("r"), NO_CONTEXT],
    [lit("callOutsideMethod", v("r"))],
    "call outside every method",
  ),

  // The two questions a caller puts under a context, stopping where
  // `isWrittenAs` and `comesTo` stop, whatever context the walk ended in.
  rule(
    "isWrittenAsUnder",
    [v("x"), v("c"), v("x")],
    [lit("context", v("c")), lit("writtenValue", v("x"))],
  ),
  rule(
    "isWrittenAsUnder",
    [v("x"), v("c"), v("x")],
    [lit("context", v("c")), lit("objectValue", v("x"))],
  ),
  rule(
    "isWrittenAsUnder",
    [v("x"), v("c"), v("z")],
    [
      lit("reachesUnder", v("x"), v("c"), v("z"), v("c2"), VALUE_STEP),
      lit("writtenValue", v("z")),
    ],
  ),
  rule(
    "isWrittenAsUnder",
    [v("x"), v("c"), v("z")],
    [
      lit("reachesUnder", v("x"), v("c"), v("z"), v("c2"), VALUE_STEP),
      lit("objectValue", v("z")),
    ],
  ),
  rule(
    "comesToUnder",
    [v("x"), v("c"), v("x")],
    [lit("context", v("c")), lit("func", v("x"))],
  ),
  rule(
    "comesToUnder",
    [v("x"), v("c"), v("x")],
    [lit("context", v("c")), lit("objectValue", v("x"))],
  ),
  rule(
    "comesToUnder",
    [v("x"), v("c"), v("z")],
    [
      lit("reachesUnder", v("x"), v("c"), v("z"), v("c2"), VALUE_STEP),
      lit("func", v("z")),
    ],
  ),
  rule(
    "comesToUnder",
    [v("x"), v("c"), v("z")],
    [
      lit("reachesUnder", v("x"), v("c"), v("z"), v("c2"), VALUE_STEP),
      lit("objectValue", v("z")),
    ],
  ),
  rule(
    "comesToUnder",
    [v("x"), v("c"), v("z")],
    [
      lit("reachesUnder", v("x"), v("c"), v("z"), v("c2"), INSTANCE_STEP),
      lit("func", v("z")),
    ],
  ),
  rule(
    "comesToUnder",
    [v("x"), v("c"), v("z")],
    [
      lit("reachesUnder", v("x"), v("c"), v("z"), v("c2"), INSTANCE_STEP),
      lit("objectValue", v("z")),
    ],
  ),

  // What a value comes down to: the walk that never ran a call, stopped
  // at a function or an object. Something already written out comes to
  // itself, and every other walk ends at one of those.
  rule("comesTo", [v("x"), v("x")], [lit("func", v("x"))]),
  rule("comesTo", [v("x"), v("x")], [lit("objectValue", v("x"))]),
  rule(
    "comesTo",
    [v("x"), v("z")],
    [lit("reaches", v("x"), v("z"), VALUE_STEP), lit("func", v("z"))],
  ),
  rule(
    "comesTo",
    [v("x"), v("z")],
    [lit("reaches", v("x"), v("z"), VALUE_STEP), lit("objectValue", v("z"))],
  ),
  // An instance walk stops the same way, so a method read off
  // `new App()` still finds what the class declares.
  rule(
    "comesTo",
    [v("x"), v("z")],
    [lit("reaches", v("x"), v("z"), INSTANCE_STEP), lit("func", v("z"))],
  ),
  rule(
    "comesTo",
    [v("x"), v("z")],
    [lit("reaches", v("x"), v("z"), INSTANCE_STEP), lit("objectValue", v("z"))],
  ),

  // The same stopping condition, for the walk that ran a call. A call
  // gets no `comesTo` answer on purpose: coming back with what a
  // factory returned would fight the unwrapping answer.
  rule(
    "givesBack",
    [v("x"), v("z")],
    [lit("reaches", v("x"), v("z"), RESULT_STEP), lit("func", v("z"))],
  ),
  rule(
    "givesBack",
    [v("x"), v("z")],
    [lit("reaches", v("x"), v("z"), RESULT_STEP), lit("objectValue", v("z"))],
  ),

  // `(c) => asyncHandler(fn)` gives back the wrapper's own closure and
  // the fn it unwraps. This is the unwrapped one, which a caller prefers
  // for the same reason `comesTo` wins over `givesBack` on the call.
  rule(
    "givesBackUnwrapped",
    [v("x"), v("z")],
    [
      lit("reaches", v("x"), v("r"), RESULT_STEP),
      lit("call", v("r"), v("c")),
      lit("comesTo", v("r"), v("z")),
      lit("func", v("z")),
    ],
  ),

  // Following a value to the expression it is written as, whatever kind
  // that is. A GraphQL document is neither a function nor an object, so
  // `comesTo` never reaches one.
  rule("isWrittenAs", [v("x"), v("x")], [lit("writtenValue", v("x"))]),
  rule("isWrittenAs", [v("x"), v("x")], [lit("objectValue", v("x"))]),
  rule(
    "isWrittenAs",
    [v("x"), v("z")],
    [lit("reaches", v("x"), v("z"), VALUE_STEP), lit("writtenValue", v("z"))],
  ),
  rule(
    "isWrittenAs",
    [v("x"), v("z")],
    [lit("reaches", v("x"), v("z"), VALUE_STEP), lit("objectValue", v("z"))],
  ),

  // A call is written as whatever its callee's return value is written
  // as. Unlike `comesTo`, this has nothing to protect: which expression
  // a value was written as does not compete with unwrapping it.
  rule(
    "isWrittenAs",
    [v("x"), v("z")],
    [
      lit("invokes", v("x"), v("f")),
      lit("returnsValue", v("f"), v("ret")),
      lit("isWrittenAs", v("ret"), v("z")),
    ],
  ),

  // The fallbacks, `a || b`, a value passes on the way to what it is
  // written as. A reader of values takes one whole when every answer came
  // through it, so the reader's own `||` decides which branches count.
  rule(
    "fallbackBehind",
    [v("x"), v("x")],
    [lit("fallbackBranch", v("x"), v("b"))],
  ),
  rule(
    "fallbackBehind",
    [v("x"), v("f")],
    [
      lit("reaches", v("x"), v("f"), VALUE_STEP),
      lit("fallbackBranch", v("f"), v("b")),
    ],
  ),
  rule(
    "fallbackBehind",
    [v("x"), v("f")],
    [
      lit("invokes", v("x"), v("g")),
      lit("returnsValue", v("g"), v("ret")),
      lit("fallbackBehind", v("ret"), v("f")),
    ],
  ),

  // Which expression running f hands back, whether f returns it, writes
  // it into a name first, or ends on it as a shorthand body.
  rule(
    "returnsCall",
    [v("f"), v("c")],
    [lit("returnsValue", v("f"), v("v")), lit("isWrittenAs", v("v"), v("c"))],
  ),

  // What one call site put in a parameter, told apart from what the
  // other callers passed.
  rule(
    "paramAt",
    [v("r"), v("p"), v("z")],
    [
      lit("passesArgument", v("r"), v("p"), v("a")),
      lit("comesTo", v("a"), v("z")),
    ],
  ),

  // An argument arriving at the parameter it is passed to, by position
  // or by the name the caller wrote, keeping the call it went through
  // so `paramAt` can tell two call sites apart.
  rule(
    "passesArgument",
    [v("r"), v("p"), v("a")],
    [
      lit("paramOf", v("f"), v("k"), v("p")),
      lit("callsFunction", v("r"), v("f")),
      lit("callArg", v("r"), v("k"), v("a")),
    ],
  ),
  rule(
    "passesArgument",
    [v("r"), v("p"), v("a")],
    [
      lit("paramNamed", v("f"), v("n"), v("p")),
      lit("callsFunction", v("r"), v("f")),
      lit("callKeywordArg", v("r"), v("n"), v("a")),
    ],
  ),

  // The expressions that refer to a parameter under another name. An
  // adapter may key a read of the parameter as the parameter itself,
  // or as its own node linked by binds; both arrive here.
  rule(
    "refersToParam",
    [v("p"), v("p")],
    [lit("paramOf", v("f"), v("k"), v("p"))],
  ),
  rule(
    "refersToParam",
    [v("p"), v("p")],
    [lit("paramNamed", v("f"), v("n"), v("p"))],
  ),
  // No import step, since no module exports a parameter.
  rule(
    "refersToParam",
    [v("x"), v("p")],
    [lit("refersToParam", v("y"), v("p")), lit("nameHop", v("x"), v("y"))],
  ),

  // An expression whose value is the environment object w: the way a
  // pack spells it, a name declared as that, or a parameter a caller
  // handed one of those to, however many calls deep.
  rule(
    "environmentValue",
    [v("w"), v("o")],
    [lit("environmentObject", v("w")), lit("refersToObject", v("o"), v("w"))],
  ),
  rule(
    "environmentValue",
    [v("w"), v("o")],
    [
      lit("environmentValue", v("w"), v("a")),
      lit("passesArgument", v("r"), v("p"), v("a")),
      lit("refersToParam", v("o"), v("p")),
    ],
  ),
  // A parameter that defaults to the environment, for the callers that
  // pass nothing. `loadConfig(env = process.env)` is written that way
  // so that most of the program never mentions the environment at all.
  rule(
    "environmentValue",
    [v("w"), v("o")],
    [
      lit("environmentValue", v("w"), v("d")),
      lit("paramDefault", v("p"), v("d")),
      lit("refersToParam", v("o"), v("p")),
    ],
  ),

  // Which environment object a keyed read takes its entry from. The
  // object comes first because a project writes a handful of those and
  // thousands of keyed reads, and the join starts at the small end.
  rule(
    "environmentRead",
    [v("w"), v("site"), v("x")],
    [
      lit("environmentValue", v("w"), v("o")),
      lit("readsKeyed", v("site"), v("o"), v("x")),
    ],
  ),
  rule(
    "readsEnvNamed",
    [v("site"), v("x")],
    [lit("environmentRead", v("w"), v("site"), v("x"))],
  ),

  // A parameter whose value is an environment variable's name: a read
  // site takes its name from it, or it is handed on to a parameter that
  // does. Asked from the site, so the recursion runs callee to caller.
  rule(
    "paramNamesEnv",
    [v("p"), v("site")],
    [
      lit("readsEnvNamed", v("site"), v("x")),
      lit("refersToParam", v("x"), v("p")),
    ],
  ),
  rule(
    "paramNamesEnv",
    [v("p"), v("site")],
    [
      lit("refersToParam", v("a"), v("p")),
      lit("passesArgument", v("r"), v("q"), v("a")),
      lit("paramNamesEnv", v("q"), v("site")),
    ],
  ),

  // The class some declaration says a value is one of: its own, or that of
  // anything the value steps to, a caller's argument included. Two callers
  // can disagree, so the asking side decides whether it got one.
  rule("typedAs", [v("x"), v("t")], [lit("instanceOf", v("x"), v("t"))]),
  rule(
    "typedAs",
    [v("x"), v("t")],
    [
      lit("reaches", v("x"), v("y"), VALUE_STEP),
      lit("instanceOf", v("y"), v("t")),
    ],
  ),

  // Which module's export a re-exported name forwards to, however
  // many barrels deep the forwarding runs.
  rule(
    "moduleForwards",
    [v("m"), v("n"), v("m2"), v("n2")],
    [lit("reExports", v("m"), v("n"), v("m2"), v("n2"))],
  ),
  rule(
    "moduleForwards",
    [v("m"), v("n"), v("m3"), v("n3")],
    [
      lit("reExports", v("m"), v("n"), v("m2"), v("n2")),
      lit("moduleForwards", v("m2"), v("n2"), v("m3"), v("n3")),
    ],
  ),

  // What a module exports: directly, or through re-export chains.
  rule(
    "moduleExport",
    [v("m"), v("n"), v("value")],
    [lit("exportsAs", v("m"), v("n"), v("value"))],
    "export",
  ),
  rule(
    "moduleExport",
    [v("m"), v("n"), v("value")],
    [
      lit("reExports", v("m"), v("n"), v("m2"), v("n2")),
      lit("moduleExport", v("m2"), v("n2"), v("value")),
    ],
    "re-export",
  ),
  rule(
    "moduleExport",
    [v("m"), v("n"), v("value")],
    [
      lit("reExportsAll", v("m"), v("m2")),
      lit("moduleExport", v("m2"), v("n"), v("value")),
    ],
    "re-export all",
  ),

  // The function a call runs, written from the call's side because a
  // caller asking what a call gives back has the call in hand.
  rule(
    "invokes",
    [v("r"), v("f")],
    [lit("call", v("r"), v("c")), lit("comesTo", v("c"), v("f"))],
  ),
  // The callee is itself a call: `daoBuilder()()`.
  rule(
    "invokes",
    [v("r"), v("f")],
    [lit("call", v("r"), v("c")), lit("givesBack", v("c"), v("f"))],
  ),

  // The object an expression refers to: a name through `comesTo`, a
  // factory call through what it gives back. Naming the step is what
  // makes `routes.list` and `make(body).handle` one rule.
  rule(
    "objectOf",
    [v("o"), v("obj")],
    [lit("comesTo", v("o"), v("obj")), lit("objectValue", v("obj"))],
  ),
  rule(
    "objectOf",
    [v("x"), v("obj")],
    [lit("givesBack", v("x"), v("obj")), lit("objectValue", v("obj"))],
  ),
  // A construction is the object it made, and so is any name for it.
  // The class stays an answer too, so an instance whose site is not in
  // the run still reads what the class stores.
  rule(
    "objectOf",
    [v("site"), v("site")],
    [lit("allocates", v("site"), v("c"))],
  ),
  rule(
    "objectOf",
    [v("o"), v("site")],
    [
      lit("reaches", v("o"), v("site"), VALUE_STEP),
      lit("allocates", v("site"), v("c")),
    ],
  ),
  // So is one a call hands back when it passes no arguments, as
  // `get_settings()` hands back `Settings()`, since only the construction
  // contains the field defaults its class declares.
  rule(
    "objectOf",
    [v("o"), v("site")],
    [
      lit("reaches", v("o"), v("site"), RESULT_STEP),
      lit("callArgCount", v("site"), NO_ARGUMENTS),
      lit("allocates", v("site"), v("c")),
    ],
  ),

  // Which calls a function, found by the name the call is written as
  // rather than by resolving every callee in the project. A caller knows
  // the function and wants its call sites, so both of these start from
  // the function. Starting from `call` instead asks what every call in
  // the project imports, which was 72% of everything derived.
  rule(
    "callsNamed",
    [v("r"), v("f")],
    [lit("binds", v("c"), v("f")), lit("call", v("r"), v("c"))],
  ),
  rule(
    "callsNamed",
    [v("r"), v("f")],
    [
      lit("moduleExport", v("m"), v("n"), v("f")),
      lit("imports", v("c"), v("m"), v("n")),
      lit("call", v("r"), v("c")),
    ],
  ),
  // The same, for a language whose adapter writes the import down as a
  // declaration and the call's callee as the name referring to it.
  rule(
    "callsNamed",
    [v("r"), v("f")],
    [
      lit("moduleExport", v("m"), v("n"), v("f")),
      lit("imports", v("d"), v("m"), v("n")),
      lit("binds", v("c"), v("d")),
      lit("call", v("r"), v("c")),
    ],
  ),
  // `const f = (x) => ...` declares the name and puts the parameters on
  // the arrow, so everything above arrives at the declaration and
  // `paramOf` is about the arrow. One binds hop joins the two.
  rule(
    "callsNamed",
    [v("r"), v("f")],
    [lit("binds", v("g"), v("f")), lit("callsNamed", v("r"), v("g"))],
  ),

  // Every one of those, and the binds hop again over the whole
  // relation, so a property holding a name for a function is reached
  // the way it was before the two were told apart.
  rule("callsFunction", [v("r"), v("f")], [lit("callsNamed", v("r"), v("f"))]),
  rule(
    "callsFunction",
    [v("r"), v("f")],
    [lit("binds", v("g"), v("f")), lit("callsFunction", v("r"), v("g"))],
  ),
  // A function written on an object, called off it: `client.get(o)`.
  // The receiver comes from the object through `refersToObject`, not from
  // `objectOf`: a walk from every reader of the name was most of a run.
  rule(
    "callsFunction",
    [v("r"), v("f")],
    [
      lit("holdsProperty", v("obj"), v("n"), v("f")),
      lit("refersToObject", v("o"), v("obj")),
      lit("readsProperty", v("c"), v("o"), v("n")),
      lit("call", v("r"), v("c")),
    ],
  ),
  // A name bound to a factory's result, called: `const get =
  // makeReader(env)` then `get(name)`. Written from the factory's call so
  // the walk starts where `callsFunction` already has an answer.
  rule(
    "callsFunction",
    [v("r"), v("f")],
    [
      lit("returnsValue", v("g"), v("f")),
      lit("callsFunction", v("r0"), v("g")),
      lit("callsNamed", v("r"), v("r0")),
    ],
  ),

  // The expressions that refer to an object under another name, through
  // a name hop or an import. Asked from the object, so it visits only
  // them.
  rule("refersToObject", [v("obj"), v("obj")], [lit("objectValue", v("obj"))]),
  // The process environment is an object nothing declares, so a pack
  // saying which expression spells it is the only way in.
  rule("refersToObject", [v("w"), v("w")], [lit("environmentObject", v("w"))]),
  rule(
    "refersToObject",
    [v("x"), v("obj")],
    [lit("refersToObject", v("y"), v("obj")), lit("nameHop", v("x"), v("y"))],
  ),
  rule(
    "refersToObject",
    [v("x"), v("obj")],
    [
      lit("refersToObject", v("y"), v("obj")),
      lit("moduleExport", v("m"), v("n"), v("y")),
      lit("imports", v("x"), v("m"), v("n")),
    ],
  ),

  // What an object contains, its base class included, so a method the base
  // declares is found on a subclass that never overrode it. A method both
  // declare gives two, and the caller decides. This is its own relation
  // rather than more `holdsProperty`, which stays something an adapter
  // states and the rules only read.
  rule(
    "contains",
    [v("o"), v("n"), v("held")],
    [lit("holdsProperty", v("o"), v("n"), v("held"))],
  ),
  rule(
    "contains",
    [v("cls"), v("n"), v("held")],
    [
      lit("extends", v("cls"), v("base")),
      lit("comesTo", v("base"), v("baseCls")),
      lit("contains", v("baseCls"), v("n"), v("held")),
    ],
    BASE_CLASS_RULE,
  ),
  // An association is read off an instance as a property, and stating
  // it as `contains` is what puts it on the ancestry rule, so a concern
  // or a base class can be the one that declares it.
  rule(
    "contains",
    [v("cls"), v("n"), v("t")],
    [lit("declaresAssociation", v("cls"), v("n"), v("t"))],
    "declared association",
  ),
  // The same, for a language that buries the declaration in an ordinary
  // assignment. Keying on the module the callable came from is what
  // keeps a project function spelled the same way out.
  rule(
    "contains",
    [v("cls"), v("n"), v("t")],
    [
      lit("fieldCall", v("cls"), v("n"), v("c"), v("t")),
      lit("comesFrom", v("c"), v("m"), v("name")),
      lit("associationConstructor", v("m"), v("name")),
    ],
    "constructed association",
  ),
  // What the constructor put on the receiver. The class is the object
  // for an instance whose own site is not in the run.
  rule(
    "contains",
    [v("cls"), v("n"), v("held")],
    [
      lit("initializes", v("cls"), v("f")),
      lit("storesProperty", v("f"), v("n"), v("held")),
    ],
    "constructor store",
  ),
  // What any other method of the class put there. Two methods writing
  // one name give two rows, since nothing here orders them.
  rule(
    "contains",
    [v("cls"), v("n"), v("held")],
    [
      lit("holdsProperty", v("cls"), v("m"), v("f")),
      lit("storesProperty", v("f"), v("n"), v("held")),
    ],
    "method store",
  ),
  // A write through a name rather than through the receiver,
  // `client.timeout = 5`, which lands on whatever that name refers to.
  rule(
    "contains",
    [v("obj"), v("n"), v("held")],
    [
      lit("storesProperty", v("r"), v("n"), v("held")),
      lit("objectOf", v("r"), v("obj")),
    ],
    "named receiver store",
  ),

  // A member a class declares itself under a name one of its bases also
  // contains. `contains` keeps both, and a caller that needs one answer
  // prefers the member declared nearer the object the read went through.
  rule(
    "overrides",
    [v("m"), v("n"), v("h")],
    [
      lit("holdsProperty", v("c"), v("n"), v("m")),
      lit("extends", v("c"), v("b")),
      lit("comesTo", v("b"), v("base")),
      lit("contains", v("base"), v("n"), v("h")),
    ],
  ),
  // The objects a read reads a name off, and on each one the members the
  // read finds that another member there overrides.
  rule(
    "readsFrom",
    [v("x"), v("obj"), v("n")],
    [
      lit("readsProperty", v("x"), v("o"), v("n")),
      lit("objectOf", v("o"), v("obj")),
    ],
  ),
  rule(
    "readsOverridden",
    [v("x"), v("obj"), v("h")],
    [
      lit("readsFrom", v("x"), v("obj"), v("n")),
      lit("contains", v("obj"), v("n"), v("m")),
      lit("overrides", v("m"), v("n"), v("h")),
    ],
  ),
  // Every member, for a read with an override, so `contains` is asked with
  // the object and name bound, the way the property read already asks it.
  rule(
    "readsMemberOn",
    [v("x"), v("obj"), v("h")],
    [
      lit("readsOverridden", v("x"), v("shadowing"), v("overridden")),
      lit("readsFrom", v("x"), v("obj"), v("n")),
      lit("contains", v("obj"), v("n"), v("h")),
    ],
  ),

  // A call written with a class's own name, which is how most languages
  // spell a construction. A language that spells one some other way
  // states its own rule for this, the way Ruby does for `Const.new`.
  rule(
    "constructsNamed",
    [v("r"), v("cls")],
    [lit("objectValue", v("cls")), lit("callsNamed", v("r"), v("cls"))],
  ),

  // Each construction is an object of its own containing what its
  // class stores, so two sites are two objects.
  rule(
    "contains",
    [v("site"), v("n"), v("held")],
    [
      lit("allocates", v("site"), v("cls")),
      lit("contains", v("cls"), v("n"), v("held")),
    ],
    "allocated instance",
  ),
  // A construction written with no arguments keeps every field default its
  // class declares. Any argument could fill a field through a constructor
  // the run cannot see, and a finder's result was built somewhere else.
  rule(
    "contains",
    [v("site"), v("n"), v("held")],
    [
      lit("callArgCount", v("site"), NO_ARGUMENTS),
      lit("call", v("site"), v("c")),
      lit("comesTo", v("c"), v("cls")),
      lit("objectValue", v("cls")),
      lit("fieldDefault", v("cls"), v("n"), v("held")),
    ],
    "construction with no arguments",
  ),

  // A field default, its base class's included. It stays out of `contains`,
  // which every instance reads, because a constructor may replace it.
  rule(
    "fieldDefault",
    [v("cls"), v("n"), v("held")],
    [lit("holdsDefault", v("cls"), v("n"), v("held"))],
  ),
  rule(
    "fieldDefault",
    [v("cls"), v("n"), v("held")],
    [
      lit("extends", v("cls"), v("base")),
      lit("comesTo", v("base"), v("baseCls")),
      lit("fieldDefault", v("baseCls"), v("n"), v("held")),
    ],
    BASE_CLASS_RULE,
  ),

  // A call that makes one of a class. Every finder a pack declared is
  // one too, so `User.find(1)` is a site the same way `User.new` is.
  rule(
    "allocates",
    [v("site"), v("cls")],
    [
      lit("call", v("site"), v("c")),
      lit("stepsTo", v("site"), v("cls"), INSTANCE_STEP),
    ],
    "allocation site",
  ),

  // The library base a class's ancestry arrives at, however many of a
  // project's own classes sit in between. A base the run declares has a
  // node to keep walking from; one it does not has only a name.
  rule("libraryBase", [v("c"), v("n")], [lit("extendsNamed", v("c"), v("n"))]),
  rule(
    "libraryBase",
    [v("c"), v("n")],
    [
      lit("extends", v("c"), v("x")),
      lit("comesTo", v("x"), v("b")),
      lit("libraryBase", v("b"), v("n")),
    ],
  ),
  // A base a library hands back from a call rather than exporting as a
  // class, SQLAlchemy's `Base = declarative_base()`. The walk stops at
  // the call, so the function it called is the name to match on.
  rule(
    "libraryBase",
    [v("c"), v("n")],
    [
      lit("extends", v("c"), v("x")),
      lit("isWrittenAs", v("x"), v("r")),
      lit("call", v("r"), v("cc")),
      lit("comesFrom", v("cc"), v("m"), v("n")),
    ],
  ),

  // Which function a factory returns, and which of its parameters that
  // function calls: together they are what makes it a wrapper.
  rule(
    "returnsFunc",
    [v("f"), v("g")],
    [
      lit("returnsValue", v("f"), v("value")),
      lit("comesTo", v("value"), v("g")),
      lit("func", v("g")),
    ],
  ),
  // A call made by a nested closure counts as made by the function
  // that declares it; the closure runs as part of that function.
  rule("bodyCallsDeep", [v("f"), v("c")], [lit("bodyCalls", v("f"), v("c"))]),
  rule(
    "bodyCallsDeep",
    [v("f"), v("c")],
    [lit("containsFn", v("f"), v("g")), lit("bodyCallsDeep", v("g"), v("c"))],
  ),
  rule(
    "unwraps",
    [v("f"), v("k")],
    [
      lit("returnsFunc", v("f"), v("g")),
      lit("bodyCallsDeep", v("g"), v("c")),
      lit("refersToParam", v("c"), v("p")),
      lit("paramOf", v("f"), v("k"), v("p")),
    ],
  ),

  // Which parameter a value traces back to: the parameter under any name,
  // or a call passing it to another factory that unwraps, which is how
  // `createProtected(h) { return service.withAuth(h); }` unwraps.
  rule(
    "flowsToParam",
    [v("x"), v("p")],
    [lit("refersToParam", v("x"), v("p"))],
  ),
  rule(
    "flowsToParam",
    [v("r"), v("p")],
    [
      lit("call", v("r"), v("c")),
      lit("comesTo", v("c"), v("f")),
      lit("unwraps", v("f"), v("k")),
      lit("callArg", v("r"), v("k"), v("a")),
      lit("flowsToParam", v("a"), v("p")),
    ],
  ),
  rule(
    "unwraps",
    [v("f"), v("k")],
    [
      lit("returnsValue", v("f"), v("value")),
      lit("flowsToParam", v("value"), v("p")),
      lit("paramOf", v("f"), v("k"), v("p")),
    ],
  ),
  // Where a name comes from, when what it refers to lives outside the
  // source being read. A walk ends at what the source writes out, so it
  // never reaches a library's own function; these rules do.
  rule(
    "comesFrom",
    [v("x"), v("m"), v("n")],
    [lit("imports", v("x"), v("m"), v("n"))],
  ),
  rule(
    "comesFrom",
    [v("x"), v("m"), v("n")],
    [
      lit("reaches", v("x"), v("y"), VALUE_STEP),
      lit("imports", v("y"), v("m"), v("n")),
    ],
  ),
  // A member read off a whole-module import: the member's own name is
  // what the module exports, so `fastapi.APIRouter` comes from
  // fastapi's `APIRouter`. Directly, or through a name for the module.
  rule(
    "comesFrom",
    [v("x"), v("m"), v("n")],
    [
      lit("readsProperty", v("x"), v("ns"), v("n")),
      lit("imports", v("ns"), v("m"), NAMESPACE_IMPORT),
    ],
    NAMESPACE_MEMBER_RULE,
  ),
  rule(
    "comesFrom",
    [v("x"), v("m"), v("n")],
    [
      lit("readsProperty", v("x"), v("o"), v("n")),
      lit("reaches", v("o"), v("ns"), VALUE_STEP),
      lit("imports", v("ns"), v("m"), NAMESPACE_IMPORT),
    ],
    NAMESPACE_MEMBER_RULE,
  ),
  // A CommonJS module hands its exports over as the default, so after
  // `import React from "react"`, `React.memo` is react's `memo`.
  rule(
    "comesFrom",
    [v("x"), v("m"), v("n")],
    [
      lit("readsProperty", v("x"), v("o"), v("n")),
      lit("reaches", v("o"), v("d"), VALUE_STEP),
      lit("imports", v("d"), v("m"), DEFAULT_IMPORT),
    ],
    NAMESPACE_MEMBER_RULE,
  ),

  // Calling f ends up calling the name n that module m exports, one
  // hop through f's own body or deeper through a wrapper of a wrapper.
  // Several results is normal: a composed decorator applies them all.
  rule(
    "callsInto",
    [v("f"), v("m"), v("n")],
    [
      lit("bodyCallsDeep", v("f"), v("c")),
      lit("comesFrom", v("c"), v("m"), v("n")),
    ],
  ),
  rule(
    "callsInto",
    [v("f"), v("m"), v("n")],
    [
      lit("bodyCallsDeep", v("f"), v("c")),
      lit("comesTo", v("c"), v("g")),
      lit("callsInto", v("g"), v("m"), v("n")),
    ],
  ),

  // The question callers ask: what a value comes to, narrowed to the
  // functions. Objects appear in the middle of chains and never in an
  // answer.
  rule(
    "resolves",
    [v("x"), v("z")],
    [lit("comesTo", v("x"), v("z")), lit("func", v("z"))],
  ),
];

/**
 * Rules with a `stepsTo` twin for each hop among them.
 *
 * `reaches` reads `stepsTo` and `reachesUnder` reads `hop`. A rule
 * passing one through to the other would look tidier and costs far
 * more: the demand for `stepsTo` is one of the largest relations a run
 * derives, and every row of it would be copied into a demand for `hop`
 * whether or not anybody asked about a context. A language that states
 * a hop of its own passes it through here for the same reason.
 */
export function alsoSteps(rules: readonly Rule[]): Rule[] {
  return [
    ...rules,
    ...rules
      .filter((r) => r.head.relation === "hop")
      .map((r) => ({ ...r, head: { ...r.head, relation: "stepsTo" } })),
  ];
}

export const RESOLUTION_RULES = alsoSteps(STATED_RULES);

/**
 * The questions a caller asks, written as rules. Two facts say somebody
 * is asking: `wanted(x)` for what a value is, and `wantedOrigin(x)` for
 * where a name came from. Each answer relation contains the pairs for the
 * values somebody asked about, keyed by the value asked about, which is
 * the key the caller looks up by anyway.
 *
 * Written down rather than left to each caller because the engine reads
 * them. `deriveOnDemand` follows a chain only as far as one of these
 * questions reaches it, and a caller that answered its own questions by
 * scanning a relation would give the engine nothing to work from.
 *
 * The two asking facts are kept apart because they pull on different
 * rules. Following a name back to its library goes through every call
 * the value's function makes, so a caller that only wants to know what a
 * handler resolves to should not pay for that.
 */
export const RESOLUTION_QUESTIONS = [
  rule(
    "wantedResolves",
    [v("x"), v("z")],
    [lit("wanted", v("x")), lit("resolves", v("x"), v("z"))],
  ),
  rule(
    "wantedComesTo",
    [v("x"), v("z")],
    [lit("wanted", v("x")), lit("comesTo", v("x"), v("z"))],
  ),
  rule(
    "wantedComesTo",
    [v("x"), v("z")],
    [lit("wantedOrigin", v("x")), lit("comesTo", v("x"), v("z"))],
  ),
  rule(
    "wantedIsWrittenAs",
    [v("x"), v("z")],
    [lit("wanted", v("x")), lit("isWrittenAs", v("x"), v("z"))],
  ),
  rule(
    "wantedFallbackBehind",
    [v("x"), v("f")],
    [lit("wanted", v("x")), lit("fallbackBehind", v("x"), v("f"))],
  ),
  rule(
    "wantedReadsOverridden",
    [v("x"), v("obj"), v("h")],
    [lit("wanted", v("x")), lit("readsOverridden", v("x"), v("obj"), v("h"))],
  ),
  rule(
    "wantedReadsMemberOn",
    [v("x"), v("obj"), v("h")],
    [lit("wanted", v("x")), lit("readsMemberOn", v("x"), v("obj"), v("h"))],
  ),
  // A call is given no `comesTo`, so this is the only way to ask what
  // object one arrives at, and a demand-driven run derives `objectOf`
  // nowhere without it. An allocation site is not one of the answers.
  rule(
    "wantedObjectOf",
    [v("x"), v("z")],
    [
      lit("wanted", v("x")),
      lit("objectOf", v("x"), v("z")),
      lit("objectValue", v("z")),
    ],
  ),
  // The same three questions under one allocation site, keyed by the
  // value and the site both. An allocation site is an answer here,
  // unlike `wantedObjectOf`, since a site is what a context is.
  rule(
    "wantedIsWrittenAsUnder",
    [v("x"), v("c"), v("z")],
    [
      lit("wantedUnder", v("x"), v("c")),
      lit("isWrittenAsUnder", v("x"), v("c"), v("z")),
    ],
  ),
  // Where a class was made, for a caller about to ask a value question
  // under each. Going through `constructsNamed` keeps the demand on the
  // calls written with the class's name rather than on every call.
  rule(
    "wantedAllocatedAt",
    [v("cls"), v("site")],
    [
      lit("wantedSites", v("cls")),
      lit("constructsNamed", v("site"), v("cls")),
      lit("allocates", v("site"), v("cls")),
    ],
  ),
  rule(
    "wantedComesToUnder",
    [v("x"), v("c"), v("z")],
    [
      lit("wantedUnder", v("x"), v("c")),
      lit("comesToUnder", v("x"), v("c"), v("z")),
    ],
  ),
  rule(
    "wantedObjectOfUnder",
    [v("x"), v("c"), v("z")],
    [
      lit("wantedUnder", v("x"), v("c")),
      lit("objectOfUnder", v("x"), v("c"), v("z")),
    ],
  ),
  // The same for the function a call returns: `app.use(requireCaller(config))`
  // registers what the factory gives back, and `resolves` on the call
  // says nothing unless the factory unwraps an argument.
  rule(
    "wantedGivesBack",
    [v("x"), v("z")],
    [lit("wanted", v("x")), lit("givesBack", v("x"), v("z"))],
  ),
  rule(
    "wantedGivesBackUnwrapped",
    [v("x"), v("z")],
    [lit("wanted", v("x")), lit("givesBackUnwrapped", v("x"), v("z"))],
  ),
  // Keyed by the parameter, since that is what a caller has in hand
  // when it wants the call sites told apart.
  rule(
    "wantedParamAt",
    [v("p"), v("r"), v("z")],
    [lit("wanted", v("p")), lit("paramAt", v("r"), v("p"), v("z"))],
  ),
  // The argument as the caller wrote it. A parameter given a GraphQL
  // document has no `paramAt` answer, since that settles through
  // `comesTo`, which stops at a function or an object.
  rule(
    "wantedPassesArgument",
    [v("p"), v("r"), v("a")],
    [lit("wanted", v("p")), lit("passesArgument", v("r"), v("p"), v("a"))],
  ),
  rule(
    "wantedReturnsCall",
    [v("f"), v("c")],
    [lit("wanted", v("f")), lit("returnsCall", v("f"), v("c"))],
  ),
  // Seeded with the expressions that spell the environment, a handful
  // per project. The reads cannot be the seed: one written through a
  // parameter is nowhere a scan of the source looks.
  rule(
    "wantedParamNamesEnv",
    [v("p"), v("site")],
    [
      lit("wantedEnvObject", v("w")),
      lit("environmentRead", v("w"), v("site"), v("x")),
      lit("paramNamesEnv", v("p"), v("site")),
    ],
  ),
  // The parameters the environment object is handed to, from the same
  // seed, so a question about one is a lookup rather than a read of
  // every file that could call its function.
  rule(
    "wantedEnvParameter",
    [v("p")],
    [
      lit("wantedEnvObject", v("w")),
      lit("environmentValue", v("w"), v("p")),
      lit("paramNamed", v("f"), v("n"), v("p")),
    ],
  ),
  // The calls that hand it on, for an asker to resolve, since the
  // parameter on the other side is in a file nothing has read yet.
  rule(
    "wantedEnvPassingCall",
    [v("r")],
    [
      lit("wantedEnvObject", v("w")),
      lit("environmentValue", v("w"), v("a")),
      lit("callArg", v("r"), v("k"), v("a")),
    ],
  ),
  // The same relation asked from one expression. Seeding from the
  // objects instead would settle it for every expression in the
  // project, and a caller holding an argument wants only that one.
  rule(
    "wantedEnvironmentValue",
    [v("o"), v("w")],
    [lit("wanted", v("o")), lit("environmentValue", v("w"), v("o"))],
  ),
  // Whether an expression is a parameter under another name, for a
  // caller deciding whether going and reading that parameter's callers
  // could change the answer it already has.
  rule(
    "wantedRefersToParam",
    [v("o"), v("p")],
    [lit("wanted", v("o")), lit("refersToParam", v("o"), v("p"))],
  ),
  // The types a value is declared as, beside each argument its own
  // callers pass, so the asking side can refuse a caller passing
  // something no declaration types.
  rule(
    "wantedTypedAs",
    [v("x"), v("t")],
    [lit("wantedType", v("x")), lit("typedAs", v("x"), v("t"))],
  ),
  rule(
    "wantedTypePassed",
    [v("o"), v("a")],
    [
      lit("wantedType", v("o")),
      lit("refersToParam", v("o"), v("p")),
      lit("passesArgument", v("r"), v("p"), v("a")),
    ],
  ),
  rule(
    "wantedPassedTypedAs",
    [v("o"), v("a"), v("t")],
    [
      lit("wantedType", v("o")),
      lit("refersToParam", v("o"), v("p")),
      lit("passesArgument", v("r"), v("p"), v("a")),
      lit("typedAs", v("a"), v("t")),
    ],
  ),
  rule(
    "wantedPassedParam",
    [v("o"), v("a")],
    [
      lit("wantedType", v("o")),
      lit("refersToParam", v("o"), v("p")),
      lit("passesArgument", v("r"), v("p"), v("a")),
      lit("refersToParam", v("a"), v("q")),
    ],
  ),
  rule(
    "wantedComesFrom",
    [v("x"), v("m"), v("n")],
    [lit("wantedOrigin", v("x")), lit("comesFrom", v("x"), v("m"), v("n"))],
  ),

  // Call-origin questions, for attribution, in their own demand
  // class. Attribution stops at the import declaration, so nothing
  // here demands reaches or callsInto. The chains are closures with
  // no depth bound: an alias run of any length resolves.
  rule("callOriginChain", [v("x"), v("x")], [lit("wantedCallOrigin", v("x"))]),
  // The chain with at least one hop taken, which is what tells a
  // destructured binding apart from asking about a node directly. The
  // whole chain is the seed plus those hops.
  rule(
    "callOriginChain",
    [v("x"), v("z")],
    [lit("callOriginChainStepped", v("x"), v("z"))],
  ),
  rule(
    "callOriginChainStepped",
    [v("x"), v("z")],
    [lit("callOriginChain", v("x"), v("y")), lit("nameHop", v("y"), v("z"))],
  ),
  rule(
    "wantedCallOriginPair",
    [v("x"), v("m"), v("n")],
    [
      lit("callOriginChain", v("x"), v("y")),
      lit("imports", v("y"), v("m"), v("n")),
    ],
  ),
  // An import of a project barrel is an import of what the barrel
  // forwards, so the pair surfaces the module behind the chain.
  rule(
    "wantedCallOriginPair",
    [v("x"), v("m2"), v("n2")],
    [
      lit("callOriginChain", v("x"), v("y")),
      lit("imports", v("y"), v("m"), v("n")),
      lit("moduleForwards", v("m"), v("n"), v("m2"), v("n2")),
    ],
  ),
  // A namespace member: the module's export of the member's own name.
  // The imports literal leads, since it is the smallest relation.
  rule(
    "wantedCallOriginPair",
    [v("x"), v("m"), v("p")],
    [
      lit("imports", v("o"), v("m"), NAMESPACE_IMPORT),
      lit("readsProperty", v("y"), v("o"), v("p")),
      lit("callOriginChain", v("x"), v("y")),
    ],
  ),
  rule(
    "wantedCallOriginPair",
    [v("x"), v("m"), v("p")],
    [
      lit("imports", v("d"), v("m"), NAMESPACE_IMPORT),
      lit("binds", v("o"), v("d")),
      lit("readsProperty", v("y"), v("o"), v("p")),
      lit("callOriginChain", v("x"), v("y")),
    ],
  ),
  // What a call made: through the call to its callee, whose own alias
  // chain leads to the import.
  rule(
    "callMadeChain",
    [v("x"), v("f")],
    [lit("callOriginChain", v("x"), v("c")), lit("call", v("c"), v("f"))],
  ),
  rule(
    "callMadeChain",
    [v("x"), v("z")],
    [lit("callMadeChain", v("x"), v("y")), lit("nameHop", v("y"), v("z"))],
  ),
  rule(
    "wantedCallOriginPair",
    [v("x"), v("m"), v("n")],
    [
      lit("callMadeChain", v("x"), v("y")),
      lit("imports", v("y"), v("m"), v("n")),
    ],
  ),
  // A member destructured off what a call made keeps the member name
  // as one more path segment.
  rule(
    "callMemberChain",
    [v("x"), v("f"), v("p")],
    [
      lit("callOriginChainStepped", v("x"), v("e")),
      lit("readsProperty", v("e"), v("c"), v("p")),
      lit("call", v("c"), v("f")),
    ],
  ),
  rule(
    "callMemberChain",
    [v("x"), v("z"), v("p")],
    [
      lit("callMemberChain", v("x"), v("y"), v("p")),
      lit("nameHop", v("y"), v("z")),
    ],
  ),
  rule(
    "wantedCallOriginMember",
    [v("x"), v("m"), v("n"), v("p")],
    [
      lit("callMemberChain", v("x"), v("y"), v("p")),
      lit("imports", v("y"), v("m"), v("n")),
    ],
  ),
  rule(
    "wantedCallsInto",
    [v("g"), v("m"), v("n")],
    [
      lit("wantedOrigin", v("x")),
      lit("comesTo", v("x"), v("g")),
      lit("callsInto", v("g"), v("m"), v("n")),
    ],
  ),

  // Subject identity, its own demand class; the README's subject
  // section says why the origin pair rides on the written-value walk.
  rule(
    "wantedSubjectWritten",
    [v("x"), v("r")],
    [lit("wantedSubject", v("x")), lit("isWrittenAs", v("x"), v("r"))],
  ),
  rule(
    "wantedSubjectConstruction",
    [v("x"), v("r"), v("m"), v("n")],
    [
      lit("wantedSubject", v("x")),
      lit("isWrittenAs", v("x"), v("r")),
      lit("call", v("r"), v("c")),
      lit("comesFrom", v("c"), v("m"), v("n")),
    ],
  ),

  // The export table of one module, keyed by the module asked about.
  // The moduleExport rules flatten re-export chains of any length, and
  // the demand cone stays on export facts alone.
  rule(
    "wantedModuleExport",
    [v("m"), v("n"), v("value")],
    [
      lit("wantedExportsOf", v("m")),
      lit("moduleExport", v("m"), v("n"), v("value")),
    ],
  ),

  // A class's ancestry: each base as written, then the class that name
  // comes to through the name hops. A storage pack matches its library's
  // bases against the base names along the way.
  rule("ancestryChain", [v("c"), v("c")], [lit("wantedAncestry", v("c"))]),
  rule(
    "ancestryChain",
    [v("c"), v("x")],
    [lit("ancestryChain", v("c"), v("b")), lit("extends", v("b"), v("x"))],
  ),
  rule(
    "ancestryChain",
    [v("c"), v("z")],
    [lit("ancestryChain", v("c"), v("y")), lit("nameHop", v("y"), v("z"))],
  ),
  rule(
    "ancestryChain",
    [v("c"), v("z")],
    [
      lit("ancestryChain", v("c"), v("y")),
      lit("imports", v("y"), v("m"), v("n")),
      lit("moduleExport", v("m"), v("n"), v("z")),
    ],
  ),
  rule(
    "wantedBaseName",
    [v("c"), v("n")],
    [lit("ancestryChain", v("c"), v("b")), lit("extendsNamed", v("b"), v("n"))],
  ),
  // Each method the same chain declares, so a caller that settled a
  // receiver on a class can tell a method the project writes itself
  // from one only the library provides.
  rule(
    "wantedDeclaredName",
    [v("c"), v("n")],
    [
      lit("ancestryChain", v("c"), v("b")),
      lit("holdsProperty", v("b"), v("n"), v("held")),
    ],
  ),
  // A method the class gets under a name the source computes rather than
  // writes out. The adapter settles the name against the same facts and
  // says so, and the chain reports it beside the ones written out.
  rule(
    "wantedDeclaredName",
    [v("c"), v("n")],
    [lit("ancestryChain", v("c"), v("b")), lit("declaresName", v("b"), v("n"))],
  ),
  // The method behind each callback the chain registers, by the event
  // that runs it. A base registering one reaches every class below it,
  // and the method may be declared anywhere along the same chain.
  rule(
    "wantedCallbackMethod",
    [v("c"), v("event"), v("n"), v("held")],
    [
      lit("ancestryChain", v("c"), v("b")),
      lit("classCallback", v("b"), v("event"), v("n")),
      lit("ancestryChain", v("c"), v("b2")),
      lit("holdsProperty", v("b2"), v("n"), v("held")),
    ],
  ),

  // The calls behind a receiver, for a pack that wants the anchor a
  // chain hangs off; the README's anchor section says which hops and
  // why the asking side applies the single-answer policy.
  rule("anchorChain", [v("x"), v("x")], [lit("wantedAnchor", v("x"))]),
  rule(
    "anchorChain",
    [v("x"), v("z")],
    [lit("anchorChain", v("x"), v("y")), lit("nameHop", v("y"), v("z"))],
  ),
  rule(
    "anchorChain",
    [v("x"), v("z")],
    [
      lit("anchorChain", v("x"), v("y")),
      lit("imports", v("y"), v("m"), v("n")),
      lit("moduleExport", v("m"), v("n"), v("z")),
    ],
  ),
  rule(
    "anchorChain",
    [v("x"), v("c")],
    [lit("anchorChain", v("x"), v("r")), lit("call", v("r"), v("c"))],
  ),
  rule(
    "anchorChain",
    [v("x"), v("o")],
    [
      lit("anchorChain", v("x"), v("y")),
      lit("readsProperty", v("y"), v("o"), v("n")),
    ],
  ),
  rule(
    "wantedAnchorCall",
    [v("x"), v("r")],
    [lit("anchorChain", v("x"), v("r")), lit("call", v("r"), v("c"))],
  ),
];

/** The relations `RESOLUTION_QUESTIONS` answers into. */
export const ANSWER_RELATIONS = [
  ...new Set(RESOLUTION_QUESTIONS.map((r) => r.head.relation)),
];

/**
 * The three of those a caller asks under one allocation site.
 *
 * They are listed apart because leaving them out of what a program has
 * to answer drops the whole second closure from it. A run that never
 * mentions a context would otherwise carry a thousand rewritten rules
 * it can never fire, and the engine reads every rule once a round.
 */
export const UNDER_ANSWER_RELATIONS = [
  "wantedIsWrittenAsUnder",
  "wantedComesToUnder",
  "wantedObjectOfUnder",
];
