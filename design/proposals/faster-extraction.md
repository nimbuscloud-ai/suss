# Proposal: derive what somebody asked for

Status: the recommendation landed. `deriveOnDemand` in `@suss/datalog`
and `RESOLUTION_QUESTIONS` in `@suss/resolution` are what came of it,
and status entry 64 records what they measured. What follows is the
case as it was argued, with one correction at the end where the
implementation contradicted it.

Numbers from the public dogfood targets are given in full. Runs against a
production monorepo are described as ratios, since those figures would
describe somebody else's codebase.

## What the numbers say

We profiled extraction on current main across the public dogfood
targets, three packages from this repo, and five services from a
production monorepo. Every run passed `--no-cache`.

Datalog takes anywhere from no time at all to about a third of a run,
and which one you get depends on the corpus rather than on its size.

| corpus | files | total | datalog | share |
| --- | ---: | ---: | ---: | ---: |
| twenty-server | 5011 | 55.0s | 334ms | 0.6% |
| saleor-storefront | 500 | 2.0s | 58ms | 2.8% |
| this repo, three packages | 3 to 60 | 0.3s to 1.0s | 0ms | 0% |
| production services, three of five | small | 1.2s to 5.0s | 1ms to 194ms | under 4% |
| production service, densest | | | | about a third |

On twenty-server the resolution rules never execute. They do not run and
derive nothing: `comesTo` and `resolves` are never created, and the only
rule sets that run are the reachable closure and the rethrow pass. The
same is true for the three smallest production services and all three
packages from this repo. Resolution costs nothing until a corpus has the
aliasing and re-export density that makes those rules fire.

The old profile that put datalog at 40% was measured on a corpus of the
dense kind, and it still reproduces there: `unify`, `step`, and `lookup`
come within a few percent of the figures it recorded, and together they
are 93% of engine time. On saleor-storefront the same three functions
come to a few milliseconds.

### Where the rest of the time goes

An earlier draft of this proposal said the adapter's own code does not
appear in the profiles and that ts-morph accounts for everything outside
datalog. That was wrong, and twenty-server shows it:

| phase | twenty-server | saleor-storefront |
| --- | ---: | ---: |
| `preFilter` (the transitive-import gate) | 54.4% | 0.0% |
| `expandReachableClosure` | 23.2% | 16.0% |
| `extract per-file` | 13.6% | 64.4% |
| `synthesizeSubUnits` | 0.0% | 9.3% |
| datalog | 0.6% | 2.8% |

Half of the largest public corpus goes into the import gate, which
resolves the same import edges about fifteen times over. That is suss's
own code rather than a parser, and a separate change is addressing it.
Where the gate is cheap, `extract per-file` dominates, and that bucket is
mostly time spent inside ts-morph API calls.

Garbage collection is 14.1% of a run where datalog never executes and
7.0% of the run where it dominates, so most of it belongs to ts-morph
and will not move if we change the engine. Peak resident set tracks file
count rather than datalog.

### Inside datalog

On saleor-storefront, the rules that cost the most and derive the least:

| ms | share | tuples | attempts | rule |
| ---: | ---: | ---: | ---: | --- |
| 11 | 20.4% | 101 | 43 | `flowsToParam <- binds, paramOf` |
| 5 | 8.1% | 1 | 104 | `comesTo <- readsProperty, objectOf, holdsProperty, comesTo` |
| 4 | 6.8% | 520 | 76 | `resolves <- comesTo, func` |
| 4 | 6.8% | 197 | 62 | `isWrittenAs <- binds, isWrittenAs` |
| 3 | 6.0% | 14 | 153 | `objectOf <- call, comesTo, returnsValue, comesTo, objectValue` |
| 3 | 5.9% | 1 | 143 | `comesTo <- call, comesTo, unwraps, callArg, comesTo` |

Attempts still run far ahead of tuples. `objectOf` is tried 153 times to
win 14 tuples, and the wrapper rule 143 times to win one. That gap
between how often a rule runs and how often it concludes anything is
what demand-driven derivation closes, and it survives the `objectOf`
composition rather than being fixed by it.

### How it scales

Synthetic fact bases built to look like a codebase, doubling each step:

| facts | comesTo | evaluation |
| ---: | ---: | ---: |
| 5400 | 4560 | 242ms |
| 10800 | 9120 | 765ms |
| 21600 | 18240 | 2947ms |
| 43200 | 36480 | 13258ms |

Each doubling multiplies time by 3.2, then 3.9, then 4.5. Evaluation
grows as roughly the square of the derived tuple count and the exponent
drifts upward. The corpora where suss is slow are not the large ones,
and the curve says the next density up is worse than proportionally
slow.

## The measurement that carries the case

The question is how much of what the rules derive any caller needs.
Three ways of answering it, in increasing order of how far to trust
them.

**The forward walk, which should not be trusted.** Following `comesTo`
edges from the values callers query reaches a small fraction of the
relation. It is unreliable in both directions. It misses demand that
arrives through a rule body rather than along a `comesTo` edge, so on the
dense production corpus it comes out 2.1 times below what a rewrite
needs. On a large frontend corpus it returns zero, because not one
queried value appears as the subject of any derived pair, which if you
read it literally claims a 100% saving. A number that can be half the
truth on one corpus and infinitely wrong on another should not be the
basis for an argument.

**The support closure, which is the argument.** We enumerated every rule
instantiation over the completed database, then closed backwards from
the tuples the store actually read. That gives the minimum any correct
evaluator has to derive to answer the questions callers asked. On the
dense production corpus the minimum comes to about 4.5% of the `comesTo`
pairs we derive today, and to about the same fraction across all the
derived relations together.

**What a rewrite actually derives.** A magic-sets rewrite generated from
`RESOLUTION_RULES` derives about 13% more than that minimum. Somebody
reading this should want to know whether a demand-driven evaluator would
turn round and derive a different pile of slop, bookkeeping predicates
in place of unread tuples. On this workload it does not. It comes close
enough to the floor that the remaining headroom is small.

### The gate, and the term to watch

We ran the gate described below on seven corpora and measured what
fraction of today's derivation a demand-driven run still performs,
counting the magic bookkeeping as work. It ranges from 1.7% to **8.9%**,
and saleor-dashboard is the worst. Nothing came close to the 30% that
would have promoted interning above this.

8.9% is the figure to plan against rather than 1.7%. The gap between
them is bookkeeping: we store magic predicates too, at roughly 2.8 per
seed, and that count grows with how many distinct values a corpus asks
about rather than with the corpus itself. saleor-dashboard asks about
1807 distinct values where the dense production service asks about fewer
than a hundred, which is the whole difference. A corpus that queried
broadly enough would erode the win, and the gate is how we would notice.

## What we tried and rejected

We measured each one. Two contradicted a confident prediction.

**Reordering the expensive rules by hand.** Both property rules, in the
form they had before the `objectOf` composition, ended at
`holdsProperty(obj, n, held)`, so testing that literal early should kill
the branch before five other literals do their work. Moving it second
made the dense corpus twice as slow, with every test still passing. Many
objects have a property named `handler`, so the early lookup returns a
large bucket rather than an empty one.

**Driving each join from the delta literal.** The standard semi-naive
form, rather than leaving the delta in body position, made the dense
corpus **twelve times slower**, with byte-identical summaries and all
tests passing. Together with the reordering result, that is two
independent reasons to rank indexing and join order last.

**Evaluating once instead of as queries arrive.** The store re-derives
whenever a query finds it stale, and that was our first candidate for
the quadratic. Against the same facts fed in 100 batches versus all at
once, the penalty was 1.5x at the smallest size and fell to 0.9x at the
largest. Semi-naive resume is doing its job.

**Merging the two closures.** `comesTo` and `isWrittenAs` recurse
through the same `binds` and `imports` edges and differ only in which
values they stop at. They overlap on 8% of their pairs, so a merged
relation saves about 4%, which does not pay for the change.

## What has already landed, and does not need this proposal

An earlier draft treated the two property rules that derived nothing on
the dense corpus as one finding. They were not the same rule.

The four-literal one fired on code people wrote: 22 tuples on a large
frontend corpus, 20 on saleor-dashboard, 1 on saleor-storefront. It was
never a deletion candidate.

The seven-literal one derived zero on all six corpora where resolution
runs at all, while costing seconds on the dense ones, and it was the
four-literal rule with one step written out in full. Composing the two
through a named `objectOf` relation cut engine time by 13.3%, with every
test passing and byte-identical summaries, including on a corpus where
the property rule does fire. That has landed.

So the roughly 11% of total run time that removing both rules would have
bought was never all waiting on this proposal. About half of it has
already landed, with no rewrite risk and no failing test. Judge this
proposal on what is left after that.

## The options, ranked

**1. Demand-driven derivation.** Seed a `wanted(x)` relation from the
values callers ask about and rewrite each recursive rule to derive a
pair only when its subject is wanted, passing wantedness down the body
the way magic sets does. Saving: on the gate's worst corpus a
demand-driven run does 8.9% of today's derivation, and the fraction
improves as density rises, which is the direction that hurts today.
Cost: the highest of the five, a rewrite pass over `Rule[]` plus a way
for the store to assert demand. Risk: a rewrite that drops a needed
derivation gives a wrong answer rather than a slow one, which is the
risk to take seriously. Measurable first: yes, and it has been, on seven
corpora.

**2. Interning atoms to integers.** `unify` and `lookup` are 62% of
engine time. `lookup` builds a fresh string through `atomKey` on every
index probe, `keyOf` maps and joins an array per tuple, and `unify`
copies a `Map` per candidate tuple. Interning atoms once would make
`atomKey` the identity, let indexes key on numbers, and let bindings be
a slot array. Contained inside `@suss/datalog`, no rule changes, low
risk. We set the gate up to promote this if demand turned out weak. It
did not, so this stays second, and the two compose.

**3. The import gate.** Half of twenty-server. It is outside this
proposal's scope but larger than it on that corpus, and worth saying
plainly so nobody mistakes the ranking here for a ranking of the whole
pipeline.

**4. Per-file content-hash caching.** This makes the second run fast and
does nothing for the first, which is the case people complain about.

**5. Indexing and join order.** Ranked last on two measurements rather
than on taste. `lookup` already indexes any bound column on first use,
and both attempts to improve on that made things dramatically worse.

## Recommendation

Do demand-driven derivation first. Measure its saving against a
baseline that already includes the `objectOf` composition, so the two
are not credited with the same win.

To know it worked: engine time and derived tuple counts per relation on
saleor-storefront and the dense production corpus, both from
`--datalog-profile`, which now reports each rule's share and marks which
relations rules derived. Summaries must stay byte identical on every
corpus, which matters more than the timing.

## The questions this has to answer

**Could smaller pieces compose to this?** Demand is one relation and one
rewrite over rule data, not a new engine mode. `wanted(x)` is a fact
like any other. The `objectOf` composition was a smaller piece that
reached part of the same win, and it went first for that reason.

**Does it reuse what exists?** The rewrite produces `Rule[]`, which the
existing stratifier and semi-naive loop already run. The store already
has the seam: `seedValue` marks it stale for exactly the values callers
ask about, and those are the seeds.

**Does it widen shared vocabulary?** No knob reaches pack authors. Rules
stay written as they are and the rewrite happens inside the engine.

**Is it over-designed?** A rewrite pass and one relation. It leaves out
subsumption, provenance, and any cost model.

**Is the naming consistent with `docs/internal/style.md`?** `wanted(x)`
states what is true of a value rather than instructing the engine.

**Was it verified against code somebody actually wrote?** Seven corpora,
three of them public. We rejected two candidates because measurement
contradicted a confident prediction, and we revised the headline number
upward by a factor of two when a better method replaced a naive one.

**What does it not do?** It does not touch the import gate, which is
larger on twenty-server than everything here. It does not help corpora
where the resolution rules never run, which is most of them. It does not
reduce peak memory. It does not make extraction incremental across runs.

## Two results from the sweep worth recording

`suss extract` cannot complete on saleor-dashboard: stringifying the
summaries throws `Error: Invalid string length`, so that corpus produces
no output file today. A separate change fixes it. Every saleor-dashboard
figure quoted here comes from instrumentation that runs before the
failure.

On twenty-server the resolution rules never execute, which is worth
stating more sharply than "datalog is quiet there". A change that makes
resolution faster does nothing at all for that corpus.

## The instrumentation

Producing these numbers needed the engine to say which rule was
expensive, which a CPU profile cannot: rule cost is spread across
`unify`, `step`, and `lookup`, and those names say how the engine works
rather than which rule asked for the work.

`@suss/datalog` gains `profileEvaluation(fn)`, which reports time and
tuples per rule with each rule's share of engine time, tuple counts per
relation marked by whether a rule derived them, a per-rule-set
breakdown, evaluations, and rounds to fixpoint. The collection hooks run
at rule attempts and rounds, never per tuple. The CLI exposes it as
`suss extract --datalog-profile`.

We checked the overhead rather than assuming it: alternating A/B builds
put the whole-run difference inside noise, an engine-only microbenchmark
put it at most 1.5% of engine time, and profiled and unprofiled runs
produce byte-identical summaries and byte-identical relation dumps down
to tuple order.

## Reproducing the numbers

```
suss extract -p tsconfig.json -f <packs> --no-cache --timing --datalog-profile
node --cpu-prof --cpu-prof-dir=<dir> $(which suss) extract -p tsconfig.json \
  -f <packs> --no-cache
```

Build the worktree with its own `npm install` before timing anything, or
`@suss/*` resolves to another checkout's `dist` and the numbers describe
that build instead.

## Order

1. `wanted(x)` and the rewrite in `@suss/datalog`, with the existing
   resolution tests as the correctness bar.
2. The store asserting demand from `seedValue`, behind a flag, with
   summaries compared byte for byte on every corpus.
3. Re-run the gate. It is cheap, and it is the check that bookkeeping
   has not eaten the win on a corpus that queries broadly.

## What building it said that this did not

**The gate was right about the tuples.** Counting only the relations the
rewrite covers, saleor-dashboard derives 8.9% of what it used to, which
is what the gate predicted, and 7012 of the 8723 tuples it still derives
are magic bookkeeping. twenty-front comes to 2.8% and directus/api to
3.8%. We rejected two candidates in this document because measurement
contradicted a prediction; we promoted this one because measurement
matched one.

**One `wanted(x)` was not enough.** The recommendation above describes a
single asking fact seeding every question, and that made directus/api
four times slower in the engine rather than faster. Following a name
back to the library it came from goes through every call the value's
function makes, so a single asking fact demanded the whole call graph
for values whose caller only wanted to know what a handler resolves to.
Almost nothing on that corpus asks the origin question. Splitting it
onto its own fact, `wantedOrigin(x)`, turned a four times slowdown into
a ten times speedup on the same corpus, and cost nothing on the two
where the win was already large.

The general point behind that: a demand relation that answers more
questions than the caller asked is not demand. Which questions a caller
asks is part of the rewrite's input, not a detail below it.

**Rounds go up while time goes down.** A demand-driven run takes about
half again as many semi-naive rounds to reach fixpoint, because demand
has to travel down before answers travel back up. Rounds are the wrong
thing to watch here; the tuple counts and the clock agree with each
other and disagree with the round count.
