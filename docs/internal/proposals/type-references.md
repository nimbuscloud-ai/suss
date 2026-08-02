# Proposal: name a type, hash it, and carry only what crosses

Status: draft, seeking alignment. Nothing here is implemented. The
measurements below are from runs on current main against the public
dogfood targets, all with `--no-cache`.

## The problem

`suss extract -p tsconfig.json -f react -f fetch` against Saleor
Dashboard does not produce a file. It ends with `Invalid string length`,
which is V8 refusing to build a string over 512MB. The run took 85
seconds and read 3057 boundaries correctly, and then the tool threw all
of it away at the last step.

Here is why:

| | saleor-dashboard | twenty-front |
| --- | ---: | ---: |
| summaries | 3057 | 6540 |
| total summary bytes | 349,144,410 | 32,478,589 |
| median summary | 1,326 | 1,698 |
| p90 | 4,812 | 6,271 |
| p99 | 20,563 | 22,038 |
| largest summary | 259,418,210 | 3,835,329 |
| top ten summaries, share of all bytes | 97.8% | 36.1% |

Saleor's largest summary is `useScrollRight`, a hook in the datagrid
that returns a DOM element. It is 74% of the whole output and 195,000
times the median. Two `onInvoiceClick` handlers on the order detail page
are 40MB each. Below the top three the distribution is ordinary: p99 is
20KB, which is about what a summary should cost.

The next seven are form validation builders, `getValidationSchema` and
its neighbours, at 150KB to 320KB each, which is seven to fifteen times
p99. Each returns a zod schema.

Twenty's frontend is the same distribution with a smaller tail. Its
largest summary is 2,258 times its median, and its p99 sits within 7% of
Saleor's, which is the point: the middle of both runs is fine and the top
of both is not.

Counted as shape nodes rather than bytes, Saleor holds 6,739,780 nodes
across 6,756 shapes, and 5,012,652 of them belong to that one hook.
Shapes are 98.3% of Saleor's summary bytes and 46.1% of Twenty's, so the
size of a suss output is mostly the size of its type expansions.

Neither figure is the ceiling. Both runs read a checkout with no
`node_modules`, so `HTMLElement` came from TypeScript's own
`lib.dom.d.ts` and the React and Apollo types resolved to nothing. With
dependencies installed the same Saleor hook produces 1,007,823,746
bytes and Twenty reaches 945MB. Both runs then die at V8's 512MB string
cap instead of writing a file.

`typeShapes.ts` caps depth at six, guards cycles along the current path,
and puts no cap on width. It calls `getProperties()` on everything it
meets. The DOM is a dense graph and the cycle guard covers one path, so
a type reached through two properties expands twice, all the way down.

A fix for the immediate case is written and sitting in a working tree: a
named type whose every declaration lives outside the project stops at
its name. It works, and it should land. Running it over Saleor:

| | main | with the fix |
| --- | ---: | ---: |
| total summary bytes | 349,144,410 | 7,392,506 |
| median | 1,326 | 1,323 |
| p99 | 20,563 | 14,960 |
| largest | 259,418,210 | 241,646 |
| top ten, share of bytes | 97.8% | 8.2% |
| shape nodes | 6,739,780 | 37,455 |

Forty-seven times smaller, the extract writes a file, and the DOM hook
and both zod schema builders are gone from the top ten. That is a good
change and it is not the model.

What the fix leaves behind says why. The largest remaining summary is
`useExtensions` at 241,646 bytes, still 183 times the median, and p99
only came down 27%. Every one of the top ten after the fix is a
project-declared type that the project genuinely wrote, expanded to
depth six because it was there. "Declared outside the project" is a rule
about where a file sits, and the reason not to expand `HTMLElement` has
nothing to do with which directory declared it.

## What TypeScript does that we do not

Three things, and each one is a decision we made differently.

**Display is by reference even though identity is structural.** The
checker prints `HTMLElement`, not its members. A name is what a reader
wants and what makes a diff legible.

**Resolution is lazy.** A type is a node with a resolver attached, and
`getProperties()` is the call that forces it. Most types the checker
touches are never forced.

**Comparison is pairwise and memoized.** Assignability walks the members
of one side against the other, memoizes the pair, and never materializes
both expansions.

Within a run the adapter can copy the first two, because the program is
alive and holding a reference to a compiler type costs nothing. It
cannot copy the third, because suss compares a summary from one
repository against a summary from another, months apart, with no
compiler and no source for either side. That is the part of the design
that has to be worked out rather than borrowed.

## The model

A shape carries three things.

**A name.** `HTMLDivElement`, `User`, `OrderLine`. What a reader wants
and what a diff can show.

**A fingerprint.** A hash over the normalized member set, so two shapes
can be compared for sameness without either being expanded.

**The members that cross the boundary.** A much smaller set than a
type's full surface, and the subject of its own section below.

In the IR this is two optional fields on variants that already exist,
not a new variant:

```ts
| { type: "record"; properties: …; spreads?: …; name?: string; fingerprint?: string }
| { type: "ref"; name: string; fingerprint?: string }
```

A `ref` with a fingerprint is a named type nobody needed to expand. A
`record` with a name and a fingerprint is one that was expanded and
still knows what it is called.

### The fingerprint

**What it covers.** The normalized member set, and nothing above it. For
a record, the members sorted by name, each contributing its own name and
its own member fingerprint. For a union, the variant fingerprints
deduped and sorted, so declaration order does not matter. For a literal,
its value. For a primitive, its kind. A member that is itself a named
type contributes that type's fingerprint rather than its name, so the
hash reaches structure all the way down.

Optionality is a flag on the member rather than a union with
`undefined`. Today `{ a?: string }` and `{ a: string | undefined }`
produce the same `union<text, undefined>`, which is the right answer for
the wire and the wrong one for a hash that wants to be minimal.

**Cycles.** A type already on the current path contributes a
back-reference counting binders rather than recursing, so
`type Tree = { value: string; children: Tree[] }` terminates with the
cycle's shape in the hash rather than a truncation of it. That makes the
hash stable for a given entry point. It does not make it canonical
across entry points: entering at `Tree` and entering at
`Tree["children"][0]` give different strings for the same cyclic graph.
Making them agree means minimizing the type graph up to bisimulation
before hashing, which is the standard construction and is more machinery
than the corpus currently justifies. Start with back-references and
reach for minimization if two repositories ever disagree because of it.

**Stability across runs** follows from sorting. Nothing in the
normalization depends on file order, declaration order, or the order the
compiler happened to answer in.

**Stability across suss versions** does not follow from anything, so it
has to be declared. The fingerprint carries the normalization version in
the string, `f1:` today. A checker comparing `f1:` against `f2:` does not
conclude a mismatch; it falls through to comparing members, and says so.
That path already exists, and this is what it is for.

**Stability across two repositories that declare compatible types
independently** is the point of the whole thing, and it holds for
exactly the reasons it should. The fingerprint survives a renamed type,
a moved file, a different package, a reordered declaration. It does not
survive a different member set, which is correct: the value on the wire
changed.

**A member added elsewhere does not change it,** because the hash covers
only what is reachable from this type. A sibling type, another export in
the same module, an unrelated field on an unrelated interface: none of
them are in the walk. A member added to a type this one transitively
reaches does change the hash, and should, because that member now
crosses.

**What it can answer:** two shapes are the same. Equal fingerprints mean
the same normalized member set, up to collision. Running the
normalization over both corpora gives 1,542 distinct fingerprints across
Saleor's 6,756 shapes and 2,976 across Twenty's 12,892, with no
collisions at a 64-bit prefix in either. Zero is what the birthday bound
predicts at this scale, so the corpus says little; SHA-256 is the reason
to trust the hash. The ratio is the useful part of that measurement.
Roughly three shapes in four repeat one already seen, so a summary file
could carry each expansion once and reference it everywhere else.

**What it cannot answer:** where two shapes differ. A different hash says
nothing about which member moved, so a mismatch still needs members to
explain. The fingerprint is a fast path to agreement and never a verdict
about disagreement.

There is one wrong answer it fixes today. `bodyShapesMatch` returns
`match` for two `ref`s whose names are equal, whatever they contain.
Two repositories that each declare a `User` compare as agreeing even
when their fields have drifted apart, which is the case cross-repository
checking exists to catch. A fingerprint is what makes ref-against-ref
decidable rather than assumed.

### The size this produces

Replacing every shape in both runs with a name and a fingerprint, which
is the floor rather than the proposal, takes Saleor's 343,372,735 shape
bytes to 680,601 and Twenty's 14,984,756 to 956,323. Twenty's ratio is
the interesting one: it is 6.4% rather than 0.2%, because Twenty's
shapes are mostly small and a name plus a hash costs about what a
three-field record costs. The saving concentrates in the handful of
shapes that should never have expanded, which is why the maximum moves
by five orders of magnitude while the median barely moves.

The proposal sits above that floor, since it keeps the members that
cross. On a body of three fields it saves nothing and costs a hash. On a
DOM element it saves everything.

Measured after the library-type fix instead of before it, the floor is
680,690 bytes against 1,627,291 of shape, so a name and a hash is 42% of
what the shapes cost once the worst case is gone. Read that as a warning
about which step does the work. The fingerprint is what makes a
reference comparable, and picking members by what the transport carries
is what makes the remaining shapes smaller. Neither one substitutes for
the other.

## Comparison without a compiler

The checker compares with the program in hand: it can force a type,
follow a declaration, and ask about a symbol it has never seen. suss has
a provider summary from one repository and a consumer summary from
another, possibly produced months apart by different suss versions, with
no compiler and no source for either side. Everything the comparison
needs has to already be in the two files.

### The ladder

Today `bodyShapesMatch` answers `match`, `nomatch`, or `unknown`, where
`unknown` means "uncertainty that would mask a real mismatch". Under
this model it walks four rungs and stops at the first that answers.

1. **Both sides carry a fingerprint, the same normalization version, and
   they are equal.** `match`, with nothing expanded. This is the rung
   the DOM case and every unchanged shared type land on.
2. **Both carry a fingerprint and they differ.** Not a verdict. The
   question the checker asks is asymmetric, whether the produced value
   satisfies the declared one, and two types can differ while one
   satisfies the other. Fall through.
3. **Both carry members.** Today's structural walk, unchanged, giving
   `match` or `nomatch`.
4. **One side carries only a name.** `unknown`, as today.

Every verdict the checker reaches today it still reaches. The additions
are rung 1, which is free, and rung 3 answering a case rung 4 used to
swallow.

### What has to be carried

For rung 1: a fingerprint and its version. Small, fixed size, and enough
on its own for the most common comparison, which is "did this change".

For rung 3: members. A hash cannot produce them, so a summary that wants
a verdict about disagreement has to carry the member set. This is the
constraint that makes the next section necessary. Carrying members is
affordable only when the member set is small, and it is small only when
some stated rule picks which members belong in it.

For a reader: the name. It costs nothing and it is what a person reads
first.

### What is lost

**Nominal distinctions.** Branded types, `unique symbol`, private class
fields. Two structurally identical branded types have the same
fingerprint and the same members, so suss says they agree where tsc says
they do not. That is an over-approximation in the direction of agreement,
which for a checker means a finding it does not report rather than one
it reports wrongly. The checker already prefers that trade, which is why
`unknown` exists.

**Declared inheritance.** `class Admin extends User` is structurally
wider, and the member walk gets width right. Variance on function-typed
members is not decidable from what a summary carries, and function-typed
members are exactly the ones the next section says do not cross most
boundaries.

**Type-level computation.** Conditional types, mapped types, template
literal types. All of them are resolved at extraction, at a use site,
and the summary carries the result. Nothing can re-evaluate them later,
and nothing needs to, because the use site is where the value was.

**Generics before instantiation.** The extractor already resolves a type
at the node that uses it, so `Page<User>` is fingerprinted instantiated.
Comparing `Page<User>` against `Page<Order>` gives different
fingerprints, correctly. An uninstantiated generic is not comparable and
should not be pretended otherwise.

### What reporting looks like

Losing the ability to print both structures costs the report nothing,
because the report never printed them. A `Finding` today is a kind, a
boundary, two sides, a severity, and a prose `description`. Shape mismatches read `Handler returns a body on
status 200 that does not match the declared schema`, with no field
named. The one place a shape path reaches a person is the optional-field
warning in `bodyCompatibility`, which already carries `string[]` paths
and joins them with dots.

What the model does is make the missing half worth building. When rung 3 finds a mismatch it knows the
path, and the finding should carry it as a structured field. Not in
`description`, because findings dedupe on that string and putting a path
in it would stop findings collapsing that collapse today.

When only rung 2 is available, the finding is `lowConfidence` at info
severity, saying the two shapes are not the same and neither side
recorded enough to say where. That polarity matches `unreadOutcome`
exactly: a statement about the reading, not about the code.

## What crosses the boundary

The claim to test: a boundary shape is a serialization shape.
`HTMLElement` cannot cross an HTTP boundary or go into a queue, so none
of its members are checkable against a consumer, and a walk that
expanded only what can be transmitted would collapse the DOM case by
construction rather than by a rule about where a type was declared.

Against the six boundary kinds suss supports:

**REST.** Holds. The body is JSON. A function-typed member cannot be
sent, an object whose identity matters rather than its value cannot be
sent, and neither can appear in a body a consumer reads. The walk stops
at call signatures, at private fields, at anything the transport cannot
carry.

**GraphQL.** Holds, and more strongly than REST. The selection set is
the member set, and the pack already knows what was selected. What
crosses is a strict subset of the type.

**Message bus.** Holds. A payload is JSON, Avro, or protobuf, and all
three have the same answer about functions.

**Runtime config.** Holds, and reduces to nothing interesting.
Environment variables are strings and the shape is a flat record of
names.

**Function call and package export.** Does not hold. A package export's
argument can be a callback, a class instance, an `AbortSignal`, a React
component, and those are the contract rather than an accident of it.
`createServer(handler)` is entirely about a function-typed argument.
Asking what can be serialized gives the wrong answer here, and it gives
it in the dangerous direction: it would erase the part of the contract
that matters.

So the claim holds for every boundary whose transport is `http` and
fails for every boundary whose transport is `in-process`. That
distinction is already in the IR, on `BoundaryBinding.transport`, so
the test does not need a new concept to express. The rule is what the
transport can carry, and serialization is the answer for one of the two
transports rather than for all of them.

What bounds the in-process case is the other half of the model. A
callback argument becomes a `ref` with a name and a fingerprint and
never expands. That is enough for the question a package export
actually raises, which is whether the type a caller compiled against is
still the type the provider ships. The consumer side already carries
only the fields it read, since `providerCoversConsumerFields` documents
that consumer leaves are `unknown` because the extractor tracked which
fields were accessed rather than what types they hold. The provider side
publishing a fingerprint puts both sides on the same footing.

Worth noticing where that leaves the case that started this. A React
hook returning a DOM element is a `hook` unit on an in-process boundary
with no counterparty at all: nothing pairs against it, so no member of
`HTMLElement` was ever going to be checked against anything. Both halves
of the model reach the same answer for it, from different directions.

## Language neutrality

Structural identity, reference by name, expansion on demand, and only
what crosses the wire are statements about boundaries rather than about
TypeScript. Two checks on that.

**A Python adapter** has no structural type system to force. It has
`TypedDict`, dataclasses, pydantic models, and annotations that may be
missing entirely. Reference by name works. A fingerprint over the field
set of a dataclass works. What Python cannot supply is a checker that
expands on demand at arbitrary depth, so the adapter has to produce the
member set itself, eagerly, for the members it decides cross.

**A Go adapter** has named struct types and `json` tags, and the tag is
the wire name while the field name is not. So the normalization has to
fingerprint wire names, not declaration names, or a Go provider and a
TypeScript consumer describing the same payload will never agree. That
is a useful forcing function rather than a complication: fingerprinting
the wire name is the thing that makes cross-language pairing possible at
all.

Both point the same way. The normalization and the hash belong in
`@suss/ir-core`, which already owns `TypeShape` and `bodyShapesMatch`
and is where the two checkers were deliberately kept from drifting. Each
adapter supplies a name for a type, a list of `(wireName, optional,
memberShape)` triples, and a judgment about whether a member can cross a
given transport. Nothing else. That is the same split
`@suss/resolution` already uses, where the rules are language-neutral
and the adapter supplies facts, so shapes should follow it and no new
package is needed.

## What this costs

**The published IR.** Two optional fields on two existing variants. Old
summaries parse in a new reader, because nothing became required. New
summaries parse in a 0.1.0 reader, because none of the zod objects use
`.strict()` and unknown keys are stripped; a 0.1.0 checker keeps working
and never takes rung 1. The generated JSON Schema is the
exception: it ships in the tarball with `additionalProperties: false` in
92 places, so a non-JS consumer validating against the 0.1.0 schema
would reject a new summary. That schema is regenerated from the zod
definitions, so the fix is a release rather than a design change, but it
is the one place a consumer is affected and it should be called out in
the release notes. A minor version, not a format version.

**Committed fixtures.** Close to nothing. The repo commits no summaries:
140 tracked JSON files totalling 564,924 bytes, of which the only one
carrying shapes is the generated schema itself. The dogfood baseline
holds counts. Coverage summaries hold percentages. The churn is in
TypeScript: 54 tracked files reference `TypeShape` and 30 of them
contain 123 inline `type: "record"` literals. All stay valid, because
every new field is optional. The ones that need touching are assertions
that compare a whole summary with `toEqual`, which will see new keys.

**The checker.** `bodyShapesMatch` keeps its signature and gains the
fingerprint rung above its existing body. The `ref`-against-`ref` branch
changes verdict in one case, where names match and fingerprints do not,
and that is the only behaviour change. `providerCoversConsumerFields`
is untouched.

**The gaps we already keep separate.** The repo distinguishes a shape it
could not read from a shape that is not there, and a reference model
must not blur them. Today `{ type: "unknown" }` means the reading
failed, an absent field means there was nothing to read, and `ref` means
three different things at once: deliberately opaque, cut short by
`MAX_DEPTH`, or cut short by a cycle. That conflation is a defect the
current code already has, and a model that leans harder on `ref` makes
it worse rather than better.

So `ref` needs to say which it is. A shape reduced to a name because
nobody needed more is a complete answer. A shape cut short at depth six
is an incomplete one. A shape we failed to read is `unknown` and stays
`unknown`. One more optional field on `ref` carries it, and the checker
can then treat a complete reference as comparable and a truncated one as
`unknown`, which is what each of them deserves and neither gets today.

## The questions this has to answer

**Could smaller pieces compose to this?** Yes, and most of them already
exist. `refFromType` names a type and is already what the depth cap
falls back to. `bodyShapesMatch` compares. The consumer side already
carries only the fields it read. One piece is missing, a stable identity
for a type nobody expanded, and adding it to `ref` is what lets the rest
compose. The proposal should be that piece rather than a new shape
model.

**Does it reuse what exists?** `refFromType` is the emission path
unchanged. `canonicalize` in the CLI is already this repo's canonical
JSON idiom and the normalization should read like it. `bodyShapesMatch`
keeps its signature and its three-valued result.

**Does it widen shared vocabulary?** By one word, "fingerprint".
Everything else is `ref`, `record`, `member`, `boundary`, all already in
use. No new noun for the model itself.

**Is it over-designed?** In full, yes, for what a single release can
justify. The smallest version that ships a measured win is the
library-type fix already written, which needs no schema change and no
release. The next smallest is a fingerprint on `ref`, which turns the
reference that fix produces from something the checker calls `unknown`
into something it can decide. Everything after that (the per-transport
member selection, the truncation flag, the difference path on findings)
stands on its own and can ship on its own.

**Naming.** `fingerprint` as the field. `fingerprintOf(shape)` as the
function, named for the answer it gives back rather than for the
machinery, per the naming section of the style guide. Not `hashShape`,
not `computeFingerprint`.

**Verified against code somebody wrote.** Saleor Dashboard and Twenty's
frontend, both public, both measured on current main with `--no-cache`,
plus this repo's own dogfood run.

**What it does not do.** Assignability stays an approximation. Nominal
types, variance, and uninstantiated generics are all given up, and a
summary will keep saying two branded types agree where tsc says they do
not. The checker still has no path to a difference; this model makes
building one worth the effort and leaves it to a later change. The depth
cap stays where it is, as the backstop for a type nothing else stopped.

## Recommendation

Three steps, each measurable without the next.

1. **Land the library-type fix.** It is written and it is measured
   above: 47 times smaller on Saleor, and an extract that writes a file.
   Nothing in this proposal has to be agreed for it to ship.
2. **Add `fingerprint` to `ref` and `record`, and the fingerprint rung
   to `bodyShapesMatch`.** No size win, and that is fine, because this
   is the step that makes the reference step 1 produces something the
   checker can decide rather than something it calls `unknown`. Measure
   the dogfood run: how many ref-against-ref comparisons stop being
   `match` by name alone, and how many findings change.
3. **Select members by what the transport carries,** for `http`
   boundaries only, leaving `in-process` bounded by the reference.
   Measure p99 rather than the maximum, since step 1 already takes the
   maximum and p99 only came down 27%.

Step 3 is the one worth arguing about first, because it is the only one
that changes what a summary claims.
