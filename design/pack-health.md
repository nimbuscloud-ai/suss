# When a pack is probably not working

A run can finish without complaint and still be wrong. We found four
bugs in one day that were all visible in the output of the run that
produced them, and nothing was checking for them:

- A change to the path engine left every summary in a run with no
  transitions.
- A client pack matched hook calls and resolved no documents from any
  of them.
- A checker pass produced findings that were all wrong, because a
  scope match compared everything with everything.
- A stale cache returned a previous pack's results, because a pack has
  no version on it. The CLI now hashes each pack's source into its
  stamp, so the loader fixes this one. What's left is a caller that
  drives the adapter itself and stamps nothing.

In each case the run already had a number that showed the problem.
The checks here read those numbers back and report when one of them
looks like a pack that stopped working.

## One rule covers most checks

The extraction funnel already counts what each pack did: the files its
gate selected, the units it discovered and the summaries it built. Most
of what we want to check turns out to be the same question asked at
different points along that pipeline. **Did a stage reach zero while
the stage feeding it did not?**

Written as separate checks, there are four:

- The pack was asked for and found no units.
- The pack found units and none of them bound to a boundary.
- The pack produced summaries with no boundary binding.
- The pack produced summaries with no transitions.

All four say the same thing about a pair of neighboring counts, so we
wrote them as one rule. `stagesOf` builds up to four pairs for a given
pack, and `funnelDrops` applies one comparison to all of them.

Two of those bullets use the same pair. "Found units and bound none"
and "produced summaries with no binding" both compare `units claimed`
with `summaries bound`. A summary with no binding on it doesn't record
which pack made it, so we can't count it against any pack at all. The
cost is a less precise diagnosis. A pack that claimed units and
assembled nothing is told it bound none of them, which points at
binding when the failure was in assembly. To tell them apart we would
need a per-pack count of the summaries built before binding is tried,
and the assembly path does not keep one.

Two checks don't fit the rule and stay separate. One asks whether a
pack declares a version, which is true or false without looking at any
codebase. The other asks whether a pack discovered the same unit twice.

## The pack the funnel cannot reach

A pack that finds its own units is measured against what its gate
selected. A pack made of recognizers finds nothing by design, because
it attaches effects to units that other packs discovered. So its own
discovery count is zero on every healthy run.

Five packs work this way, so it is not a rare case. Prisma, Drizzle,
SQS, EventBridge and the Node runtime pack all declare an empty
discovery list. If we left them out, nothing would look wrong,
and a known gap would become one nobody can see. If Prisma's
recognizers stopped matching tomorrow, a run's output would be
byte-identical.

So we built a pair of counts for them. `PackTally` counts the effects
each pack's recognizers returned, and the unit bodies any pack walked
in the files that pack's gate selected. The reasoning was that a
recognizer only runs inside a unit some pack discovered, so the bodies
walked in gated files are what the pack had a chance to match against.

Once we measured it, we removed it. Over the fixtures the pair was
live 29 times and never fired, which made it look like a quiet check.
On a private monorepo it fired on nearly every case where it was live.
When we opened those cases, we found that the earlier count does not
describe the pack at all. The bodies walked in gated files count what
the pack's *companions* found.

The clearest case ran the Drizzle pack twice over one service. Paired
with the pack that discovers that service's handlers, Drizzle returned
effects and looked healthy. Paired with a client pack instead, it
looked broken. The client pack found a call site in a file that
happens to import `drizzle-orm`. Drizzle correctly matched nothing
inside that particular body, and the check reported Drizzle as broken
for it. Whether a pack is working cannot depend on which unrelated pack
someone ran next to it.

Broad gates make it worse. The SQS pack gates on `aws-lambda` as well
as on the SDK, to catch the consumer side. So every Lambda handler in a
service counts as a body where SQS should have matched something.

No cheaper earlier count fixes this. Only something that understands
the library's API can tell whether a recognizer should have fired
inside a given body, and that is the recognizer itself. Any stand-in at
the file level is too loose, because code often imports a library into
a file whose walked bodies have nothing to do with it.

So we removed the pair and kept the counts. A run reports how many
bodies a recognizer pack could look inside and how many effects came
back. That lets you read those five packs in the funnel, where
otherwise you would see three zeros next to their name. Nothing judges
them. **No check here measures five packs: Prisma, Drizzle, SQS,
EventBridge and the Node pack.** The Node pack would be out of reach
anyway, because it has no gate. Reading `process.env` needs no import,
and plenty of codebases never read one.

## What makes zero a signal

A pack finds nothing on a codebase that doesn't use its library, and
that means the pack is working. So a count of zero is never worth
reporting by itself. The count before it decides.

Three things suppress a check that would otherwise fire, and we added
each one after seeing a false positive:

**The pack has no gate.** A pack with no gate is given every file in
the project, so its candidate count only tells you the project has
files. React Router has no gate, and without this suppression it would
report itself broken on every project that doesn't use it.

**The pack's gate did not resolve.** When a gate specifier does not
resolve, the target's dependencies are not installed, and a pack that
resolves symbols cannot work without them. Most of the fix was making
this check work without a tsconfig. `--dir` runs are the ones aimed at
projects that may not be installed, and the check used to say "all
fine" for every one of them.

The same evidence decides which stage an empty run is blamed on. A
missing package explains nothing unless some file asked for it, so
`firstEmptyStage` needs a candidate file before it blames resolution.
Before that, a project that didn't use Express at all was told Express
was not installed and to go install it, in the same output that said
no file imports it.

**The summary is on the consumer side.** A provider says what it does
with a request, and transitions record that. A consumer says what it
reads back, and that goes in the summary's metadata. Counting consumers
against transitions would report every working client pack as
extracting nothing.

## What fired, and how often

We ran every built-in pack against every target with the cache off,
one pack per run.

| Target set | Runs | Funnel drops | Self-collisions |
| --- | --- | --- | --- |
| This repo's fixtures | 551 | 2 | 0 |
| Saleor Dashboard, Saleor Storefront, Twenty | 285 | 4 | 3 |
| This repo's own 38 packages, through dogfood | 38 | 0 | 0 |

We measured a private monorepo the same way. Both checks fired there
at about the same rate, and every case we opened was correct.

We also re-ran every target where some pack produced summaries, with
that pack and each recognizer pack together. That was 125 pairings over
the fixtures, plus the same sweep over a private monorepo. This is the
sweep that led us to remove the recognizer pair described above.

**Funnel drops.** Every one is React Router producing summaries with no
transitions: 30 on Saleor Storefront, 11 on Twenty's website package
and 9 on this repo's React fixture. The pack claims default-exported
components and has no terminal that reads a JSX return. So every
summary it produces on a React app that doesn't use React Router is
empty. Nobody can use those summaries, and reporting that is correct
whether the pack or the person who asked for it is at fault.

The other stages fire nowhere now. The pair from units to summaries
fired while we were writing this, and that is how we found the
contract-recognition bug. ts-rest claimed two units on its own fixture
and bound neither. The boundary took its recognition label from the
last path segment of the pack's import module, so every ts-rest
summary said it was recognised by "core". Seven assertions across three
packages had that label written into them.

**Self-collisions.** There were three on the public targets, with 21 of
them in Twenty's UI package alone, and all were correct. The React ones
reproduce in three lines:

```tsx
function Panel() { return <section>x</section>; }
export { Panel };
export default Panel;
```

React discovers `Panel` twice. It finds it once through the data-driven
default export pattern, and once through the named-export heuristic.
That heuristic has a guard against reading the default export again,
but the guard misses a default exported by a separate statement. Dedup
keeps the first one, and the summary that survives is called `default`
instead of `Panel`. The AWS Lambda pack collides with itself the same
way.

**No declared version.** This check stays quiet on any run started
through the CLI, because the CLI hashes the file each pack was loaded
from and folds that hash into the pack's stamp. Eighteen of the
nineteen built-in packs still declare no version of their own, and
only `@suss/runtime-node` does, but the loader covers for them.

What is left is the case the loader cannot cover: a caller that builds
the adapter itself and passes it a pack nobody stamped. The dogfood
worker was doing exactly that, which is how we caught it. It now
stamps its synthetic pack with a hash of the pack's own definition.

Even though it is quiet, this is the check most likely to get the whole
report ignored if it came back. Someone running `suss extract` cannot
version a pack we ship, so printing it on every run would teach them
to skim past the lines above it. So each check says who it is for. A
`run` check has found something about the code in front of it, and it
prints whenever it fires. A `pack` check has found something about how
a pack was built, and it only prints with `--explain`. The dogfood run
asks for both, because there the person reading is the pack author.

## What was measured and dropped

**A declared pattern that never matched.** Discovery and terminal
patterns have no identity of their own. The only handle on one is its
`kind`, which can repeat within a pack, and a recognizer is a bare
function with no name at all. Giving them an identity means either
asking pack authors for one or passing an index through the adapter.
Neither is worth it, because the check would be wrong most of the times
it fired. The Express pack generates one discovery pattern per HTTP
method, so any project that never calls `.delete()` leaves a pattern
unmatched, and that is normal.

**High confidence on an empty summary.** We built this one and
measured it. It fired three times across everything, and it was wrong
all three times. One was this repo's CloudFormation package, where
three of five summaries are re-exports from another package. There is
no body to read, so an empty summary is the correct answer. The other
two were out of a total of two.

The check cannot tell "the pack read nothing" apart from "there was
nothing to read", and that difference is what matters. The extractor
already makes the distinction where it can: when it sees returns it
could not match, it records an `unreadOutcome` gap and drops to low
confidence. Where it couldn't, the cause was that `assessConfidence`
divided zero opaque conditions by zero total and treated the result as
agreement. So a summary with nothing in it came out at high confidence.
That arithmetic needed fixing, and fixing it did not need a heuristic.

We have since fixed that arithmetic. The adapter now reports what it
found where a unit's body should be, and the extractor treats the two
cases differently. A body with nothing in it stays at high confidence,
because a summary that says nothing has described it completely. A
body with work in it that produced no transition, and a declaration
with no body behind it, both drop to low confidence and get an
`unreadOutcome` gap saying why. The check we dropped would now be
asking a question the summary already answers, so it is still not
worth running as a heuristic.

## What this does not do

**It leaves five packs unmeasured.** Prisma, Drizzle, SQS, EventBridge
and the Node runtime pack contribute effects and produce no summaries
of their own, and the section above explains why no check here can
judge them. We report their counts and draw no conclusion from them.

**"Reached zero" is much weaker than it sounds.** One count above zero
anywhere in a pack's run silences that pair for the whole run. Eleven
empty components plus one loader that returns an object looks healthy,
and on Saleor Storefront a single loader would have hidden all thirty
empty components. A ratio would catch that. But a ratio needs a
threshold, and a threshold needs a distribution to pick it from. The
sweeps here produced drop counts in single digits, which is not enough
to choose a number that isn't arbitrary. Zero is the one threshold
that needs no evidence, so we shipped that one.

**A cache hit skips the report entirely.** The adapter emits no
extraction report when it serves a run from the cache, because no
stage ran. So health checks only fire on a cold cache or under
`--no-cache`, and a passing check on a warm run tells you nothing.

**It does not fail a run.** Every check reports, and the exit code
stays what it was.

**It compares against nothing.** There is no baseline and no history,
so a pack that was already producing empty summaries yesterday looks
the same as one that broke this morning.

**It only reads counts, and never the content.** A pack producing one
transition per summary where it should produce four looks healthy.

**It cannot attribute a summary to a pack that failed to label it.**
Everything after the boundary binding groups on `recognition`, so a
pack that writes the wrong label there is measured as two packs.
