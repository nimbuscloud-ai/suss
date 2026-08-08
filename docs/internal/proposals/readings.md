# Readings: make the adapter say how it knows

## The problem, from evidence

Five bugs shipped in one batch of builder branches, every one caught in
review or by the fuzzer, every one the same mechanical failure. A reader
answered with a value the source did not state.

- A written but non-literal `status_code` fell through to a fabricated
  literal 200 claim. The running app contradicts it.
- The ALB reader took `actions[0]` as the response behind an auth gate,
  reporting the gate instead of the terminal action.
- The Ruby scalar table answered before nesting was consulted, so a
  project class named `String` was silently read as the builtin.
- A reassigned FastAPI router variable produced a confident wrong path,
  because the binder keeps one binding per name and both readers agreed
  on the wrong one.
- Rule-based `answers` edges dropped their priority and conditions, so a
  gated 403 was indistinguishable from an unconditional default.

The root is one type. Reader helpers return `T | null`, and null means
three different things that demand three different behaviors:

1. **Not written.** The source omits the value. A library default may
   legitimately apply, when the library defines one.
2. **Written but unreadable.** The value exists in source and the reader
   cannot evaluate it. Applying any default fabricates a claim.
3. **Ambiguous.** Several candidates exist and the reader picked none,
   or worse, picked one silently.

Every bug above is a conflation of these. The fabricated 200 treated
unreadable as absent. The scalar and router bugs resolved ambiguity
silently. The `actions[0]` bug assumed a position where the reading was
ambiguous. Review keeps catching the class because nothing in the types
distinguishes the cases; each new reader re-makes the same decision, and
some fraction re-makes it wrong.

## The design

One discriminated union, defined once in the extractor core:

```ts
type Reading<T> =
  | { kind: "written"; value: T; range: SourceRange }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string; range: SourceRange }
  | { kind: "ambiguous"; candidates: readonly T[]; reason: string };
```

Every adapter and pack reader that extracts a claimable value returns a
`Reading<T>`, never `T | null`. A helper that reads a keyword argument
returns `written` with the literal and its range, `absent` when the
keyword is not there, `unreadable` when it is there and not a literal.
A resolver that finds two candidates returns `ambiguous` with both.

The summary builder is the only code allowed to collapse a Reading into
a summary field, and its collapse rule is fixed:

- `written` becomes a claim. The range travels with it to the collapse
  and stops there, because the IR has no per-claim provenance field to
  put it in. Adding one is its own change.
- `absent` may take a default only when the pack declares that default
  as data. The default is then library-defined and sits in the pack's
  config next to the names it already declares, where review reads it.
  No default declared, no claim. The vocabulary check does not police
  it: that check matches identifiers, and a default like a status code
  is a number. The differential fuzzer is what catches a wrong one,
  which it does, by running the generated program and comparing the
  claim against what the app answers.
- `unreadable` and `ambiguous` always become gaps, with the reason
  threaded onto the summary the way `unreadBinding` sentences already
  are.

Discovery code cannot unwrap the type. The collapse functions live in
the builder module and are not exported. Writing the fabricated-200 bug
under this regime requires one of two visible acts: declaring a false
default in pack data, where review reads it, or adding an escape hatch,
which is a named function whose call count the dispatch-style ratchet
holds at its current number.

One reader does need a written value before there is a summary field to
fill, because a route's path names its own parameters and that decides
what each function parameter is. `valueToReadFurtherFrom` is the
sanctioned way to do it: it applies no default and states no reason, so
what it returns is not a claim. The identity fields of a boundary
binding are the exception it also covers, since a binding either names
where a unit sits or names nothing and pairs with nothing, and no pack
declares a default for what a boundary is called.

Two details the first implementation settled. `firstWritten` hands back
the readings it passed over alongside the one it chose, so a value that
arrived from a second source does not bury the first source's failure.
And the `ambiguous` variant carries a range like `unreadable` does, so
a chained read can run against each candidate and keep the ones that
survive.

## What this does not cover

A reading can be confidently well-formed and semantically wrong. A glob
matcher with wrong semantics returns `written` and lies. The type does
not help there; the differential fuzzer does, and it already caught one
bug of exactly that class this batch. The two mechanisms split the
space: the type kills the conflation family at compile time, the fuzzer
catches the semantics family at run time.

A mutation harness becomes cheap on top of this. "Mutate a recognized
shape into an unrecognizable variant and the adapter must answer
`unreadable`, not `written`" is a property of one type, writable once
against the Reading seam rather than per adapter.

## Adoption order

1. Define `Reading` and the collapse seam in the extractor core.
2. Retrofit the Python adapter's readers. It is small, recently built,
   and its `statusDeclaredUnread` flag is already a hand-rolled
   two-state version of this; the retrofit deletes that special case.
3. Retrofit the Ruby adapter alongside the pack-ownership rework,
   which rewrites the same reader signatures anyway.
4. The CFN reader next; `unresolved-ref` handling is already close to
   `unreadable` in spirit and converges on one vocabulary.
5. The TypeScript adapter incrementally, seam by seam, with the escape
   hatch ratchet holding the count of un-migrated readers and burning
   down the way the dispatch ratchet does.

## Risks

- **Ergonomics.** Readers compose worse as unions than as nullables.
  A small set of combinators (map, andThen, first-of) covers the
  patterns the current readers actually use; anything fancier is a
  smell.
- **Retrofit cost in the TS adapter.** It is the largest surface and
  carries the most existing correctness evidence, which is why it goes
  last and incrementally rather than in one rewrite.
- **Provenance weight.** Carrying a range on every written value costs
  little at extraction time and pays for itself the first time a wrong
  claim needs explaining; the perf baseline job will say if that
  estimate is wrong.
