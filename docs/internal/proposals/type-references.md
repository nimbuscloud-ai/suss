# Proposal: record what a boundary touches, and give a type an identity

Status: draft, seeking alignment. Nothing here is implemented, apart
from the library-type fix that merged as #66 and prompted the rest.
Measurements are runs against the public dogfood targets with
`--no-cache`, and byte counts are of compact JSON unless a file size is
named.

## The problem

Until #66 merged, `suss extract -p tsconfig.json -f react -f fetch`
against Saleor Dashboard did not produce a file. It ended with
`Invalid string length`, V8 refusing to build a string over 512MB, after
reading 3057 boundaries correctly and then throwing all of it away at
the last step.

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

#66 fixed the immediate case: a named type whose every declaration lives
outside the project stops at its name. Measured over Saleor before and
after:

| | before | after |
| --- | ---: | ---: |
| total summary bytes | 349,144,410 | 7,166,354 |
| median | 1,326 | 1,323 |
| p99 | 20,563 | 14,960 |
| largest | 259,418,210 | 241,646 |
| top ten, share of bytes | 97.8% | 8.2% |
| shape nodes | 6,739,780 | 37,531 |

Forty-nine times smaller, the file it now writes is 15.9MB of indented
JSON, extraction is about a fifth faster, and the DOM hook and both zod
schema builders are gone from the top ten. That is a good change and it
is not the model.

What the fix leaves behind says why. The largest remaining summary is
`useExtensions` at 241,646 bytes, still 183 times the median, and p99
only came down 27%. Every one of the top ten after the fix is a
project-declared type the project wrote itself, expanded to
depth six because it was there. "Declared outside the project" is a rule
about where a file sits, and the reason not to expand `HTMLElement` has
nothing to do with which directory declared it.

The fix also leaves a name that points at nothing. `HTMLDivElement`
serializes with its members gone and no record of where it came from, so
nobody holding the summary can expand it later or tell whether two
summaries mean the same type by it. Size was the symptom. What a
boundary depends on, and how two sides establish that they agree about
it, is the problem underneath.

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

A shape carries three things, each doing a different job.

**The members the boundary touches.** What adjudicates a mismatch, and
the part that changes what the check means.

**Provenance.** Where the type came from. What a person reads in a diff,
and what makes the reference redeemable.

**A content hash, built as a Merkle tree.** A fast path to "these
agree", and a way to localize a difference without shipping structure.

In the IR these are optional fields on variants that already exist, not
a new variant:

```ts
| { type: "record"; properties: …; spreads?: …; name?: string; hash?: string }
| { type: "ref"; name: string; hash?: string; from?: Provenance;
    touches?: Participation }
```

## What the boundary touches

An earlier draft tested a different claim: that a boundary shape is a
serialization shape, so the walk should expand only what can be
transmitted. That test holds for REST, GraphQL, a message
bus and runtime config, and fails for function call and package export,
where a callback or a class instance is the contract rather than an
accident of it.

The instinct was right and the test was too narrow. The question is not
what can be serialized. It is what this boundary touches, and that holds
for all six kinds. A consumer that only ever calls one method of an
injected service depends on that method, not on the class. A handler
that returns a library type where two fields are read across the wire
has a contract of two fields. `HTMLElement` collapses to a reference
because nothing touches it, which is a stronger reason than the one
about where it was declared.

### It changes what the check means

What a consumer depends on is what it touches. A declared type is an
over-approximation that happens to be easy to write down, and today the
checker compares the over-approximations. Recording participation makes
the check match the dependency: a provider that adds or changes a member
nobody reads stops being a finding, and one that changes a member
somebody reads becomes one.

That is the difference between checking types and checking dependencies,
and it is worth stating plainly because it is the reason to do this at
all. The size win is a consequence.

### The two sides record different things

A provider records what it produces. A consumer records what it
requires. Pairing asks whether required is contained in produced.

The asymmetry is the correctness argument, so it has to be explicit. A
provider cannot know its consumers, especially the ones in repositories
it has never seen, so it must never record participation as though it
did. A provider that recorded "the members my consumers read" would
shrink its published contract to whatever today's callers happen to
touch, and tomorrow's caller would pair against a contract nobody ever
checked. Getting this backwards is unsound in the dangerous direction.

### Where it comes from

Mostly from facts that already exist. `@suss/resolution` publishes
`readsProperty(x, o, n)`, which says `x` is the expression `o.n`, along
with `bodyCalls`, `callArg` and `comesTo` for following a value to
where it came from.

**The consumer side composes.** The members required of a boundary value
are the property reads whose object resolves to that value. One hop is
`readsProperty` joined with `comesTo`. A nested path like `a.b.c` is the
same join applied recursively, so it needs a derived relation that
accumulates the path rather than any new fact:

```
touchesPath(v, [n])       <- readsProperty(x, o, n), comesTo(o, v)
touchesPath(v, [n, ...p]) <- readsProperty(x, o, n), comesTo(o, v),
                             touchesPath(x, p)
```

A member reached in calling position rather than read is the same
relation joined with `bodyCalls`, and worth distinguishing, because a
consumer that calls `service.charge(...)` requires a callable member
rather than a present one.

The checker already has the consumer half of this in another form.
`providerCoversConsumerFields` documents that consumer leaves are
`unknown` because the extractor tracked which fields were accessed
rather than what types they hold. That is a participation set already,
computed at check time and thrown away. This promotes it to something a
summary records.

**The provider side is partly new.** What a function produces falls out
of the paths through it, and the extractor already builds a body shape
from the return expression, so where the provider constructs the value
the participating members are the keys it wrote. Where the provider
hands back a value it obtained from somewhere else without examining it,
it produces the whole type and participation is not narrowed. That case
has to say so rather than report an empty set.

### Unknown is not empty

A computed member access, or a spread that forwards a whole value
onward, means participation cannot be enumerated. That has to read as
unknown rather than as an empty set. A consumer we failed to analyze
would otherwise look like one that requires nothing, and pair with
anything.

The repo already keeps a limit on our reading separate from a fact about
the code, in `unreadOutcome` against `unhandledCase`. Participation
follows the same split, which makes it a discriminated union rather than
an array:

```ts
type Participation =
  | { type: "members"; paths: string[][] }
  | { type: "unenumerable"; reason: "computedAccess" | "spread" | "passthrough" }
```

There is already a live instance of this in the data. 41 of Saleor's
2,136 record shapes carry `spreads`, meaning the reader could not
enumerate them, and any hash or member set that ignored that field would
report those records as fully known. The normalization has to fold
`spreads` in for the same reason it exists.

What the checker does with it:

- **Both sides known.** Required against produced is decidable. A
  required member the provider does not produce is a mismatch, with a
  path to name it.
- **Consumer unenumerable.** What it requires is unbounded, so nothing
  can be concluded from participation and comparison falls back to whole
  shapes, ending at `unknown` when those are references.
- **Provider unenumerable.** Any required member the provider did not
  describe is `unknown` rather than a mismatch, and the reason is
  recordable. Provenance is the escape hatch here: a tool that can
  install the package at the recorded version can re-derive the member
  and turn `unknown` into a verdict.

### The theory, and which parts of it apply

A consumer's requirement is a row, and the check is assignability
restricted to used members. Row polymorphism and structural subtyping
are the existing vocabulary and this should borrow them rather than
invent terms.

What applies: width subtyping is exactly containment, so a provider
producing more than is required is fine, and the consumer's requirement
reads as a row open on the right, `{ id: string; name: string | ρ }`.

What does not: depth subtyping needs variance, which no summary carries.
Row unification belongs to a type system doing inference, and this
compares two finished records. And principal typing is not what gets
computed, because participation is read off syntax and over-approximates
what a run would touch, including members reached only on a path that
never executes.

### The limit

This makes the positive space precise and does nothing for the negative
space. Participation says which members are touched. No member-level
record captures a dependency on absence, and the incident that motivated
this project was a consumer depending on a status an endpoint had never
returned. Someone will otherwise read participating members as covering
more than they do.

## A name has to point at something

The library-type fix serializes `HTMLDivElement` as
`{ type: "ref", name: "HTMLDivElement" }` and drops the members. That
name is a label rather than a pointer. Nobody holding the summary can
expand it later, because doing so needs the compiler and the same
library version in hand, and the summary records neither.

Reify it. Where a type came from is knowable at extraction time, and two
kinds of type answer differently.

**A library type has something to point at.** `ZodObject` comes from
`zod` at a version we resolved while reading. Recording the package, the
resolved version and the exported name turns the reference into an
identity: anyone holding the summary can install that package at that
version and read the type.

**A project type has nothing to point at.** No package a consumer in
another repository could install resolves their `User`. That is the case
the hash exists for, and the argument for it gets stronger once it is
scoped to the types that need it.

The two mechanisms do different jobs on the same shape rather than
competing:

```json
{
  "type": "ref",
  "name": "Request",
  "from": { "package": "express", "version": "4.18.2", "export": "Request" },
  "hash": "f1:9a3c…"
}
```

Provenance is what a person reads in a diff and what makes the reference
redeemable. The hash is what comparison uses. Neither substitutes for
the other, and the section on comparison says why.

### Why comparison uses the hash rather than the version

Semver is a proxy for "did the structure change", and a checksum answers
that question directly. Express 4.18.2 and 4.17.1 with an identical
`Request` hash the same and agree, where a version rule has to guess.
Two packages that vendored the same types agree. A package that changed
a field in a patch release disagrees, and a version rule waves it
through.

Recording the resolved version rather than a declared range follows from
the same reasoning. The resolved version is what we analyzed, so it is
the accurate record, and a range describes an intention that the
lockfile already overrode. Comparison does not need semver arithmetic
once the hash decides, which removes the awkward question of what a
provider on `^4.17.0` and a consumer on `~4.18.1` are supposed to
conclude.

### What the adapter can actually resolve

Probing this against a real project rather than reasoning about it, the
answer splits along exactly the line the compiler already draws.

**A type declared in a module under `node_modules` gives up all three
fields.** For `z.object({...})` in a project that depends on zod, the
declaration's source file is
`node_modules/zod/v4/classic/schemas.d.cts`, walking up to the nearest
`package.json` gives `zod` at `4.3.6`, the declaring file is a module,
and asking that module's symbol for its exports recovers `ZodObject`.
Package, resolved version and export name are all derivable, and none of
them has to be declared by anyone.

**A global ambient type from the default library gives up none of
them.** `HTMLDivElement` and `Date` both report a declaring file of
`/node_modules/typescript/lib/lib.dom.d.ts`, and that file does not
exist. ts-morph does not read the default library off disk; it embeds
those files and mounts them at a made-up path, so `existsSync` on it is
false and walking up for a `package.json` finds nothing to read. The
declaring file is also a script rather than a module, so its symbol is
undefined and there is no export list to ask. This is the case that
started the whole proposal, and a package walk cannot describe it.

Naming `typescript` as the package here would be worse than saying
nothing, because the version on disk is the one ts-morph bundled rather
than the one the project compiles with, and those routinely differ. The
identity that is true is the lib file plus the `target` and `lib`
settings that put it in scope, so `lib.dom` under the run's compiler
options. Those are properties of the run rather than of a shape, so they
belong in a run-level header that ambient refs point at, which also
keeps them off thousands of individual refs.

Five more cases where a derived answer is available but wrong or
misleading, which the proposal has to say out loud:

- **`@types/*` packages.** The walk yields `@types/express` and the
  types package's version, not `express` and the runtime version. That
  is the accurate record of what was read. Demangling `@types/foo__bar`
  back to `@scope/name` is ambiguous, since `__` is legal in a plain
  package name, and the fact layer's `packagesDescribedByTypes` already
  returns both readings rather than choosing. Record the declaring
  package literally and never pair a runtime name with a types version.
- **Workspace-linked packages.** TypeScript resolves the symlink, so a
  linked workspace package lands at its source path with
  `isInNodeModules()` false and `isFromExternalLibrary()` true. Any
  `node_modules`-based parse returns nothing, the upward walk finds the
  workspace's own `package.json`, and the version there is a placeholder
  that never moves when the linked source changes. Derivable, portable
  nowhere. Such a package is better treated as project code.
- **Bundled declarations.** A package that inlines another package's
  types into its own `.d.ts` reports itself, with no trace of the
  original and no API that recovers it. Confidently wrong, and common.
- **Yarn PnP.** Declarations resolve inside zip archives with no
  `package.json` any filesystem walk can reach. This needs the PnP
  resolver asked directly, and until it is, provenance is absent rather
  than wrong.
- **Merged declarations.** `Promise` is declared six times across six
  lib files. Anything that derives provenance from `declarations[0]`
  picks arbitrarily among them.

One defect to fix while doing this. The gate that decides a type is
outside the project reads `getSymbol()`, and the function that emits the
name reads `getAliasSymbol() ?? getSymbol()`. The symbol whose
declarations passed the gate is therefore not always the symbol whose
name is emitted, so provenance derived from the alias can point at a
different file than the one that was checked.

Absence is a supported answer throughout. A ref with no `from` is a ref
whose origin we could not establish, which is different from one we did
not look for, and the section on gaps holds that line.

### The cache has to change before any of this ships

The extraction cache stamps the project's own files and explicitly skips
every declaration file, so nothing under `node_modules` is part of the
key. A summary that embeds a dependency version would therefore go
stale and stay stale: `npm install zod@4` with no source edit leaves
every project file's mtime and size untouched, the tsconfig untouched
and the pack digest untouched, so the run is a clean cache hit and
serves summaries stamped with the previous version indefinitely.

Two changes fix it, and the first is required anyway because the `ref`
shape gains fields. Bump the cache's schema version, and add a stamp for
the lockfile next to the existing tsconfig stamp, which is one `stat`
and catches essentially every dependency change. Stamping dependency
declaration files individually is the wrong answer: the current stamping
pass stats every path it is given, and a dependency tree runs to tens of
thousands of files.

## The hash is a Merkle tree

A shape's hash is built from its members' hashes rather than from a
flattened rendering of its structure. That is one mechanism doing four
jobs the design wants anyway, which is the reason to choose it rather
than an optimization bolted on afterwards.

**Equality** is the root hash. Two sides compare one string.

**Localizing a difference** is descending into the branches whose hashes
differ. Neither side ships the contents of the differing branch, only
its hash, and the answer is still "the `body` field differs". A flat
one-hash-per-member scheme is a one-level Merkle tree, so the question
was never whether to do this, only how deep to carry it.

**Deduplication** falls out, because identical subtrees hash identically.
That is content addressing, and the measurement below is what decides
whether it earns its place.

**Incremental recompute** falls out of the same property. A subtree whose
hash has not changed does not need re-deriving, which is what the
incremental-extraction work in the backlog wants, and it can use this
store rather than a second one.

What the alternatives each fail to do: a flat hash gives equality and
nothing else, provenance gives redemption but cannot localize, and
carrying the full structure gives everything at exactly the cost the
library-type fix just removed.

### A mismatch is not a finding

This is the rule that makes the rest safe. A matching hash means the two
sides agree, and comparison stops. A differing hash means the structural
comparison has to run. It is never a verdict of difference.

So a DOM lib that changed between TypeScript 5.3 and 5.4 costs a
structural comparison that finds nothing, rather than a finding nobody
caused. The compiler version does not have to be recorded to suppress a
false report, because there is no false report to suppress.

It also settles how wide the hash should be. A collision is a
correctness bug, since it makes two different things agree silently. A
difference is only a cost. Those are not symmetric, so the width should
be chosen against the collision, not against the corpus. Take 128 bits
of SHA-256. The measured corpora have 1,262 and 3,351 distinct composite
types, where even 64 bits collides with probability around 10^-13, but
designing to today's corpus is how the next one surprises you, and the
16 extra bytes per hash are noise next to what they buy.

Reporting no collisions over a few thousand shapes, as an earlier draft
of this proposal did, is not evidence of anything. Zero is what the
birthday bound predicts at that scale.

### What the hash covers

Members sorted by name, each contributing its name and its own hash. For
a union, the variant hashes deduped and sorted, so declaration order
does not matter. For a literal, its value. For a primitive, its kind.

Two normalization decisions the measurement forced:

- **`raw` is excluded.** 49 pairs in Saleor differ only in whether a
  numeric literal carried its source text, `0` against `0` written as
  `"0"`. Those are the same value on the wire and should hash the same.
  This showed up as an apparent collision count that was identical at 64
  and at 128 bits, which is the signature of a normalization difference
  rather than a hash one.
- **`spreads` is included.** 41 of Saleor's 2,136 record shapes carry
  spreads, meaning the reader could not enumerate them. A hash that
  ignored the field would report those records as fully known, which is
  the unknown-against-empty conflation this design is supposed to
  respect.

Optionality is a flag on the member rather than a union with
`undefined`, since `{ a?: string }` and `{ a: string | undefined }` are
the same thing on the wire.

**Stability across runs** follows from sorting. **Across suss versions**
it does not follow from anything, so the hash carries its normalization
version, `f1:` today, and a checker comparing `f1:` against `f2:` falls
through to comparing members instead of concluding anything. **Across
two repositories** it holds for the right reasons: the hash survives a
renamed type, a moved file and a different package, and does not survive
a different member set. **A member added elsewhere does not change it**,
because the walk covers only what this type reaches.

### Cycles are the hard part

A Merkle hash is bottom-up and a recursive type has no bottom.

Back-references that count binders handle simple self-reference:
`type Tree = { value: string; children: Tree[] }` terminates with the
cycle's shape in the hash. Mutual recursion between two or more types
does not reduce that way, because there is no entry point that makes all
of them well founded at once.

The standard answer is to hash a strongly connected component as a unit
under a canonical ordering, which is bisimulation minimization, the same
machinery as minimizing a finite automaton. Condense the type graph into
its strongly connected components, hash each component once from a
canonical form of its members with intra-component edges replaced by
position markers, and the condensation is a directed acyclic graph on
which bottom-up hashing works. Unison content-addresses mutually
recursive definitions exactly this way, so this is a working precedent
rather than a derivation.

The cost is precision. Inside a component there is no per-member hash,
so a difference localizes to the component rather than to a member of
it. That is bounded to mutually recursive groups, which in practice
means the DOM and a handful of tree-shaped types.

Whether to build it now has a clear answer, and it is no. The shapes a
summary carries are already finite trees, because the walk terminated
before serializing them, so the cross-repository hash never meets a
cycle. Cycles arise only when hashing compiler types directly, which is
the in-run case. Name the construction, cite the precedent, and build it
when something hashes source types rather than serialized ones.

### How deep to carry it

Depth is a dial between size and precision, and both corpora agree on
where it should sit. Measured on current main, after the library-type
fix, against the full structure as the baseline:

| Merkle depth | saleor bytes | of full | twenty bytes | of full |
| --- | ---: | ---: | ---: | ---: |
| 0, root hash only | 502,754 | 30.8% | 640,895 | 20.5% |
| 1 | 666,295 | 40.9% | 898,816 | 28.8% |
| 2 | 896,155 | 55.0% | 1,167,722 | 37.4% |
| 3 | 1,143,219 | 70.1% | 1,537,190 | 49.2% |
| full structure | 1,630,036 | 100% | 3,122,257 | 100% |

Against how often each depth names the exact member that differs, rather
than the branch containing it:

| depth | saleor | twenty |
| --- | ---: | ---: |
| 0 | 85.7% | 83.7% |
| 1 | 92.6% | 93.4% |
| 2 | 95.7% | 96.3% |
| 3 | 97.2% | 97.7% |

Depth 1 is the recommendation. It costs 41% and 29% of the full
structure and names the exact differing member for 93% of shapes, and
for the rest it still names the top-level member that contains the
difference, which is what a person needs to go and look. Depth 2 buys
three more points of precision for a third more bytes. The shapes deep
enough to need it are rare: the deepest shape in either corpus nests 11
and 13 levels, and 86% of shapes have no nesting at all.

## Sharing: does one store beat copying subsets

If a summary carries only the members a boundary touches, the same type
used at fifty sites is represented fifty times, each as a different
partial view, with nothing recording that they are the same type. A
field changing then has to be noticed independently at each site. With a
content-addressed Merkle graph, the type is carried once and each site
records which branches it depends on, so the identity is shared and a
changed field moves one subtree hash that every dependent site can be
asked about.

The payoff scales with reuse and width, so it is measurable rather than
a matter of taste.

**Types are mostly used once, and the bytes are mostly not.** On Saleor,
936 of 1,262 distinct composite types (74.2%) appear at exactly one
boundary; on Twenty, 2,699 of 3,351 (80.5%). The median type appears at
one boundary and has two members. By that count the simpler design
should win.

The occurrence weighting says otherwise. Saleor's 1,262 types occur
6,321 times and Twenty's 3,351 occur 16,120 times, so the reused
minority carries most of the mass. The tail is long: the 99th percentile
type appears at 20 boundaries on Saleor and 31 on Twenty, and the most
reused appears at 135 and 202. Storing each distinct type once rather
than at every occurrence is 34.5% of the inline bytes on both corpora,
which is the same figure to three digits on two unrelated codebases.

**Where the two designs cross.** Writing `f` for the share of a type's
members one site touches, with each design charged for what it has to
serialize:

| f | saleor copied | saleor shared | twenty copied | twenty shared |
| ---: | ---: | ---: | ---: | ---: |
| 0.05 | 1,845,812 | 2,007,738 | 4,788,124 | 5,280,681 |
| 0.10 | 1,909,339 | 2,016,054 | 5,012,759 | 5,295,537 |
| 0.20 | 2,095,108 | 2,037,498 | 5,516,000 | 5,331,417 |
| 0.50 | 3,011,678 | 2,125,170 | 7,733,463 | 5,514,981 |
| 1.00 | 4,604,315 | 2,295,858 | 12,235,167 | 5,852,145 |

The crossover is at `f` around 0.15 on both. Below it, copying a tiny
subset per site is cheaper than carrying a shared node plus references.
Above it, sharing wins and keeps winning.

`f` is the one number here that is not measured, because participation
is not extracted yet. So the result to carry forward is the crossover
rather than a verdict: if boundaries touch under about a seventh of a
type's members, copy the subset; otherwise share. The median type has
two members, where any touch at all is half of it, so most of the corpus
sits well above the crossover.

Sharing also removes a claim I would otherwise have had to make. Without
it, participating members shrink a consumer's summary and do nothing for
a provider, which must record everything it produces because it cannot
know its consumers. With sharing, a provider recording its full produced
structure is much less costly, because a widely reused type is stored
once rather than once per boundary.

### What sharing costs to read

A summary full of hash references reads worse than one with the shape
inline, and that cost is worth naming rather than waving past. The
mitigation is that `suss inspect` already exists as the view meant for
people, so the stored form can be addressed and the reader can resolve
references before showing anything. What should not happen is the wire
format becoming unreadable on the assumption that nobody opens it.

### Two things ruled out

**Bloom filters** for membership, to test whether a provider has a field
without enumerating its members. A Bloom positive is a maybe that has to
be verified and only the negative is exact, so this is a safe fast
reject rather than an unsafe accept. The reason to skip it is cost:
once a shape carries only participating members the set is small enough
that exact membership beats a filter plus a verification pass. Bloom
pays when a set is large and cannot be shipped, and participating
members is the decision not to have a large set.

**Signing** belongs to a different layer. It makes a published summary
trustworthy to someone who did not produce it, which is a cross-repo
product concern rather than a format one. Worth knowing the content
hashes make it easy later. Not designed here.
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
this model it walks five rungs and stops at the first that answers.

1. **Root hashes equal, same normalization version.** `match`, nothing
   expanded. Every unchanged shared type lands here.
2. **Root hashes differ.** Not a verdict, and not a finding. Descend
   into the branches whose member hashes differ.
3. **The differing branches are ones the consumer does not touch.**
   `match`. This is the rung that makes the check about dependencies
   rather than types, and it is the reason a provider adding a field
   nobody reads stops being reported.
4. **A differing branch is one the consumer requires.** Compare the two
   sides' member sets there. A required member the provider does not
   produce is `nomatch`, with the path that names it.
5. **Either side is unenumerable, or one carries only a name.**
   `unknown`, with the reason recorded. Provenance is the escape hatch:
   a tool that can install the package at the recorded version
   re-derives the member and turns this into a verdict.

Every verdict the checker reaches today it still reaches. Rung 1 is
free, rung 3 removes findings that were never about anything, and rung 4
answers a case that used to fall through to `unknown`.

### The wrong answer this fixes

`bodyShapesMatch` returns `match` for two `ref`s whose names are equal,
whatever they contain. Two repositories that each declare a `User`
compare as agreeing even after their fields have drifted apart, which is
the case cross-repository checking exists to catch. A hash is what makes
reference against reference decidable rather than assumed.

### What is lost

**Nominal distinctions.** Branded types, `unique symbol`, private class
fields. Two structurally identical branded types hash the same, so suss
says they agree where tsc says they do not. That is an
over-approximation in the direction of agreement, which for a checker
means a finding it does not report rather than one it reports wrongly.
The checker already prefers that trade, which is why `unknown` exists.

**Declared inheritance.** `class Admin extends User` is structurally
wider, and the member walk gets width right. Variance on function-typed
members is not decidable from what a summary carries.

**Type-level computation.** Conditional types, mapped types, template
literal types. All resolved at extraction, at a use site, with the
result carried. Nothing can re-evaluate them later and nothing needs to.

**Generics before instantiation.** The extractor resolves a type at the
node that uses it, so `Page<User>` is hashed instantiated and compares
correctly against `Page<Order>`. An uninstantiated generic is not
comparable and should not be pretended otherwise.

### What reporting looks like

Losing the ability to print both structures costs the report nothing,
because the report never printed them. A `Finding` today is a kind, a
boundary, two sides, a severity, and a prose `description`. Shape
mismatches read `Handler returns a body on status 200 that does not
match the declared schema`, with no field named. The one place a shape
path reaches a person is the optional-field warning in
`bodyCompatibility`, which already carries `string[]` paths.

What the model does is make the missing half worth building. Rung 4
knows the path, and the finding should carry it as a structured field.
Not in `description`, because findings dedupe on that string and putting
a path in it would stop findings collapsing that collapse today.

## The design that would collapse this

Worth working as a serious alternative, because if it holds then most of
the above is unnecessary: **provenance plus participating members, with
hashing only as an in-run optimization.**

The argument for it is direct. If adjudication only ever consults the
members a boundary touches, then a hash over the full structure answers
a question nobody asks. Worse, for a library type it will differ across
patch releases in members nobody reads, so the fast path fails
constantly and every comparison falls through to a structural walk that
then filters to nothing.

Three things it cannot do, which is why it is not the recommendation.

**It cannot share.** Participating members copied per site means a type
used at 135 boundaries is 135 unrelated partial records with nothing
recording that they are the same type. The measurement above prices
this: storing each distinct type once is 34.5% of the inline bytes on
both corpora, and the crossover sits at a boundary touching about a
seventh of a type's members. Most of the corpus is above that.

**It cannot answer "what else depends on this".** A changed field in a
shared type should be answerable as a set of dependent sites. Copied
subsets have no shared identity to ask about, so that question needs a
scan and a structural comparison at every site.

**It cannot skip work it has already done.** A subtree whose hash has
not changed does not need re-deriving. Without content addresses,
incremental extraction has to find that out some other way.

The correct reading of the objection is narrower than it first appears,
and it survives: **hash the shape as carried, not the full type.** A
hash over members nobody touches is the thing that answers nobody's
question. A hash over what the summary actually carries is free, since
the bytes are already there, and it is what rungs 1 and 2 use. The
full-structure hash keeps exactly one job, which is in-run identity for
deduplication and incremental recompute, and it never has to be
serialized.

So participation says which branches a boundary depends on, and the
graph is what those branches point into. Without the graph, participation
is a copied subset. With it, participation is a reference.
## Language neutrality

Structural identity, reference by name, expansion on demand, and
recording what a boundary touches are statements about boundaries rather
than about TypeScript. Two checks on that.

**A Python adapter** has no structural type system to force. It has
`TypedDict`, dataclasses, pydantic models, and annotations that may be
missing entirely. Reference by name works. A hash over the field set of
a dataclass works. Participation works, because attribute reads are
syntax and Python has them. What Python cannot supply is a checker that
expands on demand at arbitrary depth, so the adapter has to produce the
member set itself, eagerly, for the members it says participate.

**A Go adapter** has named struct types and `json` tags, and the tag is
the wire name while the field name is not. So the normalization has to
hash wire names rather than declaration names, or a Go provider and a
TypeScript consumer describing the same payload will never agree. That
is a useful forcing function: hashing the wire name is what makes
cross-language pairing possible at all. Participation has the matching
subtlety, since a Go consumer touches `resp.UserID` while the wire name
is `user_id`, so the participating path has to be recorded in wire
terms too.

Both point the same way. The normalization and the hash belong in
`@suss/ir-core`, which already owns `TypeShape` and `bodyShapesMatch`
and is where the two checkers were deliberately kept from drifting. Each
adapter supplies a name for a type, a list of `(wireName, optional,
memberShape)` triples, and the paths each boundary touches. Nothing
else. That is the same split
`@suss/resolution` already uses, where the rules are language-neutral
and the adapter supplies facts, so shapes should follow it and no new
package is needed.

## What this costs

**The published IR.** Three optional fields across two existing
variants, plus a side store for shared shapes. Old
summaries parse in a new reader, because nothing became required. New
summaries parse in a 0.1.0 reader, because none of the zod objects use
`.strict()` and unknown keys are stripped; a 0.1.0 checker keeps working
and never takes rung 1. A shared store is the one part that does not
degrade quietly, since a reader that does not resolve references sees a
hash where a shape used to be, so summaries should stay self-contained
until a format version says otherwise. The generated JSON Schema is the
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
hash rungs above its existing body. The `ref`-against-`ref` branch
changes verdict where names match and hashes do not, and the
participation rung removes findings about members nobody reads. Those
are the two behaviour changes, and the second is the point rather than a
side effect. `providerCoversConsumerFields` becomes the consumer half of
participation rather than a checker-private notion.

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
falls back to. `bodyShapesMatch` compares. `readsProperty` and
`comesTo` are what participation is derived from. The consumer field
tree the checker builds at check time is a participation set already,
computed and thrown away. Two pieces are missing: a content hash, and a
place to record what a boundary touches.

**Does it reuse what exists?** `refFromType` is the emission path
unchanged. `packagePartOf` and `packagesDeclaring` in the fact layer
already map a path to a package, handle scoped names and nested
`node_modules`, and already refuse to call `typescript/lib/lib.*.d.ts` a
package. They are private to that module and answer a different question
(which dependency a call belongs to), so the reusable part is the path
walk rather than the function. `canonicalize` in the CLI is this repo's
canonical JSON idiom and the normalization should read like it.
`bodyShapesMatch` keeps its signature and its three-valued result.

**Does it widen shared vocabulary?** By two words. "Provenance" for
where a type came from, and "touches" for what a boundary depends on.
Both are plain English and neither has an existing name in the codebase.
The theory vocabulary, row polymorphism and structural subtyping, is
borrowed rather than invented. "Merkle" and "content-addressed" stay out
of the IR field names and live in the prose that explains them.

**Is it over-designed?** In full, yes, for what a single release can
justify, and the recommendation splits it accordingly. The part that
stands alone is participation, which changes what the check means and
needs no hash, no sharing and no provenance to be useful.

**Naming.** `hash` as the field, since the thing it holds is a content
hash and calling it a fingerprint in one place and a hash in another
would cost every later reader a lookup. `touches` for participation, and
`from` for provenance, both reading as the answer they give back.
`hashOf(shape)` and `touchesOf(unit, value)` as the functions, not
`computeHash` or `getParticipation`.

**Verified against code somebody wrote.** Saleor Dashboard and Twenty's
frontend, both public, both measured on current main with `--no-cache`,
plus a probe of what provenance the compiler actually gives up for a
type in each of those projects.

**What it does not do.** Assignability stays an approximation. Nominal
types, variance and uninstantiated generics are given up, and a summary
will keep saying two branded types agree where tsc says they do not.
Participation makes the positive space precise and does nothing for the
negative space, so a consumer depending on a status an endpoint never
returns is still invisible. Mutual recursion is named rather than
handled. And the depth cap stays where it is, as the backstop for a type
nothing else stopped.

## Recommendation

Four steps. The first has landed, and the rest are ordered so each one
is measurable without the ones after it.

1. **The library-type fix, which merged as #66.** Saleor Dashboard now
   writes 15.9MB where it used to fail at V8's string cap, extraction is
   about a fifth faster, and the largest summary went from 259MB to
   242KB. Nothing in this proposal was needed for it.

2. **Participation, on the consumer side only.** The rules compose from
   `readsProperty` and `comesTo`, the field tree already exists inside
   the checker, and the discriminated union that keeps unenumerable
   apart from empty is the whole of the new vocabulary. Measure the
   dogfood run and both public corpora: how many findings disappear
   because they were about members nobody reads, and how many consumers
   come back unenumerable.

   This is the step worth arguing about first, because it changes what
   the check means rather than what it costs.

3. **The content hash, depth 1.** Adds rungs 1 and 2, fixes the
   reference-against-reference answer that is wrong today, and costs 41%
   and 29% of full-structure bytes on the two corpora while naming the
   exact differing member for 93% of shapes. 128 bits, because a
   collision is a correctness bug and a difference is only cost.

4. **Provenance, then sharing.** Provenance is what makes a reference
   redeemable and a diff legible, and it is derivable for a
   module-declared dependency and not for an ambient type, so it ships
   with the run-level compiler header that covers the second case. The
   cache has to gain a lockfile stamp in the same change or summaries
   will carry stale versions forever. Sharing comes last because its
   case rests on the crossover measurement, and because it is the only
   part that changes how a summary reads.

The two claims this proposal makes should not be allowed to borrow each
other's evidence. The library-type fix is what did the work on size.
Participation is what does the work on precision, and its size effect
lands on the consumer side only, since a provider has to record
everything it produces. Sharing is what stops that provider-side cost
from scaling with reuse, and the numbers for it are above.
