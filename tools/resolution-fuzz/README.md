# @suss/resolution-fuzz

Generates fact bases over the vocabulary `@suss/resolution` reads, runs
the rules over each one, and compares what came out against a committed
baseline. A change to a rule shows up as a diff, with the counts that
moved and the facts that produced them.

## Why

The resolution rules are the part of suss that has no natural test.
Every case in `packages/resolution/src/index.test.ts` was written by
somebody who already knew the shape they wanted to check, so the rules
are covered exactly where somebody thought to look. When the rules were
rewritten in #445 from four parallel walks into one step relation, the
way that got validated was a throwaway harness: a few thousand generated
fact bases, the old rules and the new ones run over each, and the
answers diffed. It found what the review could not, and then it was
deleted, because the implementation it compared against was gone.

This keeps the generator and replaces the other half. Instead of
comparing two implementations, it compares against what the rules
answered when the file was last committed.

## What a base looks like

Random tuples over random node ids derive nothing. The rules are joins,
and unrelated ids never join, so a base is assembled out of constructs a
language has, each one stating the facts an adapter would state for it
and drawing what it needs from what the constructs before it produced:

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

That is a wrapper factory, a module exporting what it returned, and a
call site reaching it through an import. Twenty or so constructs make a
base, and the pools they draw from are weighted toward whatever was made
last, so the bases come out as chains rather than as heaps of unrelated
pairs. Chains are what the rules follow.

Two of the constructs assemble a shape rather than a single fact. A
wrapper factory needs a function, a parameter, a returned function, and a
call of that parameter to line up before anything unwraps, and a call
site has to pass an argument at a position the callee really declares
before an argument reaches a parameter. Left to chance both come up
almost never, and the rules about them go untouched. The counts in the
baseline's `reach` field say how many of the five hundred committed
bases derive anything for each question, which is the check on whether
the weights are still doing their job.

Modules, property names, and argument names come from universes of two
or three, so two constructs picking one independently still pick the
same one often enough to join.

## What gets committed

`answers-baseline.json` covers four thousand bases:

- the first five hundred with a line each, giving the count per
  question and a digest over the answers themselves;
- all four thousand under one digest, plus the totals, which is what
  keeps a file covering four thousand bases down to five hundred lines.

A line reads:

    0007 facts=52 comesTo=15 givesBack=0 isWrittenAs=13 comesFrom=4 objectOf=4 resolves=11 paramAt=4 callsInto=1 digest=05fd851aaf7b

The digest is there because the counts alone would miss one answer being
swapped for another. The counts are there because a digest alone says
nothing about which way a change went, and this diff is what a reviewer
reads when somebody changes a rule.

## Running it

`npm test` runs the whole thing, four thousand bases in about a second.
When a base moves, the failure prints its facts and every answer they
now derive, for the first three that moved, and lists the rest by
number.

Accepting a change is a deliberate command:

    npm run resolution:baseline

Commit the rewritten file in the same change as the rule. The counts
land in the pull request diff, where a code owner reads what a rule
started or stopped deriving.

When the four-thousand digest moves while every committed line still
matches, whatever changed is past base five hundred. Write more lines to
find it:

    RESOLUTION_LINES=4000 npm run resolution:baseline

then diff, then regenerate without the variable to get the file back to
five hundred.

## What it catches

Three rule changes made on purpose, each reverted afterwards:

| Change | Bases moved, of 500 | What the totals said |
| --- | --- | --- |
| Deleted the step rule for an import | 328 | `comesTo` 5794 → 4461, `resolves` 4173 → 2939 |
| `givesBack` stopping anywhere, not only at a function | 71 | `givesBack` 540 → 804 |
| The closure chaining a value walk onto a result step | 30 | `comesTo` 5794 → 5847, `resolves` 4173 → 4212 |

The third one is why four thousand bases run rather than five hundred:
it moved six per cent of the committed lines, and six hundred and
sixty-seven answers across the wider sweep.

## What it does not catch

An answer that is wrong in the same way today and tomorrow. The baseline
says what the rules derive, not what they should derive, so a rule that
has always been wrong is committed as correct. Cases in
`packages/resolution/src/index.test.ts` are what say an answer is right;
this says nobody changed one by accident.
