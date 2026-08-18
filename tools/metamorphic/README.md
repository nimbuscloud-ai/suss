# @suss/metamorphic

Rewrites a program in ways the language keeps equivalent and checks that
suss still describes the same boundary access.

## Why

Every other oracle in this repo accepts silence. The fuzzer checks that
extraction survives and that the output validates. The dogfood invariant
checks that a declared export produces a summary. A call suss failed to
follow gives a well formed summary with one fewer effect, and passes all
of it.

Writing more tests does not fix that, because a test is written by
somebody who already has the shape in mind. Every storage pack test
constructs its client inline, since that is the smallest program that
reproduces the behavior. suss itself is written with factory functions
and few classes, so dogfooding over its own source never exercises the
shapes its users write.

So instead of adding cases, take one program whose effects are known and
rewrite it. Moving a call into a helper does not change what the program
does. If the summary changes, that is a resolution gap, and the failing
rewrite says which one.

## How it runs

A seed is the smallest program that has an answer: one discovered unit,
one recognized boundary call, one effect. A seed does not write the
program out. It says what the call needs, and a rewrite decides where the
client is made and where the call goes.

Each rewrite builds a whole program from the seed. The suite extracts it
and compares two things against the seed's own extraction:

- **The boundary accesses the run describes**, wherever it attributes
  them. A rewrite that moves the call into a helper moves the effect onto
  that helper's own summary, and it is the same access.
- **What the discovered unit reaches**, which is the `Reaches:` section
  of `suss inspect`. This is what says the unit is connected to the
  access rather than the run happening to mention it somewhere.

Line numbers, unit names and file paths move under rewriting, so the
comparison ignores them, along with the call's source text, its group id
and its origin.

## Adding a seed

Add one to `SEEDS` in `src/seed.ts`. A seed supplies the type
declarations its client library ships, an import line, the type a client
is annotated with, an expression that makes one, and the call itself as a
function of a client expression and an id expression. Every rewrite then
runs against it with nothing else to write.

Pick a pack whose effect is easy to state, which in practice means the
call spells its container out as a literal. Two seeds cost about a
second; each further one costs about half that.

## Known gaps

`KNOWN_GAPS` in `src/rewrite.test.ts` lists the rewrites suss does not
follow yet, each with why and where it is written down. A gap that starts
passing fails the suite as well, so a closed one does not stay on the
list. This is the mechanism `@suss/resolution` uses for the cases an
adapter's facts do not satisfy.
