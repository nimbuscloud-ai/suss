# Proposal: a value chosen by a ternary resolves to both arms

Status: draft, seeking alignment. Nothing implemented.

## The problem

When the rules reach two different functions for one value, the store
answers nothing, since picking one would make the answer depend on the
order facts arrived in. That policy is right when the ambiguity is
inherent and wrong for a choice the code spells out:

```ts
export const handler = flag ? handlerA : handlerB;
```

The code says the value is both, and says when each. Today it resolves
to nothing, so a handler behind a feature flag disappears from the
summaries entirely.

## The change

The adapter emits one new fact when a declaration's initializer is a
ternary:

```
chooses(site, cond, whenTrue, whenFalse)
```

One rule derives the resolved pair, in plain positive Datalog:

```
choosesResolved(site, cond, fa, fb) :-
    chooses(site, cond, a, b), resolves(a, fa), resolves(b, fb).
```

The store exposes `resolveAlternatives(value)`, which reads that
relation and walks nested choices, so `x ? f : (y ? g : h)` answers
three functions, each with the condition on its path. `resolveCallable`
is untouched: it keeps answering one function or null, and a ternary
still gets null from it.

Nothing that resolves today can regress, because a ternary already
dead-ends in extraction. The new fact adds answers where there were
none. There is no guard column on `comesTo`, no `and`, no guard
algebra, and no change to `@suss/datalog`.

Discovery consumes the alternatives for the feature-flag case: one
unit per alternative, the condition joining the unit's conditions the
way a branch condition already does.

## What stays out

- **A handler branching on `req.method` inside its body.** No value
  chooses between two functions there, so `chooses` never fires; the
  framework-rules proposal covers that shape with `serves(U, M)` and
  method sets.
- **The config-object factory.** "Which property answers" is a pack
  judgment, not a condition in the code; a pack naming the property is
  the same kind of statement as `transparentWrappers` naming an
  argument, recorded in the resolution rules README.
- **Reassignment.** `let h = a; if (c) h = b;` drags in statement
  ordering, and the initializer form covers the production cases seen
  so far.

## Relation to provenance

The backlog entry on provenance ({#datalog-provenance}) describes the
engine recording what supports every derived fact. Full provenance
would subsume this: a store that knows why it believes a resolution
could answer the alternatives question from the support graph. This
proposal does not foreclose that. `chooses` is an extraction fact
either way, and `choosesResolved` would become one query over the
support graph instead of its own rule.

## Order

1. `chooses` from ternary initializers in the TypeScript adapter.
2. The rule and `resolveAlternatives` on the store, with a test for a
   nested choice.
3. Discovery consuming alternatives for the feature-flag handler.
