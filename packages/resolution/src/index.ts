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
//   holdsProperty(o, n, x)      object o holds x under the name n
//   readsProperty(x, o, n)      x is the expression o.n
//   binds(x, y)                 the name x is declared as y
//   paramOf(f, k, p)            p is f's parameter at position k
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
//
// Three relations come out. `comesTo(x, z)` follows a name to the value
// it ends up being, which can be an object as well as a function; the
// chain has to pass through objects for `routes.list` to reach what
// `list` holds. `resolves(x, z)` is `comesTo` narrowed to functions,
// and is the question callers ask.
//
// `isWrittenAs(x, z)` follows the same names to the expression the
// value is written as, whatever kind of expression that is. A GraphQL
// document is neither a function nor an object, so `comesTo` never
// reaches one; reading a document back off a named constant means
// following the same binds and imports to a template literal or a tag
// call and letting the caller decide what it is looking at.

import { lit, rule, variable as v } from "@suss/datalog";

/**
 * The rules every language adapter shares. Concatenate a language's own
 * rules onto these before evaluating.
 */
export const RESOLUTION_RULES = [
  // A value comes to itself; every chain ends at something written out
  // in source, a function or an object.
  rule("comesTo", [v("x"), v("x")], [lit("func", v("x"))]),
  rule("comesTo", [v("x"), v("x")], [lit("objectValue", v("x"))]),

  // Aliasing: const x = y, or an identifier referencing a declaration.
  rule(
    "comesTo",
    [v("x"), v("z")],
    [lit("binds", v("x"), v("y")), lit("comesTo", v("y"), v("z"))],
  ),

  // An import comes to what the module exports under that name.
  rule(
    "comesTo",
    [v("x"), v("z")],
    [
      lit("imports", v("x"), v("m"), v("n")),
      lit("moduleExport", v("m"), v("n"), v("value")),
      lit("comesTo", v("value"), v("z")),
    ],
  ),

  // What a module exports: directly, or through re-export chains.
  rule(
    "moduleExport",
    [v("m"), v("n"), v("value")],
    [lit("exportsAs", v("m"), v("n"), v("value"))],
  ),
  rule(
    "moduleExport",
    [v("m"), v("n"), v("value")],
    [
      lit("reExports", v("m"), v("n"), v("m2"), v("n2")),
      lit("moduleExport", v("m2"), v("n2"), v("value")),
    ],
  ),
  rule(
    "moduleExport",
    [v("m"), v("n"), v("value")],
    [
      lit("reExportsAll", v("m"), v("m2")),
      lit("moduleExport", v("m2"), v("n"), v("value")),
    ],
  ),

  // The object an expression stands for. A name arrives at one by
  // following `comesTo` through aliases and imports. A factory call
  // arrives at one through what the function it calls returns; the
  // call itself is given no `comesTo`, since a factory call usually IS
  // the wrapper and answering with the raw returned function would
  // fight the unwraps answer.
  rule(
    "objectOf",
    [v("o"), v("obj")],
    [lit("comesTo", v("o"), v("obj")), lit("objectValue", v("obj"))],
  ),
  rule(
    "objectOf",
    [v("r"), v("obj")],
    [
      lit("call", v("r"), v("c")),
      lit("comesTo", v("c"), v("f")),
      lit("returnsValue", v("f"), v("ret")),
      lit("comesTo", v("ret"), v("obj")),
      lit("objectValue", v("obj")),
    ],
  ),

  // Reading a property comes to what the object holds under that name,
  // whichever way the object arrived: `routes.list` off a name, or
  // `make(body).handle` off a call.
  rule(
    "comesTo",
    [v("x"), v("z")],
    [
      lit("readsProperty", v("x"), v("o"), v("n")),
      lit("objectOf", v("o"), v("obj")),
      lit("holdsProperty", v("obj"), v("n"), v("held")),
      lit("comesTo", v("held"), v("z")),
    ],
  ),

  // Wrapper transparency, derived: calling a factory that returns a
  // function which calls its parameter k comes to argument k.
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
  rule(
    "comesTo",
    [v("r"), v("h")],
    [
      lit("call", v("r"), v("c")),
      lit("comesTo", v("c"), v("f")),
      lit("unwraps", v("f"), v("k")),
      lit("callArg", v("r"), v("k"), v("a")),
      lit("comesTo", v("a"), v("h")),
    ],
  ),

  // Wrapper transparency, declared: a pack says this callee wraps
  // argument k, whatever its implementation looks like. The callee has
  // to have been imported from the library the pack named, so a local
  // object spelled the same way is not mistaken for it.
  rule(
    "comesTo",
    [v("r"), v("h")],
    [
      lit("calleeName", v("r"), v("n")),
      lit("unwrapsByName", v("n"), v("k")),
      lit("wrapperModule", v("n"), v("m")),
      lit("calleeOrigin", v("r"), v("m")),
      lit("callArg", v("r"), v("k"), v("a")),
      lit("comesTo", v("a"), v("h")),
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

  // Following a name to the expression it is written as. A separate
  // relation rather than a widening of `comesTo`, so a caller asking
  // the older question never sees a new answer: a factory call already
  // has an unwrapping answer, and letting it also answer with itself
  // would make that pair ambiguous.
  //
  // The two seeds are the two ways an expression can be written out. An
  // object literal is one of them, and it is the shape a generated
  // GraphQL document takes.
  rule("isWrittenAs", [v("x"), v("x")], [lit("writtenValue", v("x"))]),
  rule("isWrittenAs", [v("x"), v("x")], [lit("objectValue", v("x"))]),
  rule(
    "isWrittenAs",
    [v("x"), v("z")],
    [lit("binds", v("x"), v("y")), lit("isWrittenAs", v("y"), v("z"))],
  ),
  rule(
    "isWrittenAs",
    [v("x"), v("z")],
    [
      lit("imports", v("x"), v("m"), v("n")),
      lit("moduleExport", v("m"), v("n"), v("value")),
      lit("isWrittenAs", v("value"), v("z")),
    ],
  ),
];
