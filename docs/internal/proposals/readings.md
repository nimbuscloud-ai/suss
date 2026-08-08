# Readings: make the adapter say how it knows

## The problem, from evidence

Five bugs shipped in one batch of builder branches, every one caught in
review or by the fuzzer, every one the same mechanical failure. A reader
returned a value the source did not state.

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
silently. The `actions[0]` bug assumed a position where the result was
ambiguous. Review keeps catching the class because nothing in the types
tells the cases apart. Each new reader makes the same decision over
again, and some of them make it wrong.

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
  as data. The library defines that default, and it lives in the pack's
  config next to the names it already declares, where review reads it.
  If no default is declared, there is no claim. The vocabulary check
  does not police it: that check matches identifiers, and a default
  like a status code is a number. The differential fuzzer is what
  catches a wrong one, which it does, by running the generated program
  and comparing the claim against what the app returns.
- `unreadable` and `ambiguous` always become gaps, with the reason
  threaded onto the summary the way `unreadBinding` sentences already
  are.

Discovery code cannot unwrap the type. The collapse functions live in
the builder module and are not exported. Writing the fabricated-200 bug
under this regime requires one of two visible acts: declaring a false
default in pack data, where review reads it, or adding an escape hatch,
which is a named function whose call count the dispatch-style ratchet
keeps at its current number.

One reader does need a written value before there is a summary field to
fill, because a route's path gives its own parameters their names, and
that decides what each function parameter is. `valueToReadFurtherFrom`
is the sanctioned way to do it: it applies no default and states no
reason, so what it returns is not a claim. The identity fields of a
boundary binding are the exception it also covers, since a binding
either says where a unit lives or says nothing and pairs with nothing,
and no pack declares a default for what a boundary is called.

Two details the first implementation settled. `firstWritten` hands back
the `Reading` values it passed over alongside the one it chose, so a
value that arrived from a second source does not bury the first source's
failure. And the `ambiguous` variant has a range like `unreadable` does,
so a chained read can run against each candidate and keep the ones that
survive.

## What this does not cover

A result can be well-formed and confident and still be semantically
wrong. A glob matcher with wrong semantics returns `written` and lies.
The type does not help there. The differential fuzzer does, and it
already caught one bug of exactly that class this batch. The two
mechanisms split the space: the type kills the conflation family at
compile time, and the fuzzer catches the semantics family at run time.

A mutation harness becomes cheap on top of this. "Mutate something the
adapter recognizes into a variant it does not, and the adapter must
return `unreadable` rather than `written`" is a property of one type,
and you write it once against the `Reading` seam rather than once per
adapter.

## Adoption order

1. Define `Reading` and the collapse seam in the extractor core.
2. Retrofit the Python adapter's readers. It is small, recently built,
   and its `statusDeclaredUnread` flag is already a hand-rolled
   two-state version of this. The retrofit deletes that special case.
3. Retrofit the Ruby adapter alongside the pack-ownership rework,
   which rewrites the same reader signatures anyway.
4. The CFN reader next. The way it handles `unresolved-ref` is already
   close to `unreadable` in spirit, and the two come together on one
   vocabulary.
5. The TypeScript adapter incrementally, seam by seam, with the escape
   hatch ratchet keeping the count of un-migrated readers and burning
   it down the way the dispatch ratchet does.

## Risks

- **Ergonomics.** Readers compose worse as unions than as nullables.
  A small set of combinators (map, andThen, first-of) covers the
  patterns the current readers actually use. Anything fancier is a
  smell.
- **Retrofit cost in the TS adapter.** It is the largest surface and it
  has the most existing evidence of correctness, which is why it goes
  last and incrementally rather than in one rewrite.
- **Provenance weight.** Keeping a range on every written value costs
  little at extraction time, and it pays for itself the first time
  somebody has to explain a wrong claim. The perf baseline job will
  tell us if that estimate is wrong.
