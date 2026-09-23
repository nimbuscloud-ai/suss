# @suss/values

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

One evaluator that works out the value of an expression at the place it
is written, over an abstract value domain. It works for any language an
adapter can lower.

## What this package is

The package is an engine and a value domain. It does not parse anything
and has no language of its own. An adapter gives the engine a
`Lowering`, which turns each node of its syntax tree into one of a
dozen expression or statement shapes on demand. The adapter also gives
it a table of rows that describe what each operator and library method
does to a value. The engine then runs the statements of the enclosing
function or module up to the expression it was asked about, and
evaluates the expression against the state it reached.

This engine replaced several readers, and each of them re-implemented a
slice of it: one for route paths, one for template strings, one for the
arguments of a registration call. Each one handled a few spellings and
gave up on the rest. The engine models statements and values, so a
spelling it has not seen before still folds when the pieces it is made
of do.

So a value in this repository is read here and nowhere else. [The rule
and each adapter's entry
points](../../design/docs-internal/style.md#reading-a-value) say where to call
in from, and `npm run check:readers` fails on a reader written beside a
call site instead.

## The value domain

A value keeps what the source determines, and has a hole where the
source does not determine it.

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

`join` in `lattice.ts` computes the value after two branches. It keeps
the pieces that two strings share at both ends, and turns the middle
into a set or a hole. It lines sequence elements up by position, and it
unions record fields. `widen` computes the value after a loop has run
some number of times. A sequence that grew becomes unbounded, a record
that gained a field becomes open, and a string keeps the prefix the loop
did not change.

A set of literals wider than `SET_CAP` becomes a hole, and so does a
set of constants wider than `CONSTANT_CAP`, so a value never grows
without bound.

A value does not record the syntax node it came from. A caller that
needs that node back, for instance to compare where two values were
constructed, keeps a key for it and looks the node up from that key on
demand. `writtenNodeOf` does that lookup in all three adapters, so a
reader that wants a node asks the adapter for it and does not expect
the value to contain it.

## What the engine does

When asked about an expression, the engine finds its site: the
enclosing function or module, and the path of statements down to the
expression. It then runs every statement that comes before the
expression at each level of nesting.

- A declaration or assignment binds a name. A compound assignment
  applies the operator's row to the old and new values.
- A branch runs each arm on a copy of the state and joins the arms that
  complete. When the source settles the condition, only the matching
  arm runs.
- A loop runs its body once, then widens the state from before the loop
  against the state after it.
- A return ends the statement list it is in, and contributes to the
  value of an inlined call.
- A call is looked up in the rows first. If no row matches and the
  lowering can resolve the callee to a project function without a loop,
  the body is inlined, up to a depth cap. A keyword argument binds its
  parameter by name. A parameter the call leaves out takes the default
  the lowering gave it. Defaults are evaluated after the parameters
  before them, so a default can read one of them. A lowering that
  destructures a parameter gives one name per property, and each such
  parameter then declares which argument fills it, because its position
  in the list no longer matches. A destructured name also comes with the
  properties to read off that argument. When the argument does not fold
  to an object with the property, the name is a hole, and when the
  object has no such property, the default applies. If the callee cannot
  be inlined, the engine asks the lowering through `writtenTo` what the
  call is written to. That is how a declared wrapper that passes one
  argument through evaluates to that argument. Failing that, the call is
  a hole, and every allocation passed to it escapes.

Arrays and object literals are allocated in a local heap and bound as a
`ref`, so a push through an alias is seen by every name bound to the
same array. A spread copies. An allocation escapes when it is passed to
an unknown call, written into something the engine cannot see, or read
by a callback passed to an unknown call. After it escapes, its content
is unknown.

A name that is not bound in the current function is read where the
function is written, by running the enclosing scope up to that point.
A name that a nested function mutates is widened from the point where
it is declared or assigned. That applies whether the read is in the same
scope or inside another function, because the engine does not know when
that function runs. A name bound in another file is read through the
lowering's `writtenTo`.

Evaluation is demand driven. An outer name or an unknown call is a
`deferred` value until something forces it, so a run that never asks
about a name never resolves it.

## More

- [How an adapter describes its language to the evaluator](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
