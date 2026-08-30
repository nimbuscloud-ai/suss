# Proposal: state the control flow, work out the paths when asked

Status: measured and turned down for the published summary, 2026-08-29.
Keep enumerated transitions. The graph is worth building inside
extraction if composition wants it, and it should not change what suss
publishes.

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

## What a graph would look like

State the control flow instead of its paths:

- `edge(from, to)` for each step in the lowered body
- `guard(edge, condition, polarity)` where a branch chose it
- `ends(node, terminal)` where a path can stop

That is linear in the size of the body. Ask what conditions apply at a
terminal and you get that without the other 2^n paths ever being built.

## What the numbers say

I expected the graph to make a published summary smaller, since
enumerating paths repeats a condition once per path that has it.
Measured over 412 summaries extracted from this repo, it does not.

Transitions are 70% of a summary's bytes. Inside them:

| | share of transitions |
|---|---|
| output, the response shapes | 69% |
| effects | 18% |
| conditions | 10% |
| everything else | 3% |

Conditions are the only part a graph deduplicates, so they are about 7%
of the file, and they repeat 1.32 times on average. Moving to a graph
saves under 2% of the bytes.

The tail does not rescue it. Ten of the 412 units have five or more
transitions and repeat conditions 2.02 times. The widest is 8
transitions and 16KB, and those bytes are response shapes rather than
repeated conditions. A graph keeps response shapes exactly as they are.

## So the answer is no, for the published summary

The reason size mattered is that summaries travel. A library ships them
beside its types, and an agent pays tokens to read one. A change that
saves 2% does not earn a migration of `BehavioralSummary.transitions`,
which every checker reads and anything outside this repo may read too.

The exponential the cap guards against does not fire either. The
heaviest corpus run degrades no transitions at all.

That leaves answering questions without building every path, which is a
matter of how extraction works inside rather than what it publishes.

## What to do instead

- Keep enumerated transitions as the published artifact. Nothing about
  the schema changes and no consumer migrates.
- Keep the cap and its degradation. It is the right answer for a body
  suss cannot read affordably, and it says so instead of guessing.
- If composing meta-functions (#726) ever wants a graph, build it inside
  extraction and enumerate at the end. Composing on a graph is adding
  edges, and the multiplication never happens. The measured composition
  cost today is about 12 paths for a route wrapped in an auth
  middleware, against a cap of 256, so nothing forces this yet.

## What this leaves open

`suss ask` answers one question about one boundary and enumerates
everything to do it. Watch mode and the agent-facing work want a graph
that can be queried. Both are arguments about how suss works out an answer rather than about
what a summary contains, and either can be taken up without touching
the format.

The checkers turned out not to be the obstacle I assumed. Eighteen
production files read `.transitions`, and they ask for existence
(`.some(ct => ct.isDefault)`), a subset by status, emptiness, or a fold
gathering every field some path tests. A graph can answer all of those directly, and the folds get cheaper. Nothing indexes into
paths as an ordered list. So if a reason to move ever does turn up, the
checkers will not be what blocks it.
