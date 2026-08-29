# Proposal: state the control flow, derive the paths when asked

Status: draft, seeking alignment. Nothing implemented.

## The cap, and why it is there

`enumerateStructuredPaths` walks a lowered function body and produces
every control-flow path through it as its own object. Past 256 it throws
`PathBudgetExceeded`, the caller catches it, and every terminal comes
back reachable under one condition nobody can read:

```
unmodeled control flow (path budget exceeded, more than 256 paths)
```

The cap is not a bounded walk of the kind the resolution work replaced.
Those walks stopped after four hops because somebody picked four, and
they missed answers that were there. This one stops because its output
is genuinely exponential: a function with n sequential branches has 2^n
paths, and the enumeration materialises each one.

That is a deliberate reading. The engine's own header says a terminal
reachable along several paths becomes several entries rather than one
branch with an invented conjunction. Keeping the distinct conjunctions
is the point, and it is what makes a suss transition say something an
`if` count cannot.

## Restating it as facts changes nothing

A rule deriving `pathCondition(terminal, conjunction)` derives
exponentially many tuples for the same function. The datalog engine runs
to fixpoint with no cap, so a body that trips the budget today would
grind instead of degrading. Moving the same output onto rules buys
nothing here, which is worth writing down because the rest of the
0.20.0 work made the opposite trade and somebody will reasonably ask.

## What would change it

State the control flow rather than its paths:

- `edge(from, to)` for each step in the lowered body
- `guard(edge, condition, polarity)` where a branch chose it
- `ends(node, terminal)` where a path can stop

That is linear in the size of the body. The conditions on a terminal are
then a question asked against those facts, and nothing materialises
until somebody asks. A checker asking whether a terminal is reachable when the status is 404
gets that answer without the other 2^n paths ever existing.

## What it costs

The enumerated transitions are the summary. `BehavioralSummary.transitions`
is what every checker reads, what `inspect` renders, what the intent layer
compares against, and what a published summary contains. Deriving on
demand means either a summary contains the graph and consumers derive
what they need, or it contains both and grows.

So this is a question about the published artifact, not an internal
refactor. It should be argued on those terms:

- A consumer that wants one question answered pays for every path today.
- A consumer that wants to render every path wants them enumerated, and
  would now do that work itself.
- Two suss versions could disagree about what a summary contains, which
  the schema version exists for but which is still a migration.

## Why it comes up now

Composing a meta-function onto a unit (#726) substitutes the wrapped
unit's paths at the continuation, so the counts multiply. Measured on a
field service they stay small, a route wrapped in an auth middleware
composes to about 12 paths against the cap of 256, so #726 does not need
this. On a graph, composition is adding edges and the multiplication
never happens at all.

Two other things point the same way. `suss ask` answers one question
about one boundary and pays full enumeration to do it. The watch-mode
and agent-facing direction wants a graph that can be queried rather than
a document that must be read whole.

## What I am not proposing

Removing the cap without changing the representation. The degradation
path is the right answer for a body suss cannot read affordably, and it
says so in the output rather than guessing.

Nor is this urgent. The heaviest corpus run never degrades a transition,
so nothing is being lost today. It is worth deciding
before the summary format settles further, not before the next release.

## What to decide

1. Whether a summary should contain the graph, the paths, or both.
2. Whether the checkers can be written against questions instead of a
   list, which is the load the change actually puts on them.
3. Whether this waits for the intent layer, which reads transitions
   heavily and would pay the migration twice if it lands first.
