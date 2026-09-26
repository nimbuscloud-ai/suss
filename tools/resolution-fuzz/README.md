# @suss/resolution-fuzz

This package generates fact bases over the vocabulary `@suss/resolution`
reads, runs the rules over each one, and compares the results with a
committed baseline. A change to a rule shows up as a diff, with the
counts that moved and the facts that produced them.

## Why

The resolution rules are the one part of suss with no natural test.
Every case in `packages/resolution/src/index.test.ts` was written by
someone who already knew which case they wanted to check, so the rules
are covered only where someone thought to look. When #445 rewrote the
rules from four parallel walks into one step relation, the rewrite was
validated with a throwaway harness. It generated a few thousand fact
bases, ran the old rules and the new ones over each, and diffed the
answers. It found problems the review could not, and then it was
deleted, because the implementation it compared against was gone.

This package keeps the generator and replaces the comparison. Instead
of comparing two implementations, it compares against what the rules
returned when the baseline file was last committed.

## What a base looks like

Random tuples over random node ids derive nothing. The rules are joins,
and unrelated ids never join. So a base is built from constructs a
language has. Each construct states the facts an adapter would state
for it, and draws what it needs from what the earlier constructs
produced:

    func(fn1)
    paramOf(fn4, 1, arg5)
    func(fn6)
    returnsValue(fn4, fn6)
    binds(name7, arg5)
    bodyCalls(fn6, name7)
    exportsAs(lib, handler, fn6)
    imports(imp9, lib, handler)
    binds(name10, imp9)
    call(call11, name10)

Those facts describe a wrapper factory, a module that exports what the
factory returned, and a call site that reaches it through an import.
About twenty constructs make a base. The pools they draw from are
weighted toward whatever was made last, so the bases come out as
chains, and not as piles of unrelated pairs. The rules follow chains.

A few of the constructs build several facts that have to fit together.
A wrapper factory needs a function, a parameter, a returned function,
and a call of that parameter to line up before anything unwraps. A call
site has to pass an argument at a position the callee actually declares
before the argument reaches a parameter. Left to chance, both almost
never happen, and the rules about them never run. The counts in the
baseline's `reach` field show how many of the five hundred committed
bases derive anything for each question. They are how you check that
the weights still work.

Modules, property names and argument names come from pools of two or
three, so two constructs that each pick one independently often pick
the same one, and they join.

## What gets committed

`answers-baseline.json` covers four thousand bases:

- the first five hundred with one line each, giving the count per
  question and a digest of the answers themselves;
- all four thousand under one digest, plus the totals. This keeps a
  file that covers four thousand bases down to five hundred lines.

A line looks like this:

    0007 facts=54 comesTo=15 givesBack=0 isWrittenAs=12 comesFrom=4 objectOf=3 resolves=12 passesArgument=6 callsInto=1 digest=9437427b2728

The digest is there because the counts alone would miss one answer
being swapped for another. The counts are there because a digest alone
does not show which way a change went, and this diff is what a reviewer
reads when someone changes a rule.

## Running it

`npm test` runs the whole thing, four thousand bases in about a second.
When a base changes, the failure prints its facts and every answer they
now derive for the first three bases that changed, and lists the rest by
number.

Accepting a change is a separate, deliberate command:

    npm run resolution:baseline

Commit the rewritten file in the same change as the rule. The counts
then appear in the pull request diff, where a code owner can see what a
rule started or stopped deriving.

If the four-thousand digest changes while every committed line still
matches, the change is somewhere past base five hundred. Write more
lines to find it:

    RESOLUTION_LINES=4000 npm run resolution:baseline

then diff, then regenerate without the variable to bring the file back
to five hundred lines.

## What it catches

Three rule changes made on purpose, each reverted afterwards:

| Change | Bases moved, of 500 | What the totals said |
| --- | --- | --- |
| Deleted the step rule for an import | 328 | `comesTo` 5794 → 4461, `resolves` 4173 → 2939 |
| `givesBack` stopping anywhere, not only at a function | 71 | `givesBack` 540 → 804 |
| The closure chaining a value walk onto a result step | 30 | `comesTo` 5794 → 5847, `resolves` 4173 → 4212 |

The third one is why four thousand bases run and not only five hundred.
It changed 30 of the 500 committed lines, and 667 answers across the
wider sweep.

## What it does not catch

An answer that is wrong in the same way today and tomorrow. The
baseline records what the rules derive, whether or not that is what
they should derive, so a rule that has always been wrong is committed as
correct. The cases in `packages/resolution/src/index.test.ts` are what
establish that an answer is right. This package only shows that nobody
changed one by accident.
