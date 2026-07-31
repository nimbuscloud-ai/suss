# What a terminal came from

A terminal should say which return produced it. Right now it says where
the matcher stopped looking, and everything downstream has to guess its
way back.

## Why

`findTerminals` reports a node per terminal, and which node that is
depends on the matcher. A `returnShape` terminal lands on the object
literal, which for a ternary means two terminals on one return. A
`functionCall` terminal lands on the call, so an awaited call reports
the call and not the await around it. A `jsxReturn` terminal on a
component written as an arrow lands on the function itself.

Anything that needs to know which return a terminal came from has to
walk back up and guess. We wrote that guess twice this week and got it
wrong both times, once counting every ternary return as unread and once
doing the same to every React component written as an arrow. The
checker turns a provider gap into a contract violation at error
severity, so the second one failed checks on correct code.

Six bugs in this area have all been the same bug: information the
matcher had, threw away, and somebody else reconstructed.

## The change

Add `source` to `FoundTerminal`: the return statement the terminal came
from, or the function body for a concise arrow that returns without
writing `return`, or nothing for a terminal that is not a return at all,
like a throw.

Each matcher sets it, because each matcher is the only thing that knows.
`isInReturnPosition` in `returns.ts` already computes the answer and
throws it away by returning a boolean; it should return the return
statement instead. The JSX matcher knows whether it matched the function
or a return inside it. The throw matcher leaves it unset.

Counting what went unread then stops being inference. Take the returns
in the body, subtract the ones some terminal names as its source, and
report the difference.

## What it fixes beyond the counting

The terminal search currently runs twice per unit, once in the assembly
pass and once in the counter, because the counter needs terminals and
has no way to get the ones already found. Measured at roughly the cost
of the whole assembly pass. With `source` on the terminal, the assembly
pass hands its result over and the second search goes away.

It also stops the next matcher from reintroducing this. A matcher that
anchors somewhere new has to say what it consumed, so nothing
downstream can be wrong about it.

## Order to do it in

1. `isInReturnPosition` returns the return statement rather than a
   boolean, and `tryMatchReturnShape` puts it on the terminal.
2. The other matchers in `returns.ts`, then `jsx.ts`, then `throws.ts`.
   Fifteen construction sites, mechanical once the first one settles
   the shape.
3. `extractRawBranches` returns the terminals it found alongside the
   branches, so `extractCodeStructure` can pass them to the counter.
4. `countUnmatchedReturns` takes terminals rather than patterns, and
   the ancestor walk in it goes away.
5. Delete the second `findTerminals` call.

The tests pinned in `unmatchedReturns.test.ts` cover the five shapes
that broke, and they should keep passing at every step. Any that need
changing is a sign the modelling moved rather than the bug.
