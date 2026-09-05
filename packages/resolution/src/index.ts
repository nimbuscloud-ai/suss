export { checkFactContract, FACT_CONTRACT_CASES } from "./contract.js";
export { explainResolutionProof, renderExplanation } from "./explain.js";
export {
  agreedMountPrefix,
  joinMountedPath,
  type MountEdge,
  type MountEdges,
  mountPathsOf,
} from "./mount.js";
export { explainResolvedKey } from "./session.js";
export { placeholderValues, singleAnswers } from "./singleAnswer.js";
export { writtenValueOf } from "./writtenValue.js";

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

// @suss/resolution - following a value to the function it comes down to.
//
// These rules are about programming languages rather than about any one
// of them. A name binds to a value, a call puts an argument in a
// parameter, an object holds a value under a name, a module exports a
// name and another module can forward it, and a function that returns a
// function calling its parameter hands back the argument it was given.
// That last one is a decorator in Python and a closure in Go.
//
// So an adapter's job is reading source into the facts below, not
// deciding what they mean. Anything genuinely particular to a language,
// like JavaScript's `.bind`, belongs with that language's adapter and
// composes on top.
//
// The facts a language adapter has to supply:
//
//   func(f)                     f is a function
//   objectValue(o)              o is an object written out literally
//   writtenValue(x)             x is an expression written out in
//                               source rather than a name for one
//   placeholderValue(x)         x is a written value a later write is
//                               expected to replace, such as None
//   holdsProperty(o, n, x)      object o holds x under the name n
//   readsProperty(x, o, n)      x is the expression o.n
//   binds(x, y)                 the name x is declared as y
//   endsHolding(x, y)           the name x is written more than once
//                               and holds y once the writes have run
//   fallbackBranch(x, b)        x is a fallback expression and b is
//                               one of its branches
//   paramOf(f, k, p)            p is f's parameter at position k
//   paramNamed(f, n, p)         p is f's parameter called n
//   extends(c, b)               class c is written as extending b
//   extendsNamed(c, n)          class c extends the name n, where no
//                               node in the run backs that name
//   returnsValue(f, v)          f returns v
//   bodyCalls(f, c)             f's body calls c
//   containsFn(f, g)            g is declared inside f
//   call(r, c)                  r is a call whose callee is c
//   callArg(r, k, a)            r passes a at position k
//   imports(x, m, n)            x is the name n imported from module m
//   exportsAs(m, n, v)          module m exports v under the name n
//   reExports(m, n, m2, n2)     m's n is m2's n2
//   reExportsAll(m, m2)         m forwards everything m2 exports
//
// Node identity is the adapter's business. The rules only join on it.
// Making one of a class is a call of the class, however the language
// writes it: `Foo()`, `new Foo()`, `Foo.new`. The adapter says `call`
// about whichever of those it reads, and lists the constructor's
// parameters as `paramOf` of the class.

import { constant, lit, rule, variable as v } from "@suss/datalog";

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

/** A step to what running the call x is handed back. */
export const RESULT_STEP = constant("result");

/**
 * The rules every language adapter shares. Concatenate a language's own
 * rules onto these before evaluating.
 *
 * Every construct states its hops once, as `stepsTo(x, y, kind)`, which
 * says x leads to y. A value step goes to the value x is written as, and a
 * result step runs the call x is and goes to what that call handed back.
 * `reaches` is the closure of those steps, and a walk counts as a result
 * walk once it has run a call anywhere along it.
 *
 * Each question is that one closure with its own stopping condition, so
 * adding a construct is one step and every question gets it, and adding
 * a question is a stopping condition and no steps at all.
 */
export const RESOLUTION_RULES = [
  // Aliasing: const x = y, or an identifier referencing a declaration.
  // A language with a hop of its own, like JavaScript's `.bind`, states
  // it as a step too, or every question but `comesTo` misses it.
  rule(
    "stepsTo",
    [v("x"), v("y"), VALUE_STEP],
    [lit("binds", v("x"), v("y"))],
    "alias",
  ),

  // A name written more than once has the value the last write left
  // there. The adapter works out which write that is and stays quiet
  // when control flow decides, so such a name steps nowhere at all.
  rule(
    "stepsTo",
    [v("x"), v("y"), VALUE_STEP],
    [lit("endsHolding", v("x"), v("y"))],
    "last write",
  ),

  // A fallback says the value is one of its branches, so each branch is
  // a step. A branch that resolves to nothing makes no claim, and two
  // branches resolving to different things fail the single-answer policy.
  rule(
    "stepsTo",
    [v("x"), v("b"), VALUE_STEP],
    [lit("fallbackBranch", v("x"), v("b"))],
    "fallback",
  ),

  // An import steps to what the module exports under that name.
  rule(
    "stepsTo",
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
    "stepsTo",
    [v("r"), v("cls"), VALUE_STEP],
    [
      lit("call", v("r"), v("c")),
      lit("comesTo", v("c"), v("cls")),
      lit("objectValue", v("cls")),
    ],
    "class instance",
  ),

  // Wrapper transparency, derived: calling a factory that returns a
  // function which calls its parameter k steps to argument k.
  rule(
    "stepsTo",
    [v("r"), v("a"), VALUE_STEP],
    [
      lit("call", v("r"), v("c")),
      lit("comesTo", v("c"), v("f")),
      lit("unwraps", v("f"), v("k")),
      lit("callArg", v("r"), v("k"), v("a")),
    ],
    "factory unwrap",
  ),

  // Wrapper transparency, declared: a pack says this callee wraps
  // argument k. The callee has to come from the library the pack said,
  // so a local object spelled the same way is not mistaken for it.
  rule(
    "stepsTo",
    [v("r"), v("a"), VALUE_STEP],
    [
      lit("calleeName", v("r"), v("n")),
      lit("unwrapsByName", v("n"), v("k")),
      lit("wrapperModule", v("n"), v("m")),
      lit("calleeOrigin", v("r"), v("m")),
      lit("callArg", v("r"), v("k"), v("a")),
    ],
    "declared wrapper",
  ),

  // The one step that runs a function forwards: a call steps to what
  // the function it invokes returns.
  rule(
    "stepsTo",
    [v("r"), v("ret"), RESULT_STEP],
    [lit("invokes", v("r"), v("f")), lit("returnsValue", v("f"), v("ret"))],
    "call result",
  ),

  // Where a walk gets to, and whether it ran a call on the way. The walk
  // so far comes first, so demand stays on the value asked about; the
  // README says what the other order cost.
  rule(
    "reaches",
    [v("x"), v("z"), v("kind")],
    [lit("stepsTo", v("x"), v("z"), v("kind"))],
  ),
  rule(
    "reaches",
    [v("x"), v("z"), v("kind")],
    [
      lit("reaches", v("x"), v("y"), VALUE_STEP),
      lit("stepsTo", v("y"), v("z"), v("kind")),
    ],
  ),
  // Two rules rather than one leaving the next step's kind free. A free
  // kind is a second question about the same relation, and a
  // demand-driven run then derives both to answer either.
  rule(
    "reaches",
    [v("x"), v("z"), RESULT_STEP],
    [
      lit("reaches", v("x"), v("y"), RESULT_STEP),
      lit("stepsTo", v("y"), v("z"), VALUE_STEP),
    ],
  ),
  rule(
    "reaches",
    [v("x"), v("z"), RESULT_STEP],
    [
      lit("reaches", v("x"), v("y"), RESULT_STEP),
      lit("stepsTo", v("y"), v("z"), RESULT_STEP),
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

  // Which calls a function, found by the name the call is written as
  // rather than by resolving every callee in the project. A caller knows
  // the function and wants its call sites, so both of these start from
  // the function. Starting from `call` instead asks what every call in
  // the project imports, which was 72% of everything derived.
  rule(
    "callsFunction",
    [v("r"), v("f")],
    [lit("binds", v("c"), v("f")), lit("call", v("r"), v("c"))],
  ),
  rule(
    "callsFunction",
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
    "callsFunction",
    [v("r"), v("f")],
    [
      lit("moduleExport", v("m"), v("n"), v("f")),
      lit("imports", v("d"), v("m"), v("n")),
      lit("binds", v("c"), v("d")),
      lit("call", v("r"), v("c")),
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
      lit("binds", v("c"), v("p")),
      lit("paramOf", v("f"), v("k"), v("p")),
    ],
  ),

  // Argument flow: which parameter a value traces back to. Directly
  // (an identifier bound to the parameter), or through a call to
  // another unwrapping factory. This is what lets
  // `createProtected(h) { return service.withAuth(h); }` unwrap:
  // the returned call passes h through withAuth, which unwraps.
  rule(
    "flowsToParam",
    [v("x"), v("p")],
    [
      lit("binds", v("x"), v("p")),
      lit("paramOf", v("anyF"), v("anyK"), v("p")),
    ],
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
  // source being read. A walk ends at something written out in source,
  // so it never reaches a library's own function.
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
  // A call is given no `comesTo`, so this is the only way to ask what
  // object one arrives at, and without it a demand-driven run derives
  // `objectOf` nowhere.
  rule(
    "wantedObjectOf",
    [v("x"), v("z")],
    [lit("wanted", v("x")), lit("objectOf", v("x"), v("z"))],
  ),
  // Keyed by the parameter, since that is what a caller has in hand
  // when it wants the call sites told apart.
  rule(
    "wantedParamAt",
    [v("p"), v("r"), v("z")],
    [lit("wanted", v("p")), lit("paramAt", v("r"), v("p"), v("z"))],
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
    [lit("callOriginChain", v("x"), v("y")), lit("binds", v("y"), v("z"))],
  ),
  rule(
    "callOriginChainStepped",
    [v("x"), v("z")],
    [
      lit("callOriginChain", v("x"), v("y")),
      lit("endsHolding", v("y"), v("z")),
    ],
  ),
  rule(
    "callOriginChainStepped",
    [v("x"), v("z")],
    [
      lit("callOriginChain", v("x"), v("y")),
      lit("fallbackBranch", v("y"), v("z")),
    ],
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
    [lit("callMadeChain", v("x"), v("y")), lit("binds", v("y"), v("z"))],
  ),
  rule(
    "callMadeChain",
    [v("x"), v("z")],
    [lit("callMadeChain", v("x"), v("y")), lit("endsHolding", v("y"), v("z"))],
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
      lit("binds", v("y"), v("z")),
    ],
  ),
  rule(
    "callMemberChain",
    [v("x"), v("z"), v("p")],
    [
      lit("callMemberChain", v("x"), v("y"), v("p")),
      lit("endsHolding", v("y"), v("z")),
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

  // The calls behind a receiver, for a pack that wants the anchor a
  // chain hangs off; the README's anchor section says which hops and
  // why the asking side applies the single-answer policy.
  // A class's ancestry, one hop per extends through the binding that
  // says which class the written base is; the names on the way out
  // are what a storage pack matches its library's bases against.
  rule("ancestryChain", [v("c"), v("c")], [lit("wantedAncestry", v("c"))]),
  rule(
    "ancestryChain",
    [v("c"), v("b2")],
    [
      lit("ancestryChain", v("c"), v("b")),
      lit("extends", v("b"), v("x")),
      lit("binds", v("x"), v("b2")),
    ],
  ),
  rule(
    "wantedBaseName",
    [v("c"), v("n")],
    [lit("ancestryChain", v("c"), v("b")), lit("extendsNamed", v("b"), v("n"))],
  ),

  rule("anchorChain", [v("x"), v("x")], [lit("wantedAnchor", v("x"))]),
  rule(
    "anchorChain",
    [v("x"), v("z")],
    [lit("anchorChain", v("x"), v("y")), lit("binds", v("y"), v("z"))],
  ),
  rule(
    "anchorChain",
    [v("x"), v("z")],
    [lit("anchorChain", v("x"), v("y")), lit("endsHolding", v("y"), v("z"))],
  ),
  rule(
    "anchorChain",
    [v("x"), v("z")],
    [lit("anchorChain", v("x"), v("y")), lit("fallbackBranch", v("y"), v("z"))],
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
