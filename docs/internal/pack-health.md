# When a pack is probably not working

A run can succeed loudly and still be wrong. Four bugs found in one
day were all visible in the output of the run that produced them, and
nothing was looking:

- A path-engine change left a run's summaries with no transitions on
  any of them.
- A client pack matched hook calls and resolved no documents from any
  of them.
- A checker pass produced findings that were all wrong, because a
  scope match compared everything to everything.
- A stale cache answered with a previous pack's results, because packs
  carry no version. The CLI now hashes each pack's source into its
  stamp, so this one is fixed at the loader; what remains is a caller
  that drives the adapter itself and stamps nothing.

Each of those is a number the run already had. The checks here read
those numbers back and say when one of them looks like a pack that
stopped working.

## One rule, not eight

The extraction funnel already counts what each pack did: files its
gate selected, units it discovered, summaries it built. Most of what
is worth checking turns out to be the same property asked at different
points along that pipeline. **A stage reached zero while the stage
feeding it did not.**

Read as separate checks, these are four things:

- The pack was asked for and found no units.
- The pack found units and none of them bound to a boundary.
- The pack produced summaries with no boundary binding.
- The pack produced summaries with no transitions.

Read as one, they are the same sentence about adjacent pairs of
counts, so that is how they are written. `stagesOf` builds up to four
pairs for a given pack, and `funnelDrops` applies one comparison to
all of them.

Two of those bullets share a pair. "Found units and bound none" and
"produced summaries with no binding" both land on `units claimed`
against `summaries bound`, because a summary that carries no binding
names no pack and cannot be counted against one at all. The cost is a
coarser diagnosis: a pack that claimed units and assembled nothing
gets told it bound none of them, which points at binding when the
failure was assembly. Splitting them needs a per-pack count of
summaries built before binding is attempted, which the assembly path
does not keep.

Two checks do not fit the rule and stay separate. One asks whether a
pack declares a version, which is true or false with no codebase
involved. The other asks whether a pack discovered the same unit
twice.

## The two ways a pack can contribute

A pack that finds units of its own is measured against what its gate
selected. A pack made of recognizers finds nothing by design: it
attaches effects to units other packs discovered, so its own discovery
count is zero on every healthy run.

That is five packs, not a rare case. Prisma, Drizzle, SQS,
EventBridge and the Node runtime pack all declare an empty discovery
list. Exempting them from the funnel would turn a known gap into an
invisible one: if Prisma's recognizers stopped matching tomorrow, the
output of a run would be byte-identical.

So they get a pair of their own. `PackTally` counts the effects each
pack's recognizers returned, and the unit bodies any pack walked in
the files that pack's gate selected. The second is the number that
makes the first mean something: a recognizer only ever runs inside a
unit some pack discovered, so bodies walked in gated files is what the
pack had the chance to match against. Bodies to look at and no effects
from any of them is a recognizer pack that stopped working.

Getting the count required wrapping each recognizer with its owner at
aggregation. The adapter flattens every pack's recognizers into one
list and the pack name is gone by the time one fires, so the wrapper
is the only place that still knows whose it was.

That covers four of the five. The Node runtime pack is ungated,
because what it recognizes needs no import: a `process.env` read is
reachable from any file. Nothing about a run tells us whether that
project was ever supposed to read the environment, and plenty of
codebases never do, so bodies walked with no effects from them is not
evidence of anything. The Node pack therefore stays unmeasured, on the
same rule that keeps React Router from reporting itself broken on
every project that does not use it. Measuring it needs a signal that
the project intended to use the runtime at all, and no such signal
exists today.

## What makes zero a signal

A pack finds nothing on a codebase that does not use its library, and
that is the pack working. So a count of zero on its own is never worth
reporting. The count before it is what decides.

Three things suppress a check that would otherwise fire, and each one
came from watching a false positive:

**The pack has no gate.** An ungated pack is handed every file in the
project, so its candidate count says only that the project has files.
React Router is ungated, and without this it would report itself
broken on every project that does not use it.

**The pack's gate did not resolve.** A gate specifier that does not
resolve means the target's dependencies are not installed, and a pack
that resolves symbols cannot work under that. Making this check work
without a tsconfig was most of the fix: `--dir` runs are the ones
aimed at projects that may not be installed, and the check used to
answer "all fine" for every one of them.

The same evidence decides which stage an empty run is blamed on. A
missing package explains nothing unless some file asked for it, so
`firstEmptyStage` requires a candidate file before it blames
resolution. Without that, a project that simply does not use Express
was told that Express was not installed and to go install it, in the
same output that said no file imports it.

**The summary is on the consumer side.** A provider says what it does
with a request, and that is what transitions record. A consumer says
what it reads back, and that lives on the summary's metadata. Counting
consumers against transitions reports every working client pack as
extracting nothing.

## What fired, and how often

Every built-in pack was run against every target with the cache off,
one pack per run.

| Target set | Runs | Funnel drops | Self-collisions |
| --- | --- | --- | --- |
| This repo's fixtures | 551 | 2 | 0 |
| Saleor Dashboard, Saleor Storefront, Twenty | 285 | 4 | 3 |
| This repo's own 38 packages, through dogfood | 38 | 0 | 0 |

A private monorepo was measured the same way. Both checks fired there
at about the same rate, and every case opened was correct.

One pack per run cannot reach the recognizer pair, since a recognizer
only fires inside a unit another pack discovered. That pair was
measured separately, by re-running every target where some pack
produced summaries with that pack and each recognizer pack together:
125 such pairings over the fixtures, of which the pair was live in 29
and fired in none.

**Funnel drops.** Every one is React Router producing summaries with
no transitions: 30 of them on Saleor Storefront, 11 on Twenty's
website package, 9 on this repo's React fixture. The pack claims
default-exported components and has no terminal that reads a JSX
return, so every summary it produces on a React app that does not use
React Router is empty. Those summaries are output nobody can use, and
saying so is correct whether the pack or the person who asked for it
is at fault.

The other stages fire nowhere now. The units-to-summaries pair fired
while this was being written, and that is how the contract-recognition
bug was found: ts-rest claimed two units on its own fixture and bound
neither, because the boundary took its recognition label from the last
path segment of the pack's import module and every ts-rest summary
therefore said it was recognised by "core". Seven assertions across
three packages had that label written into them.

**Self-collisions.** Three on the public targets, 21 of them in
Twenty's UI package alone, and all correct. The React ones reproduce
in three lines:

```tsx
function Panel() { return <section>x</section>; }
export { Panel };
export default Panel;
```

React discovers `Panel` twice, once through the data-driven default
export pattern and once through the named-export heuristic, whose
guard against re-reading the default export does not catch a default
exported by a separate statement. Dedup keeps the first, and the
surviving summary is named `default` rather than `Panel`. The
AWS Lambda pack collides with itself the same way.

**No declared version.** Quiet on any run started through the CLI,
because the CLI hashes the file each pack was loaded from and folds
that hash into the pack's stamp. Eighteen of the nineteen built-in
packs still declare nothing of their own, and only
`@suss/runtime-node` does, but the loader covers for them.

What is left is the case the loader cannot cover: a caller that builds
the adapter itself and hands it a pack nobody stamped. The dogfood
worker was doing exactly that, which is how it got caught, and it now
stamps its synthetic pack with a hash of the pack's own definition.

Even quiet, this is the check most likely to get the whole report
ignored if it came back. Someone running `suss extract` cannot version
a pack we ship, so printing it on every run would teach them to skim
past the lines above it. Each check therefore names its audience. A
`run` check found something about the code in front of it and prints
whenever it fires; a `pack` check found something about how a pack was
built and waits for `--explain`. The dogfood run asks for both,
because there the pack author is the person reading.

## What was measured and dropped

**A declared pattern that never matched.** Discovery and terminal
patterns carry no identity. Their only handle is `kind`, which
collides within a pack, and recognizers are bare functions with no
name at all. Giving them identity means either asking pack authors for
one or threading an index through the adapter. Neither is worth it,
because the check would be wrong most of the time it fired: the
Express pack generates one discovery pattern per HTTP method, so any
project that never calls `.delete()` leaves a pattern unmatched, and
that is the normal case rather than a fault.

**High confidence on an empty summary.** This one was built and
measured. It fired three times across everything, and none of the
three was right. One was this repo's CloudFormation package, where
three of five summaries are re-exports from another package, so there
is no body to read and an empty summary is the correct answer. The
other two were on a denominator of two.

The check cannot tell "the pack read nothing" from "there was nothing
to read", and that is the whole distinction. The extractor already
draws it where it can, by recording an `unreadOutcome` gap and
dropping to low confidence when it sees returns it could not match.
Where it cannot, the cause is that `assessConfidence` divides zero
opaque conditions by zero total and reads the result as agreement. A
summary with nothing in it comes out at high confidence. Fixing that
arithmetic is worth doing and is not a heuristic.

## What this does not do

**It leaves the Node runtime pack unmeasured.** Four of the five
recognizer packs are gated and get a pair. The Node pack is not, for
the reason above, and it is the one most likely to be in an arbitrary
run.

**"Reached zero" is much weaker than it sounds.** One count above zero
anywhere in a pack's run silences that pair for the whole run. Eleven
empty components plus one loader returning an object reads as healthy,
and on Saleor Storefront a single loader would have hidden all thirty
empty components. A ratio would catch that, and a ratio needs a
threshold, and a threshold needs a distribution to pick it from. The
sweeps here produced single-digit drop counts, which is not enough
shape to choose a number that would not be arbitrary. Zero is the one
threshold that needs no evidence, so it is the one shipped.

**A cache hit skips the report entirely.** The adapter emits no
extraction report when it answers from the cache, because no stage
ran. Health therefore only fires on a cold cache or under
`--no-cache`, and a passing check on a warm run means nothing at all.

**It counts effects without reading them.** The recognizer pair asks
whether any effect came back and stops there. A pack emitting one
effect where it should emit forty looks healthy.

**It does not fail a run.** Every check reports, and the exit code is
what it was.

**It compares against nothing.** There is no baseline and no history,
so a pack that was already producing empty summaries yesterday reads
the same as one that broke this morning.

**It reads counts, not content.** A pack producing one transition per
summary where it should produce four looks healthy.

**It cannot attribute a summary to a pack that failed to label it.**
Everything downstream of the boundary binding groups on `recognition`,
so a pack that writes the wrong label there is measured as two packs.
