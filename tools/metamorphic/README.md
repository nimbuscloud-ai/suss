# @suss/metamorphic

This package rewrites a program in ways the language treats as
equivalent, and checks that suss still describes the same boundary
access.

## Why

Every other oracle in this repo lets a missing result pass. The fuzzer
checks that extraction survives and that the output validates. The
dogfood invariant checks that a declared export produces a summary. A
call suss failed to follow gives a well formed summary with one fewer
effect, and passes all of those checks.

Writing more tests does not fix that, because whoever writes a test
already has a particular way of writing the code in mind. Every storage
pack test constructs its client inline, since that is the smallest
program that reproduces the behavior. suss itself is written with
factory functions and few classes, so running suss over its own source
never exercises the code patterns its users write.

So instead of adding cases, this package takes one program whose
effects are known and rewrites it. Moving a call into a helper does not
change what the program does. If the summary changes, suss has a
resolution gap, and the failing rewrite shows which one.

## How it runs

A seed is the smallest program with a known answer: one discovered
unit, one recognized boundary call, one effect. A seed does not write
the program out. It declares what the call needs, and a rewrite decides
where the client is created and where the call goes.

Each rewrite builds a whole program from the seed. The suite extracts
it and compares two things with the seed's own extraction:

- **The boundary accesses the run describes**, wherever it attributes
  them. A rewrite that moves the call into a helper moves the effect
  onto that helper's own summary, and it is still the same access.
- **What the discovered unit reaches.** The suite walks the calls the
  run recorded from the unit, and collects the boundary accesses on
  every function it reaches. This shows that the unit is connected to
  the access, and that the run did not only mention it somewhere.

Line numbers, unit names and file paths change under rewriting, so the
comparison ignores them, along with the call's source text, its group
id and its origin.

## Adding a seed

Add one to `SEEDS` in `src/seed.ts`. A seed supplies the type
declarations its client library ships, an import line, the type a
client is annotated with, an expression that creates one, and the call
itself as a function of a client expression and an id expression. Every
rewrite then runs against it with nothing else to write.

Pick a pack whose effect is easy to state, which in practice means the
call writes its container as a literal. Two seeds take about a second,
and each one after that adds about half a second.

## Known gaps

`KNOWN_GAPS` in `src/rewrite.test.ts` lists the rewrites suss does not
follow yet, each with the reason and where it is written down. A gap
that starts passing also fails the suite, so a closed gap does not stay
on the list. `@suss/resolution` uses the same approach for the cases an
adapter's facts do not cover.
