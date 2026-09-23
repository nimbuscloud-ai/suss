# Readings: make the adapter record how it read a value

## The problem

Five bugs landed in one batch of builder branches. Review or the fuzzer
caught every one, and every one was the same mechanical failure: a
reader returned a value the source did not state.

- A written but non-literal `status_code` fell through to a fabricated
  literal 200 claim. The running app contradicts it.
- The ALB reader took `actions[0]` as the response behind an auth gate,
  reporting the gate instead of the terminal action.
- The Ruby scalar table returned an answer before anything checked
  nesting, so a project class named `String` was silently read as the
  builtin.
- A reassigned FastAPI router variable produced a confident wrong path,
  because the binder keeps one binding per name and both readers agreed
  on the wrong one.
- Rule-based `answers` edges dropped their priority and conditions, so a
  gated 403 was indistinguishable from an unconditional default.

The cause is one type. Reader helpers return `T | null`, and null means
three different things, each of which needs different handling:

1. **Not written.** The source omits the value. A library default may
   legitimately apply, when the library defines one.
2. **Written but unreadable.** The value exists in source and the reader
   cannot evaluate it. Applying any default fabricates a claim.
3. **Ambiguous.** Several candidates exist and the reader picked none,
   or worse, picked one silently.

Every bug above mixes up two of these. The fabricated 200 treated
unreadable as absent. The scalar and router bugs resolved ambiguity
silently. The `actions[0]` bug assumed a position where the result was
ambiguous. Review keeps catching bugs of this kind, because nothing in
the types separates the cases. Each new reader makes the same decision
again, and some of them get it wrong.

## The design

One discriminated union, defined once in the extractor core:

```ts
type Reading<T> =
  | { kind: "written"; value: T; range: SourceRange }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string; range: SourceRange }
  | {
      kind: "ambiguous";
      candidates: readonly T[];
      reason: string;
      range: SourceRange;
    };
```

Every adapter and pack reader that extracts a claimable value returns a
`Reading<T>`, never `T | null`. A helper that reads a keyword argument
returns `written` with the literal and its range, `absent` when the
keyword is not there, and `unreadable` when it is there and not a
literal. A resolver that finds two candidates returns `ambiguous` with
both.

The summary builder is the only code allowed to collapse a Reading into
a summary field, and its collapse rule is fixed:

- `written` becomes a claim. The range goes with it as far as the
  collapse and is dropped there, because the IR has no per-claim
  provenance field to store it in. Adding one is a separate change.
- `absent` may take a default only when the pack declares that default
  as data. The default comes from the library, and it goes in the
  pack's config next to the names the pack already declares, where
  review sees it. With no declared default there is no claim. The
  vocabulary check does not cover defaults, because it matches
  identifiers and a default like a status code is a number. The
  differential fuzzer catches a wrong default: it runs the generated
  program and compares the claim against what the app returns.
- `unreadable` and `ambiguous` always become gaps, with the reason
  attached to the summary the way `unreadBinding` sentences already
  are.

Discovery code cannot unwrap the type. The collapse functions live in
the builder module and are not exported. Under this design, writing the
fabricated-200 bug takes one of two visible steps. Someone either
declares a false default in pack data, where review sees it, or adds an
escape hatch. The escape hatch is a named function, and a ratchet like
the dispatch one keeps its call count at the current number.

One reader does need a written value before there is a summary field to
fill. A route's path gives its own parameters their names, and those
names decide what each function parameter is. `valueToReadFurtherFrom`
is the approved way to get that value. It does not apply a default or
state a reason, so what it returns is not a claim. It also covers the
identity fields of a boundary binding. A binding either records where a
unit lives, or records nothing and pairs with nothing, and no pack
declares a default for a boundary's name.

The first implementation settled two details. `firstWritten` returns
the `Reading` values it skipped along with the one it chose, so a value
from a second source does not hide the first source's failure. And the
`ambiguous` variant has a range, as `unreadable` does, so a chained
read can run against each candidate and keep the ones that pass.

## What this does not cover

A result can be well-formed and confident and still be semantically
wrong. A glob matcher with wrong semantics returns `written` with a
wrong value. The type does not help there. The differential fuzzer
does, and it already caught one bug of exactly that kind in this batch.
The two cover different bugs. The type rules out the mixed-up cases at
compile time, and the fuzzer catches wrong semantics at run time.

On top of this, a mutation harness is cheap to build. The property
"mutate something the adapter recognizes into a variant it does not,
and the adapter must return `unreadable` rather than `written`" is
about one type. So it gets written once against the `Reading` seam,
instead of once per adapter.

## Adoption order

1. Define `Reading` and the collapse seam in the extractor core.
2. Retrofit the Python adapter's readers. It is small, recently built,
   and its `statusDeclaredUnread` flag is already a hand-rolled
   two-state version of this. The retrofit deletes that special case.
3. Retrofit the Ruby adapter alongside the pack-ownership rework,
   which rewrites the same reader signatures anyway.
4. Then the CFN reader. Its handling of `unresolved-ref` is already
   close to `unreadable`, and the two merge into one vocabulary.
5. The TypeScript adapter incrementally, seam by seam. The escape-hatch
   ratchet counts the readers not yet migrated and brings that count
   down, the way the dispatch ratchet does.

## Risks

- **Ergonomics.** Readers compose worse as unions than as nullables.
  A small set of combinators (map, andThen, first-of) covers the
  patterns the current readers actually use. Anything more elaborate is
  a warning sign.
- **Retrofit cost in the TS adapter.** It is the largest surface and
  has the most evidence that it works today, so it goes last, a piece
  at a time, instead of in one rewrite.
- **Provenance weight.** Keeping a range on every written value costs
  little at extraction time, and it pays for itself the first time
  somebody has to explain a wrong claim. The perf baseline job will
  show if that estimate is wrong.
