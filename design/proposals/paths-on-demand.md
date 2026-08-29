# Proposal: state the control flow, work out the paths when asked

Status: draft. Nothing built.

## Why there is a cap

`enumerateStructuredPaths` takes a lowered function body and builds
every control-flow path through it. Past 256 it throws
`PathBudgetExceeded`, and then every terminal in that body comes back
under one condition nobody can read:

```
unmodeled control flow (path budget exceeded, more than 256 paths)
```

This looks like the bounded walks we took out in 0.20.0, and it is a
different thing. Those stopped after four hops because somebody picked
four, and they missed answers that were sitting right there. This one
stops because a function with n branches in a row really does have 2^n
paths, and we build each one.

We build each one on purpose. When a terminal can be reached three ways,
we want three entries with their own conditions instead of one entry
with a made-up conjunction. That is what a transition tells you that a
count of `if` statements does not.

## Facts do not fix this one

A rule deriving `pathCondition(terminal, conjunction)` produces
exponentially many tuples for the same function. The engine has no cap
and runs to fixpoint, so a body that degrades today would grind. I am
writing this down because we spent 0.20.0 replacing walks with rules and
this is the case where that trade does not work.

## What would fix it

State the control flow instead of its paths:

- `edge(from, to)` for each step in the lowered body
- `guard(edge, condition, polarity)` where a branch chose it
- `ends(node, terminal)` where a path can stop

That is linear in the size of the body. Ask what conditions apply at a
terminal and you get that without the other 2^n paths ever being built. A checker that wants to know whether a 404 is reachable asks for
that one thing.

## What it costs

`BehavioralSummary.transitions` is the enumerated paths. Every checker
reads it, `inspect` renders it, the intent layer compares against it,
and a published summary contains it. Working out paths on demand means a
summary contains the graph and consumers derive what they want, or it
contains both and gets bigger.

That makes this a change to the artifact we publish. Three things follow:

- Today a consumer that wants one question answered pays for every path.
- A consumer that wants to show every path would now build them itself.
- Two versions of suss would disagree about what a summary contains. The
  schema version covers that, and it is still a migration.

## Why it came up

Composing a meta-function onto a unit (#726) puts the wrapped unit's
paths at the continuation, so counts multiply. I measured it on a field
service and they stay small: a route wrapped in an auth middleware comes
to about 12 paths against a cap of 256. #726 does not need this. On a
graph, composing is adding edges and the multiplication never happens.

`suss ask` reports on one question about one boundary and enumerates
everything to do it. Watch mode and the agent-facing work want a graph
you can query rather than a document you read whole.

## What I am not proposing

Taking the cap out and leaving the representation alone. Degrading is
the right answer for a body we cannot read affordably, and it says so
instead of guessing.

This is also not urgent. The heaviest corpus run never degrades a
transition, so we are losing nothing today. I want it decided before the
summary format hardens further.

## What to decide

1. Does a summary contain the graph, the paths, or both?
2. Can the checkers be written to ask questions instead of reading a
   list? That is where the work in this change actually goes.
3. Does this wait for the intent layer? It reads transitions heavily and
   would pay the migration twice if it lands first.
