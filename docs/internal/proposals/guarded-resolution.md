# Proposal: a value that comes to two things, each under a condition

Status: draft, seeking alignment. Nothing implemented.

## The problem

When the rules reach two different functions for one value, the store
answers nothing, since picking one would make the answer depend on the
order facts arrived in. That policy is right for genuine ambiguity and
wrong for a choice the code spells out:

```ts
export const handler = flag ? handlerA : handlerB;
```

This is not ambiguous. It is both, and the code says when each. Today
it resolves to nothing, so a handler behind a feature flag disappears
from the summaries entirely.

The same shape wears other clothes:

- A `pages/api` handler switching on `req.method`, which answers every
  method through one export. The Next.js pack had to leave those
  unpaired because a REST binding holds one method.
- A wrapper choosing between implementations by environment:
  `createHandler(isProd ? realSender : dryRunSender)`.
- A config-object factory whose callbacks nulled out sixty handlers
  this week. Several properties were each a candidate for the whole
  call. With guards, each candidate would carry "when the wrapper calls
  `.entryLogExtractor`", and a consumer could keep the one guarded by
  the property a pack names, rather than the store discarding all of
  them.

And the deeper connection: a transition already is "this outcome, under
these conditions". Resolution throwing away the condition is the fact
layer being less expressive than the thing it feeds.

## The change

`comesTo` gains a guard column: `comesTo(x, z, g)`, where `g` names a
condition or is the empty guard. The adapter emits one new fact family
for the choices it can already read:

```
chooses(site, cond, whenTrue, whenFalse)   a ternary or an if/else
guardTest(cond, subject, op, literal)      what the condition compares
```

Two rules replace silence with two guarded answers:

```
comesTo(x, z, g) :- chooses(x, c, a, _), comesTo(a, z, g2), and(c, g2, g).
comesTo(x, z, g) :- chooses(x, c, _, b), comesTo(b, z, g2), and(not(c), g2, g).
```

`and` composes guards. The empty guard is the identity, so every
existing rule keeps its meaning by carrying the guard through
unchanged, and a chain with no choices in it derives exactly what it
derives today.

The store's contract widens without breaking: `resolveCallable` keeps
answering a single function or null, and answers null when two guarded
answers exist, exactly as now. A new question sits beside it,
`resolveAlternatives(value)`, returning each function with the guard
that selects it. Discovery consumes that where it makes sense, one unit
per alternative, with the guard joining the unit's conditions the way a
branch condition already does.

## What it deliberately does not do

**Guard language stays tiny.** A guard is a conjunction of tests the
parser saw written down: a comparison against a literal, a truthiness
check, a negation. No solver, no implication, no simplification beyond
dropping duplicates. Two guards are the same when their test sets are
the same, which is enough to merge the two arms of
`x ? f : (y ? f : g)` reaching `f`.

**No reachability claims.** A guard says "the code selects this under
that test", not "this test can be true". Dead configuration stays a
question for the checker.

**Reassignment stays out.** `let h = a; if (c) h = b;` is the same
idea through mutation, and mutation drags in ordering. The ternary and
the if/else expression forms cover the cases seen in production so
far. Reassignment can join later without changing the guard model.

## Where it pays off first

1. The feature-flag handler stops disappearing. Two summaries, one
   guarded by the flag, both checkable.
2. A `pages/api` handler splits into one unit per method it branches
   on, each pairing with the callers of that method. This closes the
   gap #24 documented.
3. The config-factory shape becomes expressible for a pack: "the
   property that answers is `handler`" keeps the one guarded candidate
   and drops the rest, instead of the store nulling everything.

## Cost and risk

The guard column multiplies tuples where choices nest. A chain through
k independent choices carries 2^k guards in the worst case, and real
code keeps k tiny; a depth cap with an explicit "guard dropped, answer
degraded to ambiguous" keeps the pathological case bounded and
recorded rather than slow.

`and` as a computed relation does not fit pure Datalog. The engine
already carries stratified negation, and the join can be implemented as
a functional term the way node identity already is, but this is the
part to design against the engine rather than assume. It is the one
piece that touches `@suss/datalog` itself.

## Order

1. The guard shape and `and`, in `@suss/datalog`, with property tests.
2. `chooses` facts from ternaries in the TypeScript adapter, guards
   carried through `comesTo`, `resolveAlternatives` on the store.
3. Discovery consuming alternatives for the feature-flag case.
4. `req.method` branching, which needs `guardTest` tied to a parameter
   so the split lands as method bindings.
5. The pack-named property for config factories, once guards exist to
   hang it on.
