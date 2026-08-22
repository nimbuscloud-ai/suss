# Proposal: compile packs to rules, and keep the simple interface

Status: draft, seeking alignment. Nothing implemented.

## The problem

A pack today is data in a closed vocabulary. `match.type` is an enum
the adapter switches on with a hand-written walker per variant, and
every framework that does something the enum does not cover widens the
enum for everybody.

The Next.js work widened it three times in one afternoon.
`fromFilename` grew `root`, `dropBasenames`, `dynamic`,
`dropParenthesized`, and `flat`. `functionCall` grew a dotted name and
then a `new` expression. `statusCode` grew `argumentProperty`. Each one
is a knob every other pack now inherits.

The cost lands in two different places, and telling them apart is what
decides how much of this to do.

## Two problems that look alike

**Some of it is the walkers being wrong.** Review found three bugs in
the new code, and none of them needs a pack to say anything it cannot
say today:

- `functionCall` matching `new` made `throw new Response(...)` produce a
  throw *and* a response, for every pack, because the walker never asks
  where the value is. A walker that requires return position fixes it
  with no change to any pack.
- `dropBasenames` is a list of filenames applied to every segment, so
  `app/route/route.ts` serves `/`. The knob means the right thing and
  the walker applies it in the wrong place.
- The route root is found by searching the path and guessing which
  occurrence, so a segment named `app` truncates the route. Anchoring
  at the project root fixes it, and the project root is something the
  adapter knows.

**Some of it is the vocabulary running out.** React Router derives
routes from filenames only when the project opted in by importing
`@react-router/fs-routes`. Nothing in the pack language expresses a
premise like that. The options are a knob for this one case, or a way
for a pack to state a condition the language did not anticipate.

That second kind is rarer, and it is the kind that decides whether
somebody outside this repo can write a pack for a framework we have not
seen. "Add a framework in one file" is true today for frameworks that
fit the vocabulary we already wrote down.

## What already exists

`packages/adapter/typescript/src/facts` writes a source file down as
flat tuples and runs rules over them on `@suss/datalog`. Its README
says why:

> Rules compose, so a handler wrapped twice and then re-exported
> through a barrel resolves even though nobody wrote a rule for that
> combination. That is the reason to write rules rather than one walker
> per pattern.

That argument is not specific to resolution. Discovery and terminals
are where the walkers are.

## The change, in three layers

**The pack interface stays what it is.** Most packs never change, and a
pack stays data that can be validated and reviewed.

**The adapter compiles a pack to rules** instead of switching on
`match.type` in a walker per variant. None of this is user-visible.
What it buys is one evaluation model rather than a dozen walkers, and
derived facts that compose the way the resolution facts already do.

**A pack can state a rule where the declarative form cannot say what it
means.** This is the escape hatch rather than the front door. React
Router's opt-in is the first case in this batch that needs it.

Keeping it rare is the point. A pack that drops to rules is harder to
write and harder to review, and two packs using the same relation name
can mean different things. Rules are worth it where the framework's
judgment is conditional or compositional, which is where the knobs have
been piling up.

## What the facts have to carry

Facts stay mechanical and framework-neutral, which is the discipline
that keeps this from turning into a second language. The adapter
parses, and the rules decide. There are three families beyond what the
facts include today:

- **Where a file is.** `fileSegment(file, index, text)`, plus the
  form of a segment the parser can see without knowing any framework:
  `bracketed(file, index, inner)`, `parenthesized(file, index, inner)`,
  `dollarPrefixed(file, index, inner)`, `dotPart(file, index, part,
  text)`, and `projectRootSegment(file, index)` from where the tsconfig
  is.
- **Where a value is.** `returnedValue(unit, value)` and
  `thrownValue(unit, value)` as separate relations, with
  `constructedBy(value, name)`, `callee(value, name)`,
  `argOf(value, index, arg)`, `propertyOf(object, name, value)`,
  `literalNumber(value, n)`.
- **What a branch tests.** `branchesOn(unit, subject, literal)`.

String surgery stays in extraction. Rules match and join, and they do
not compute strings. A rule can ask whether a segment is bracketed and what
was inside the brackets, because the parser wrote both down. It cannot
ask for a regular expression.

Separating `returnedValue` from `thrownValue` is what makes the
throw-counted-as-a-response bug unrepresentable rather than fixed,
which is worth more than the fix.

## What a rule looks like when a pack needs one

React Router's opt-in, which has no declarative form today:

    usesFileRoutes() :- fileSegment(F, _, "routes.ts"),
                        imports(F, "@react-router/fs-routes").

Its route rules take that as a premise, so a project that configures
its routes explicitly derives nothing. That is the correct answer and
the one the current implementation cannot give.

A handler that serves several methods, which the REST binding has no
room for either way:

    serves(U, M) :- branchesOn(U, "req.method", M).

## Cost and risk

The fact base grows, and extraction is already the expensive stage. The
existing store responds in waves and widens only when an answer is
missing, and routing facts are per file and cheap, but we need to
measure this on a production repo rather than assume it.

An open relation namespace is the risk that comes with the escape
hatch. Giving each pack a namespace for its own relations, and
reserving the families the adapter emits, is the smallest thing that
prevents a collision.

## Order

1. Fix the walkers. Those are wrong answers today and the fixes are
   small, whatever happens to the architecture underneath.
2. Compile discovery and terminals to rules, with no pack changing.
   This is the piece that pays for itself and the piece to measure.
3. Open the escape hatch, driven by React Router's opt-in rather than
   designed in the abstract.
4. Method sets, which need the binding to have room for more than one
   method whichever way the rest goes.
