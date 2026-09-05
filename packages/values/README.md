# @suss/values

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
  is inlined under a depth cap. Otherwise the lowering is asked what
  the call is written to through `writtenTo`, which is how a declared
  wrapper that passes one argument through reads as that argument.
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

## Writing a lowering

A `Lowering<N>` is generic over the adapter's node type. The engine
never inspects a node; it only asks the lowering about it.

```ts
interface Lowering<N> {
  expression(node: N): Expression<N>;
  statement(node: N): Statement<N>;
  siteOf(node: N): Site<N> | null;
  functionOf(node: N): FunctionShape<N> | null;
  writtenTo(node: N): N | null;
  callable(node: N): N | null;
  mutatedInNestedFunction(root: N, name: string): boolean;
  freeNamesOf(fn: N): readonly string[];
  holeNameOf(node: N): string;
  readonly rows: readonly Row[];
}
```

`siteOf` gives the root and the path of statements from the root's body
down to the one containing the node. The path includes the node itself
when its parent is the root, so a function placed in a module body has a
path of its own. `functionOf` gives a function's parameters and body,
and a module's body as a function with no parameters. Anything the
lowering cannot express is `opaque`, and the engine gives it a hole
named by `holeNameOf`.

The engine asks `writtenTo` and `callable` only when it needs them, so
an adapter can back them with its resolution facts without paying for
nodes nobody asks about.

## Writing rows

A row says what one operator or library call does to abstract values.
Rows are the only place library knowledge lives.

```ts
{ kind: "operator", operator: "+", arity: 2, apply: ([a, b]) => plus(a, b) }
{ kind: "method", method: "push", on: "sequence",
  apply: ({ receiver, args }) => ({ result: constant(0), receiver: appended(receiver, args) }) }
{ kind: "callee", origin: { module: "path", name: "join" },
  apply: ({ args }) => ({ result: joinedPath(args) }) }
```

A method row matches on the method name and the receiver's kind. A
callee row matches on the import origin the lowering resolves, so a
local function spelled like a library function does not match. A row
that changes its receiver in place returns the new content as
`receiver`, and a row that hands back the receiver itself returns
`"receiver"` so a chain keeps its identity. The receiver arrives as its
content, but an array or record argument arrives as a `ref`, so `push`
keeps the identity of what it stores. A row that copies instead, the
way `concat` does, calls `contentOf(arg)` to read what is behind it.

`operations.ts` has the building blocks a row usually needs: `plus`,
`appended`, `extended`, `joined`, `equals`, `negated`, `fallback` and
`isPresent`.

## Spelling a route path

`pathOf` in `routePath.ts` turns a string value into the path a boundary
serves, and every adapter reads a route through it so a provider and a
consumer in different languages pair. A hole is spelled `{name}`, with
`?`, `+` or `*` after the name when it covers some other number of
segments, and a piece that is one of a few texts is spelled `(v1|v2)`.
An absolute URL loses its origin, and a query string or fragment ends
the path where it starts.

## Bounds

- `INLINE_DEPTH_CAP` limits how deep calls inline; past it a call is a
  hole.
- `STATEMENT_BUDGET` limits how many statements one `evaluate` runs;
  past it the run stops with the state it has. A caller can lower it
  through `EvaluatorOptions`.
- `SET_CAP` and `CONSTANT_CAP` limit how wide a set of literals grows.

## Testing

`testLowering.ts` is a small language whose nodes are plain objects with
their lowered shape written in, with parent links filled in by
`module()`. The engine tests are written against it, so a change to
the engine can be checked without any adapter.
