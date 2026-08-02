# When a pack is probably not working

A run can succeed loudly and still be wrong. Four bugs found in one
day were all visible in the output of the run that produced them, and
nothing was looking:

- A path-engine change left 480 summaries on a production app with no
  transitions on any of them.
- A client pack matched 28 hook calls and resolved no documents from
  any of them.
- A checker pass produced 1,874 findings that were all wrong, because
  a scope match compared everything to everything.
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

Read as one, they are the same sentence about four adjacent pairs of
counts, so that is how they are written. Two counts were added to the
funnel to make the last two pairs exist: how many summaries name this
pack as what recognised them, and how many of those say anything.

Two checks do not fit that rule and stay separate. One asks whether a
pack declares a version, which is true or false with no codebase
involved. The other asks whether a pack discovered the same unit
twice.

## What makes zero a signal

A pack finds nothing on a codebase that does not use its library, and
that is the pack working. So a count of zero on its own is never worth
reporting. The count before it is what decides.

Four things suppress a check that would otherwise fire, and each one
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

**The pack discovers nothing by design.** Prisma, Drizzle, SQS and
EventBridge all declare an empty discovery list. They attach effects
to units other packs found, so discovering nothing is how they always
behave.

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
| This repo's fixtures | 532 | 2 | 0 |
| Saleor Dashboard, Saleor Storefront, Twenty | 285 | 4 | 3 |
| This repo's own 38 packages, through dogfood | 38 | 0 | 0 |

A large private serverless monorepo was measured the same way. Both
checks fired there at about the same rate, and every case opened was
correct.

**Funnel drops.** All eight are React Router producing summaries with
no transitions: 30 of them on Saleor Storefront, 11 on Twenty's
website package, 9 on this repo's React fixture. The pack claims
default-exported components and has no terminal that reads a JSX
return, so every summary it produces on a React app that does not use
React Router is empty. Those summaries are output nobody can use, and
saying so is correct whether the pack or the person who asked for it
is at fault.

The two earlier stages fire nowhere now. They fired while this was
being written, and that is how the contract-recognition bug was found:
ts-rest claimed two units on its own fixture and bound neither,
because the boundary took its recognition label from the last path
segment of the pack's import module and every ts-rest summary
therefore said it was recognised by "core".

**Self-collisions.** Five, all correct, and the React ones reproduce
in two lines:

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
past the lines above it. Each check therefore says who can act on it. A
`run` check found something about the code in front of it and prints
whenever it fires; a `pack` check found something about how a pack was
built and waits for `--explain`. The dogfood run prints both, because
there the pack author is the person reading.

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

- It says nothing about a pack made only of recognizers. Prisma,
  Drizzle, SQS and EventBridge attach effects to other packs' units,
  and no count here reads effects.
- It does not fail a run. Every check reports, and the exit code is
  what it was.
- It compares against nothing. There is no baseline and no history, so
  a pack that was already producing empty summaries yesterday reads
  the same as one that broke this morning.
- It reads counts, not content. A pack producing one transition per
  summary where it should produce four looks healthy.
- It cannot attribute a summary to a pack that failed to label it.
  Everything downstream of the boundary binding groups on
  `recognition`, so a pack that writes the wrong label there is
  measured as two packs.
