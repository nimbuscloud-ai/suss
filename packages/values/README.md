# @suss/values

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

One evaluator that works out what an expression is worth where it is
written, over an abstract value domain, for any language an adapter
can lower.

## What this package is

An engine and a value domain, with no parser and no language of its
own. An adapter hands the engine a `Lowering`, which turns each node of
its syntax tree into one of a dozen expression or statement shapes on
demand, plus a table of rows saying what each operator and library
method does to a value. The engine then runs the statements of the
enclosing function or module up to the expression it was asked about,
and evaluates the expression against the state it reached.

The readers this replaces each re-implemented a slice of this: one for
route paths, one for template strings, one for the arguments of a
registration call. Each one knew a few spellings and gave up on the
rest. The engine knows statements and values, so a spelling it has not
seen still folds when the pieces it is made of do.

## The value domain

A value keeps what the source determines and puts a hole where it does
not.

```
string      a list of pieces; each piece is a small set of literals or a
            named hole covering some number of path segments
constant    a small set of numbers, booleans, null and undefined
sequence    elements the source wrote, in order; an element only one
            branch wrote is marked optional
unbounded   a sequence of unknown length whose elements share one value
record      fields the source wrote by name; open when a field the
            source did not write may still be present
hole        nothing is known, and the name says what the value stood for
ref         an allocation in the engine's local heap
deferred    a value nothing has asked the content of yet
```

`join` in `lattice.ts` is what a value is after two branches. It keeps
the pieces two strings share from both ends and turns the middle into a
set or a hole, lines sequence elements up by position, and unions record
fields. `widen` is what a value is after a loop ran some number of
times: a sequence that grew becomes unbounded, a record that gained a
field opens, and a string keeps the prefix the loop did not change.

A set of literals wider than `SET_CAP` becomes a hole, and a set of
constants wider than `CONSTANT_CAP` does the same, so a value never
grows without bound.

## What the engine does

Asked about an expression, the engine finds its site (the enclosing
function or module, and the path of statements down to it) and runs
every statement that comes before it at each level of nesting.

- A declaration or assignment binds a name. A compound assignment
  applies the operator's row to the old and new values.
- A branch runs each arm on a copy of the state and joins the arms that
  complete. A condition the source settles selects one arm.
- A loop runs its body once and widens the state before it against the
  state after it.
- A return ends the statement list it is in and contributes to what an
  inlined call is worth.
- A call is looked up in the rows first. Otherwise, when the lowering
  can resolve the callee to a project function without a loop, the body
  is inlined under a depth cap. A keyword argument binds its parameter
  by name, and a parameter the call leaves out takes the default the
  lowering gave it, evaluated after the parameters before it so a
  default can read one of them. Otherwise the lowering is asked what
  the call is written to through `writtenTo`, which is how a declared
  wrapper that passes one argument through evaluates to that argument.
  Otherwise the call is a hole and every allocation it was handed
  escapes.

Arrays and object literals are allocated in a local heap and bound as a
`ref`, so a push through an alias is seen by every name bound to the
same array. A spread copies. An allocation escapes when it is passed to
an unknown call, written into something the engine cannot see, or read
by a callback handed to an unknown call; once it has escaped, its
content is unknown from then on.

A name that is not bound in the current function is read where the
function is written, by running the enclosing scope up to that point.
A name a nested function mutates is widened away from the point it is
declared or assigned, whether the read is in the same scope or from
inside another function, since the engine does not know when that
function runs. A name bound in another file is
read through the lowering's `writtenTo`.

Evaluation is demand driven. An outer name or an unknown call is a
`deferred` value until something forces it, so a run that never asks
about a name never resolves it.

## More

- [How an adapter teaches the evaluator its language](./DESIGN.md)
- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
