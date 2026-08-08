# Proposal: record what a boundary touches, and give a type an identity

Status: draft, seeking alignment. We have not implemented anything here,
apart from the library-type fix that merged as #66 and prompted the
rest. The measurements come from runs against the public dogfood targets
with `--no-cache`, and the byte counts are of compact JSON unless the
text says otherwise.

## The problem

Until #66 merged, `suss extract -p tsconfig.json -f react -f fetch`
against Saleor Dashboard did not produce a file. It ended with
`Invalid string length`, which is V8 refusing to build a string over
512MB. It had read 3057 boundaries correctly and then threw all of it
away at the last step.

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
20KB, which is about what a summary ought to cost.

The next seven are form validation builders, `getValidationSchema` and
its neighbours, at 150KB to 320KB each, which is seven to fifteen times
p99. Each returns a zod schema.

Twenty's frontend has the same distribution with a smaller tail. Its
largest summary is 2,258 times its median, and its p99 is within 7% of
Saleor's, which is the point: the middle of both runs is fine and the top
of both is not.

Counted in shape nodes rather than bytes, Saleor has 6,739,780 nodes
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

#66 fixed the case in front of us: a named type whose declarations all
live outside the project stops at its name. We measured Saleor before
and after:

| | before | after |
| --- | ---: | ---: |
| total summary bytes | 349,144,410 | 7,166,354 |
| median | 1,326 | 1,323 |
| p99 | 20,563 | 14,960 |
| largest | 259,418,210 | 241,646 |
| top ten, share of bytes | 97.8% | 8.2% |
| shape nodes | 6,739,780 | 37,531 |

The file it now writes is forty-nine times smaller, 15.9MB of indented
JSON. Extraction is about a fifth faster, and the DOM hook and both zod
schema builders have dropped out of the top ten. That is a good change,
and it is not the model.

What the fix leaves behind says why. The largest remaining summary is
`useExtensions` at 241,646 bytes, still 183 times the median, and p99
only came down 27%. Every one of the top ten after the fix is a type the
project declared itself, expanded to depth six for no better reason than
that it was there. "Declared outside the project" is a rule about where
a file is, and the reason not to expand `HTMLElement` has nothing to do
with which directory declared it.

The fix also leaves a name that points at nothing. `HTMLDivElement`
serializes with its members gone and no record of where it came from, so
nobody who has the summary can expand it later, or use it to tell
whether two summaries mean the same type. Size was the symptom. The
problem underneath is what a boundary depends on, and how two sides work
out that they agree about it.

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
alive and keeping a reference to a compiler type costs nothing. It
cannot copy the third, because suss compares a summary from one
repository against a summary from another, months apart, with no
compiler and no source for either side. That is the part of the design
we have to work out rather than borrow.

## The model

A shape has three things on it, each doing a different job.

**The members the boundary touches.** This is what settles a mismatch,
and it is the part that changes what the check means.

**Provenance.** Where the type came from. This is what a person reads in
a diff, and what lets somebody redeem the reference.

**A content hash, built as a Merkle tree.** This is a fast path to
"these agree", and a way to narrow down a difference without sending the
structure.

In the IR these are optional fields on variants that already exist, not
a new variant:

```ts
| { type: "record"; properties: …; spreads?: …; name?: string; hash?: string }
| { type: "ref"; name: string; hash?: string; from?: Provenance;
    touches?: Participation }
```

## What the boundary touches

An earlier draft tested a different claim: that a boundary shape is a
serialization shape, so the walk should expand only what can go over the
wire. That claim is true for REST, GraphQL, a message bus and runtime
config, and false for function call and package export, where a callback
or a class instance is the contract itself rather than an accident of
it.

The instinct was right and the test was too narrow. The question is not
what can be serialized. It is what this boundary touches, and that one
works for all six kinds. A consumer that only ever calls one method of
an injected service depends on that method, not on the class. A handler
that returns a library type, where something reads two of its fields
across the wire, has a contract of two fields. `HTMLElement` collapses
to a reference because nothing touches it, which is a stronger reason
than the one about where it was declared.

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
requires. Pairing asks whether what is required is contained in what is
produced.

The asymmetry is the correctness argument, so it has to be explicit. A
provider cannot know its consumers, especially the ones in repositories
it has never seen, so it must never record participation as though it
did. A provider that recorded "the members my consumers read" would
shrink its published contract to whatever today's callers happen to
touch, and tomorrow's caller would pair against a contract nobody ever
checked. Getting this backwards is unsound in the dangerous direction.

### Where it comes from

Most of it comes from facts that already exist. `@suss/resolution`
publishes `readsProperty(x, o, n)`, which says `x` is the expression
`o.n`, along with `bodyCalls`, `callArg` and `comesTo` for following a
value back to where it came from.

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

A member that gets called rather than read is the same relation joined
with `bodyCalls`, and it is worth telling the two apart, because a
consumer that calls `service.charge(...)` requires a member it can call
rather than one that is merely there.

The checker already has the consumer half of this in another form.
`providerCoversConsumerFields` documents that consumer leaves are
`unknown` because the extractor tracked which fields were accessed
rather than what types they contain. That is already a participation
set, computed at check time and then thrown away. This promotes it to
something a summary records.

**The provider side is partly new.** What a function produces falls out
of the paths through it, and the extractor already builds a body shape
from the return expression, so where the provider builds the value, the
participating members are the keys it wrote. Where the provider hands
back a value it got from somewhere else without looking at it, it
produces the whole type and nothing narrows participation. That case has
to say so rather than report an empty set.

### Unknown is not empty

A computed member access, or a spread that forwards a whole value
onward, means nothing can enumerate participation. That has to mean
unknown rather than an empty set. Otherwise a consumer we failed to
analyze looks like one that requires nothing, and pairs with anything.

The repo already keeps a limit on our reading separate from a fact about
the code, in `unreadOutcome` against `unhandledCase`. Participation
follows the same split, which makes it a discriminated union rather than
an array:

```ts
type Participation =
  | { type: "members"; paths: string[][] }
  | { type: "unenumerable"; reason: "computedAccess" | "spread" | "passthrough" }
```

There is already an example of this in the data. 41 of Saleor's 2,136
record shapes have `spreads`, meaning the reader could not enumerate
them, and any hash or member set that ignored that field would report
those records as fully known. The normalization has to fold `spreads`
in, for the same reason that field exists.

What the checker does with it:

- **Both sides known.** You can decide required against produced. A
  required member the provider does not produce is a mismatch, and there
  is a path that points at it.
- **Consumer unenumerable.** What it requires has no bound, so
  participation tells us nothing, and comparison falls back to whole
  shapes, ending at `unknown` when those are references.
- **Provider unenumerable.** Any required member the provider did not
  describe is `unknown` rather than a mismatch, and we can record the
  reason. Provenance is the escape hatch here: a tool that can install
  the package at the recorded version can work the member out again and
  turn `unknown` into a verdict.

### The theory, and which parts of it apply

A consumer's requirement is a row, and the check is assignability
restricted to the members it uses. Row polymorphism and structural
subtyping are the existing vocabulary, and we should borrow them rather
than invent new terms.

What applies: width subtyping is exactly containment, so a provider that
produces more than is required is fine, and the consumer's requirement
is a row open on the right, `{ id: string; name: string | ρ }`.

What does not apply: depth subtyping needs variance, and no summary
records that. Row unification belongs to a type system doing inference,
and this compares two finished records. And what gets computed is not
principal typing, because participation is read off the syntax and
over-approximates what a run would touch, including members reached only
on a path that never runs.

### The limit

This makes the positive space precise and does nothing for the negative
space. Participation says which members something touches. No record at
the member level captures a dependency on something being absent, and
the incident that started this project was a consumer that depended on a
status the endpoint had never returned. Say so, or somebody will read
participating members as covering more than they do.

## A name has to point at something

The library-type fix serializes `HTMLDivElement` as
`{ type: "ref", name: "HTMLDivElement" }` and drops the members. That
name is a label rather than a pointer. Nobody who has the summary can
expand it later, because that needs the compiler and the same library
version in hand, and the summary records neither.

Make it a thing you can follow. We can work out at extraction time where
a type came from, and the answer comes out differently for two kinds of
type.

**A library type has something to point at.** `ZodObject` comes from
`zod` at a version we resolved while reading. Recording the package, the
resolved version and the exported name turns the reference into an
identity: anyone who has the summary can install that package at that
version and read the type.

**A project type has nothing to point at.** There is no package a
consumer in another repository could install that would resolve their
`User`. That is the case the hash exists for, and the argument for the
hash gets stronger once we scope it to the types that need it.

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

Provenance is what a person reads in a diff, and what lets somebody
redeem the reference. The hash is what comparison uses. Neither one
substitutes for the other, and the section on comparison says why.

### Why comparison uses the hash rather than the version

Semver is a stand-in for "did the structure change", and a checksum
tells you that directly. Express 4.18.2 and 4.17.1 with an identical
`Request` hash the same and agree, where a version rule has to guess.
Two packages that vendored the same types agree. A package that changed
a field in a patch release disagrees, and a version rule waves it
through.

Recording the resolved version rather than a declared range follows from
the same reasoning. The resolved version is what we analyzed, so it is
the accurate record, and a range describes an intention that the
lockfile already overrode. Once the hash decides, comparison needs no
semver arithmetic, which takes away the awkward question of what a
provider on `^4.17.0` and a consumer on `~4.18.1` are supposed to
conclude.

### What the adapter can actually resolve

We probed this against an actual project rather than reasoning about it,
and the answer splits along exactly the line the compiler already draws.

**A type declared in a module under `node_modules` gives up all three
fields.** For `z.object({...})` in a project that depends on zod, the
declaration's source file is
`node_modules/zod/v4/classic/schemas.d.cts`, walking up to the nearest
`package.json` gives `zod` at `4.3.6`, the declaring file is a module,
and asking that module's symbol for its exports gets back `ZodObject`.
We can derive the package, the resolved version and the export name, and
nobody has to declare any of them.

**A global ambient type from the default library gives up none of
them.** `HTMLDivElement` and `Date` both report a declaring file of
`/node_modules/typescript/lib/lib.dom.d.ts`, and that file does not
exist. ts-morph does not read the default library off disk; it embeds
those files and mounts them at a made-up path, so `existsSync` on it is
false and walking up for a `package.json` finds nothing to read. The
declaring file is also a script rather than a module, so its symbol is
undefined and there is no list of exports to ask for. This is the case
that started the whole proposal, and walking up to a package cannot
describe it.

Saying the package is `typescript` here would be worse than saying
nothing, because the version on disk is the one ts-morph bundled rather
than the one the project compiles with, and those two routinely differ.
The identity that is correct is the lib file plus the `target` and `lib`
settings that brought it into scope, so `lib.dom` under the run's
compiler options. Those belong to the run rather than to a shape, so
they belong in a run-level header that ambient refs point at, which also
keeps them off thousands of individual refs.

There are five more cases where we can derive an answer but the answer
is wrong or misleading, and this proposal has to say so out loud:

- **`@types/*` packages.** The walk gives back `@types/express` and the
  types package's version, rather than `express` and the runtime
  version. That is the accurate record of what we read. You cannot turn
  `@types/foo__bar` back into `@scope/name` unambiguously, since `__` is
  legal in a plain package name, and the fact layer's
  `packagesDescribedByTypes` already returns both interpretations rather
  than choosing between them. Record the declaring package literally,
  and never pair a runtime name with a types version.
- **Workspace-linked packages.** TypeScript resolves the symlink, so a
  linked workspace package lands at its source path with
  `isInNodeModules()` false and `isFromExternalLibrary()` true. Any
  `node_modules`-based parse returns nothing, the upward walk finds the
  workspace's own `package.json`, and the version there is a placeholder
  that never changes when the linked source does. We can derive it, and
  it is no use anywhere else. It is better to treat such a package as
  project code.
- **Bundled declarations.** A package that inlines another package's
  types into its own `.d.ts` reports itself, with no trace of the
  original and no API that gets it back. The answer is confidently
  wrong, and this is common.
- **Yarn PnP.** Declarations resolve inside zip archives, with no
  `package.json` that any filesystem walk can reach. Somebody has to ask
  the PnP resolver directly, and until that happens, provenance is
  missing rather than wrong.
- **Merged declarations.** `Promise` is declared six times across six
  lib files. Anything that derives provenance from `declarations[0]`
  picks arbitrarily among them.

There is one defect to fix while doing this. The gate that decides a
type is outside the project reads `getSymbol()`, and the function that
emits the name reads `getAliasSymbol() ?? getSymbol()`. So the symbol
whose declarations passed the gate is not always the symbol whose name
gets emitted, which means provenance derived from the alias can point at
a different file than the one we checked.

Throughout this, "we do not know" is a supported answer. A ref with no
`from` is a ref whose origin we could not work out, which is different
from one we never looked for, and the section on gaps keeps those two
apart.

### The cache has to change before any of this ships

The extraction cache stamps the project's own files and explicitly skips
every declaration file, so nothing under `node_modules` is part of the
key. A summary that embeds a dependency version would therefore go
stale and stay stale: `npm install zod@4` with no source edit leaves
every project file's mtime and size untouched, the tsconfig untouched
and the pack digest untouched, so the run is a full cache hit and
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
whether it is worth having.

**Incremental recompute** falls out of the same property. A subtree whose
hash has not changed does not need re-deriving, which is what the
incremental-extraction work in the backlog wants, and it can use this
store rather than a second one.

Here is what each of the alternatives fails to do: a flat hash gives
equality and nothing else, provenance lets somebody redeem the reference
but cannot narrow down where a difference is, and keeping the full
structure gives you everything at exactly the cost the library-type fix
removed.

### A mismatch is not a finding

This is the rule that makes the rest safe. A matching hash means the two
sides agree, and comparison stops. A differing hash means the structural
comparison has to run. It is never a verdict of difference.

So a DOM lib that changed between TypeScript 5.3 and 5.4 costs a
structural comparison that finds nothing, rather than a finding nobody
caused. The compiler version does not have to be recorded to suppress a
false report, because there is no false report to suppress.

It also settles how wide the hash should be. A collision is a
correctness bug, since it quietly makes two different things agree. A
difference only costs time. The two are not symmetric, so choose the
width against the collision rather than against the corpus. Take 128 bits
of SHA-256. The measured corpora have 1,262 and 3,351 distinct composite
types, where even 64 bits collides with probability around 10^-13, but
designing to today's corpus is how the next one surprises you, and the
16 extra bytes per hash are noise next to what they buy.

Reporting no collisions over a few thousand shapes, as an earlier draft
of this proposal did, is not evidence of anything. Zero is what the
birthday bound predicts at that scale.

### What the hash covers

It covers the members sorted by name, each one contributing its name and
its own hash. For a union, it covers the variant hashes, deduped and
sorted, so declaration order does not matter. For a literal, its value.
For a primitive, its kind.

The measurement forced two decisions about normalization:

- **`raw` is excluded.** 49 pairs in Saleor differ only in whether a
  numeric literal kept its source text, `0` against `0` written as
  `"0"`. Those are the same value on the wire and should hash the same.
  This showed up as an apparent collision count that was identical at 64
  and at 128 bits, which is what a difference in normalization looks
  like rather than a difference in the hash.
- **`spreads` is included.** 41 of Saleor's 2,136 record shapes have
  spreads, meaning the reader could not enumerate them. A hash that
  ignored the field would report those records as fully known, which is
  exactly the confusion between unknown and empty that this design is
  supposed to avoid.

Optionality is a flag on the member rather than a union with
`undefined`, since `{ a?: string }` and `{ a: string | undefined }` are
the same thing on the wire.

**Stability across runs** follows from sorting. **Across suss versions**
nothing gives us that, so the hash includes its normalization version,
`f1:` today, and a checker comparing `f1:` against `f2:` falls through
to comparing members rather than concluding anything. **Across two
repositories** it works for the right reasons: the hash survives a
renamed type, a moved file and a different package, and does not survive
a changed member set. **A member added elsewhere does not change it**,
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

The cost is precision. Inside a component there is no hash per member,
so a difference narrows down to the component rather than to a member of
it. That only affects mutually recursive groups, which in practice means
the DOM and a handful of tree-shaped types.

Should we build it now? No. The shapes a summary contains are already
finite trees, because the walk terminated before serializing them, so
the cross-repository hash never meets a cycle. Cycles only come up when
something hashes compiler types directly, which is the in-run case. Give
the construction a name, cite the precedent, and build it when something
hashes source types rather than serialized ones.

### How deep to carry it

Depth is a dial between size and precision, and both corpora agree on
where it should be set. We measured it on current main, after the
library-type fix, against the full structure as the baseline:

| Merkle depth | saleor bytes | of full | twenty bytes | of full |
| --- | ---: | ---: | ---: | ---: |
| 0, root hash only | 502,754 | 30.8% | 640,895 | 20.5% |
| 1 | 666,295 | 40.9% | 898,816 | 28.8% |
| 2 | 896,155 | 55.0% | 1,167,722 | 37.4% |
| 3 | 1,143,219 | 70.1% | 1,537,190 | 49.2% |
| full structure | 1,630,036 | 100% | 3,122,257 | 100% |

And here is how often each depth points at the exact member that
differs, rather than at the branch containing it:

| depth | saleor | twenty |
| --- | ---: | ---: |
| 0 | 85.7% | 83.7% |
| 1 | 92.6% | 93.4% |
| 2 | 95.7% | 96.3% |
| 3 | 97.2% | 97.7% |

We recommend depth 1. It costs 41% and 29% of the full structure, and it
points at the exact differing member for 93% of shapes. For the rest it
still points at the top-level member that contains the difference, which
is enough for a person to go and look. Depth 2 buys
three more points of precision for a third more bytes. The shapes deep
enough to need it are rare: the deepest shape in either corpus nests 11
and 13 levels, and 86% of shapes have no nesting at all.

## Sharing: does one store beat copying subsets

If a summary only includes the members a boundary touches, then a type
used at fifty sites appears fifty times, each time as a different
partial view, and nothing records that they are the same type. Somebody
then has to notice a changed field separately at each site. With a
content-addressed Merkle graph, the type appears once and each site
records which branches it depends on, so the identity is shared, and a
changed field moves one subtree hash that you can ask every dependent
site about.

The payoff grows with reuse and width, so we can measure it rather than
argue about taste.

**Types are mostly used once, and the bytes are mostly not.** On Saleor,
936 of 1,262 distinct composite types (74.2%) appear at exactly one
boundary; on Twenty, 2,699 of 3,351 (80.5%). The median type appears at
one boundary and has two members. By that count the simpler design
should win.

Weighting by how often each type occurs says otherwise. Saleor's 1,262
types occur 6,321 times and Twenty's 3,351 occur 16,120 times, so the
reused minority accounts for most of the bytes. The tail is long: the
99th percentile type appears at 20 boundaries on Saleor and 31 on
Twenty, and the most reused appears at 135 and 202. Storing each
distinct type once rather than at every occurrence is 34.5% of the shape
bytes on both corpora, the same figure to three digits on two unrelated
codebases.

That is a claim about shapes rather than about files, and the two are
easy to confuse. Shapes are about a fifth of a summary's bytes now that
#66 has landed, so a 65% saving on them is 11% of Saleor's output and
10% of Twenty's, measured end to end below. Worth having and not worth
overselling.

**Where the two designs cross.** Write `f` for the share of a type's
members that one site touches, and charge each design for what it has to
serialize:

| f | saleor copied | saleor shared | twenty copied | twenty shared |
| ---: | ---: | ---: | ---: | ---: |
| 0.05 | 1,845,812 | 2,007,738 | 4,788,124 | 5,280,681 |
| 0.10 | 1,909,339 | 2,016,054 | 5,012,759 | 5,295,537 |
| 0.20 | 2,095,108 | 2,037,498 | 5,516,000 | 5,331,417 |
| 0.50 | 3,011,678 | 2,125,170 | 7,733,463 | 5,514,981 |
| 1.00 | 4,604,315 | 2,295,858 | 12,235,167 | 5,852,145 |

The crossover is at `f` around 0.15 on both. Below it, copying a tiny
subset per site is cheaper than a shared node plus the references to it.
Above it, sharing wins and keeps winning.

`f` is the one number here we have not measured, because nothing
extracts participation yet. So what to carry forward is the crossover
rather than a verdict: if boundaries touch under about a seventh of a
type's members, copy the subset, and otherwise share. The median type
has two members, where touching anything at all is half of it, so most
of the corpus is well above the crossover.

Sharing also removes a claim I would otherwise have had to make. Without
it, participating members shrink a consumer's summary and do nothing for
a provider, which must record everything it produces because it cannot
know its consumers. With sharing, it costs much less for a provider to
record the full structure it produces, because a widely reused type is
stored once rather than once per boundary.

### What becomes a node and what stays inline

A reference costs a hash, so anything smaller than a digest should be
written out rather than pointed at. Serialized, a 128-bit reference is
40 bytes. `{"type":"text"}` is 15 and
`{"type":"literal","value":"success"}` is 36. Pointing at either one
loses on size before anything else is considered.

**Primitives and literals always inline.** A reference to `{"type":
"text"}` costs 40 bytes to avoid writing 15, so pointing at one makes
the file bigger and adds a hop to reconstruct a value that was already
in hand. Literals are the same arithmetic: the extractor works to keep
them narrow, so a summary says `"success"` rather than `string`, and
`{"type":"literal","value":"success"}` is 36 bytes against a 40-byte
reference. Nothing smaller than a digest should be pointed at.

**Composites are the decision, and it turns out to be a small one.**
Because the whole program is extracted before anything is written, we
know at write time how often a type occurs, so we can measure the rule
rather than guess it. Here are the total bytes for each threshold,
against today's fully inline form:

| rule | saleor | twenty | nodes (saleor / twenty) |
| --- | ---: | ---: | ---: |
| everything inline, as today | 7,163,231 | 20,048,335 | 0 / 0 |
| node if it occurs more than once | 6,371,771 | 18,132,683 | 353 / 682 |
| node if reused or 4+ members | 6,377,491 | 18,147,443 | 496 / 1,051 |
| node if reused or 8+ members | 6,373,371 | 18,140,443 | 393 / 876 |
| node at 3+ occurrences or 8+ members | 6,378,016 | 18,147,790 | 289 / 674 |
| every composite is a node | 6,388,291 | 18,179,243 | 766 / 1,846 |

Every rule lands within 0.3% of every other. Going from fully inline to
sharing anything at all saves 11% on Saleor and 10% on Twenty, and after
that the threshold stops mattering. Since size does not decide it, take
the rule with the fewest moving parts: **a composite becomes a node when
it occurs more than once in the run, and everything else inlines.** It
produces the smallest output of any rule measured and the fewest nodes
of the rules that tie with it, so it also costs the fewest hops to walk.

Top-level shapes can be references too, which saves a further 59,268
bytes on Saleor and 45,959 on Twenty, or 0.8% and 0.3%. Take it. The
earlier draft of this section kept them inline so that a person opening
the file would find the shape written out, and that reasoning does not
survive: machines read a summaries file, and the next section is about
where a person actually reads this data.

### Two things the rule must not break

**Participation does not need a node to point at.** A participating set
records member paths by name, so `[["user", "id"]]` resolves against an
inline shape as readily as against a stored one. What needs a node is
the question "which sites depend on this subtree", and only a type that
occurs more than once is a node, which is exactly the set that question
is about. A type used once has one dependent site and the answer is
already in hand.

A Merkle descent also survives inlining, because an inlined composite
includes its structure, so you can recompute its hash on the spot rather
than looking it up. Not storing it loses nothing.

**Granularity must not change what comparison concludes.** Whether a
type is inlined or referenced is a decision about layout, so two
summaries that decide it differently have to compare equal. That falls
out as long as we compute the hash over the type, meaning its normalized
member tree, rather than over the JSON that got written. It is worth a
sentence to say so, because computing the hash over the serialized form
would let the format's own layout decide the answer.

### Display is a separate step

Machines read a summaries file. `suss inspect` is where a person meets
the data, and it already exists for that reason. So choose the stored
form for what it costs and what it can answer, and leave legibility to
`inspect`.

That changes what `inspect` does under this model, in two ways worth
having.

**`inspect` resolves references and expands only what is in use.** That
is the participating-members idea again, pointed at display instead of
at checking. A concept that answers two different questions is more
likely to be the right concept, and it means the reader sees the members
a boundary depends on rather than a type's whole surface.

**`inspect --diff` stops printing both structures.** Today a shape
difference means rendering both sides and leaving the reader to find it.
With member hashes, the diff compares roots, descends only into branches
whose hashes differ, and prints those.

The sizes say what that is worth. The largest summary Saleor produces
today is `useExtensions` at 241,646 bytes. A diff of it against a
changed version currently renders both copies, so a reader looks at
roughly half a megabyte to find one changed field. Descending renders
only the branch that changed. The median summary is 1,323 bytes and
would barely notice, which is how these things usually go: the change is
invisible where things are small and decisive where they are not.

## Getting a summary to another repository

Once a summary contains references it is no longer self-contained, and
reading one means having the nodes it points at. Inside a run that costs
nothing. Sending it to another repository, which is the case this design
exists for, that is the whole question.

There are two ways to do it. The file can include its own shape table,
the way a packfile bundles the objects it needs, which is
self-contained, larger, and duplicated between files that share types.
Or a summary can become an index into a store that the tooling fetches,
which is smaller and shared and adds a resolution step that can fail.

**Bundle the table with the file.** The measurement is one-sided.

Two unrelated codebases share almost nothing. Of Saleor's 433 shared
nodes and Twenty's 804, exactly 15 appear in both, worth 975 bytes. A
store shared across the two saves 0.07%. Whatever a fetchable store is
for, it is not for saving bytes between repositories, which is precisely
where its resolution step would be most likely to fail.

Inside one codebase the answer depends on how finely the output gets
split, and the split that matters is the one projects publish at:

| split | units | bundled | one shared table | duplication |
| --- | ---: | ---: | ---: | ---: |
| saleor, by top area | 44 | 450,721 | 420,047 | 7.3% |
| saleor, per directory | 315 | 548,069 | 400,575 | 36.8% |
| saleor, per subdirectory | 710 | 614,493 | 398,720 | 54.1% |
| twenty, by top area | 7 | 931,073 | 899,272 | 3.5% |
| twenty, per directory | 109 | 1,393,176 | 876,696 | 58.9% |
| twenty, per subdirectory | 359 | 1,821,925 | 814,647 | 123.6% |

A project publishes one summary file per package or per service, which
is the top row for each corpus, and there a bundled table costs 3.5% to
7.3% in duplication. Splitting per source file would cost more than the
sharing saves, so the rule is to bundle at the granularity somebody
actually publishes at, and not below it.

None of this touches the benefits inside a run. Deduplication, pointer
equality and skipping subtrees whose hash has not moved all happen while
the program is alive, and none of them need the published artifact to
depend on a store it does not include.

### When a reference cannot be resolved

A bundled table makes this rare rather than impossible. A file can be
truncated, hand-edited, or produced by a version that wrote nodes a
reader does not understand.

An unresolved reference means a shape we could not read. It is not an
empty record, not a missing field, and not silence. The repo already
keeps "we could not read this" apart from "there is nothing here", and
this is squarely the first, so it surfaces as `unknown` with the hash it
could not resolve, the checker treats it the way it treats every other
`unknown`, and `inspect` shows the name and says the structure is
missing.

The other way it could fail, where an unresolvable node quietly comes
out as a type with no members, would make a provider look like it
produces nothing and a consumer look like it requires nothing. Both pair
with anything. That is the direction this project refuses, so how it
degrades has to be written down rather than left to whoever implements
it.

## Two things ruled out

**Bloom filters** for membership, to test whether a provider has a field
without enumerating its members. A Bloom positive is a maybe that
somebody has to verify, and only the negative is exact, so this is a
safe fast reject rather than an unsafe accept. The reason to skip it is
cost: once a shape only includes participating members, the set is small
enough that checking membership exactly beats a filter plus a
verification pass. Bloom pays off when a set is large and cannot be
shipped, and participating members is the decision not to have a large
set.

**Signing** belongs to a different layer. It makes a published summary
trustworthy to someone who did not produce it, which is a cross-repo
product concern rather than a format one. Worth knowing that the content
hashes make it easy later. We are not designing it here.
## Comparison without a compiler

The checker compares with the program in hand: it can force a type,
follow a declaration, and ask about a symbol it has never seen. suss has
a provider summary from one repository and a consumer summary from
another, possibly produced months apart by different suss versions, with
no compiler and no source for either side. Everything the comparison
needs has to already be in the two files.

### The ladder

Today `bodyShapesMatch` returns `match`, `nomatch`, or `unknown`, where
`unknown` means "uncertainty that would mask an actual mismatch". Under
this model it walks five rungs and stops at the first one that gives an
answer.

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
   produce is `nomatch`, with the path that points at it.
5. **Either side is unenumerable, or one has only a name.**
   `unknown`, with the reason recorded. Provenance is the escape hatch:
   a tool that can install the package at the recorded version works the
   member out again and turns this into a verdict.

Every verdict the checker reaches today it still reaches. Rung 1 is
free, rung 3 removes findings that were never about anything, and rung 4
gives an answer in a case that used to fall through to `unknown`.

### The wrong answer this fixes

`bodyShapesMatch` returns `match` for two `ref`s whose names are equal,
whatever they contain. Two repositories that each declare a `User`
compare as agreeing even after their fields have drifted apart, which is
the case cross-repository checking exists to catch. A hash is what lets
us decide reference against reference rather than assume it.

### What is lost

**Nominal distinctions.** Branded types, `unique symbol`, private class
fields. Two structurally identical branded types hash the same, so suss
says they agree where tsc says they do not. That is an
over-approximation in the direction of agreement, which for a checker
means a finding it does not report rather than one it reports wrongly.
The checker already prefers that trade, which is why `unknown` exists.

**Declared inheritance.** `class Admin extends User` is structurally
wider, and the member walk gets width right. You cannot decide variance
on function-typed members from what a summary contains.

**Type-level computation.** Conditional types, mapped types, template
literal types. The extractor resolves all of these at a use site and
records the result. Nothing can evaluate them again later, and nothing
needs to.

**Generics before instantiation.** The extractor resolves a type at the
node that uses it, so `Page<User>` gets hashed instantiated and compares
correctly against `Page<Order>`. You cannot compare an uninstantiated
generic, and we should not pretend otherwise.

### What reporting looks like

Losing the ability to print both structures costs the report nothing,
because the report never printed them. A `Finding` today is a kind, a
boundary, two sides, a severity, and a prose `description`. A shape
mismatch reads `Handler returns a body on status 200 that does not
match the declared schema`, and it never says which field. The one place
a shape path reaches a person is the optional-field warning in
`bodyCompatibility`, which already has `string[]` paths.

What the model does is make the missing half worth building. Rung 4
knows the path, and the finding should record it as a structured field.
Not in `description`, because findings dedupe on that string, and
putting a path in it would stop findings collapsing that collapse today.

## The design that would collapse this

This is worth taking seriously as an alternative, because if it is right
then most of the above is unnecessary: **provenance plus participating
members, with hashing only as an in-run optimization.**

The argument for it is direct. If what settles a mismatch only ever
looks at the members a boundary touches, then a hash over the full
structure answers a question nobody asks. Worse, for a library type it
will differ across patch releases in members nobody reads, so the fast
path fails constantly and every comparison falls through to a structural
walk that then filters down to nothing.

Three things it cannot do, which is why it is not the recommendation.

**It cannot share.** Copying the participating members per site means a
type used at 135 boundaries becomes 135 unrelated partial records, with
nothing recording that they are the same type. The measurement above
prices this: storing each distinct type once is 34.5% of the inline
bytes on both corpora, and the crossover is at a boundary touching about
a seventh of a type's members. Most of the corpus is above that.

**It cannot answer "what else depends on this".** For a changed field in
a shared type, you should be able to get back the set of dependent
sites. Copied subsets have no shared identity to ask about, so that
question needs a scan and a structural comparison at every site.

**It cannot skip work it has already done.** A subtree whose hash has
not changed does not need deriving again. Without content addresses,
incremental extraction has to work that out some other way.

The right reading of the objection is narrower than it first appears,
and it survives: **hash the shape as recorded, not the full type.** A
hash over members nobody touches is the part that answers nobody's
question. A hash over what the summary actually records is free, since
the bytes are already there, and it is what rungs 1 and 2 use. The
full-structure hash keeps exactly one job, identity inside a run for
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
TypeScript consumer describing the same payload will never agree. Being
forced into that is useful: hashing the wire name is what makes
cross-language pairing possible at all. Participation has the matching
subtlety, since a Go consumer touches `resp.UserID` while the wire name
is `user_id`, so the participating path has to be recorded in wire terms
too.

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

**Committed fixtures.** This costs close to nothing. The repo commits no
summaries: 140 tracked JSON files totalling 564,924 bytes, and the only
one that contains shapes is the generated schema itself. The dogfood
baseline contains counts. Coverage summaries contain percentages. The
churn is in TypeScript: 54 tracked files reference `TypeShape` and 30 of
them contain 123 inline `type: "record"` literals. All of them stay
valid, because every new field is optional. The ones somebody has to
touch are the assertions that compare a whole summary with `toEqual`,
which will see new keys.

**The checker.** `bodyShapesMatch` keeps its signature and gains the
hash rungs above its existing body. The `ref`-against-`ref` branch
changes verdict where names match and hashes do not, and the
participation rung removes findings about members nobody reads. Those
are the two behaviour changes, and the second is the point rather than a
side effect. `providerCoversConsumerFields` becomes the consumer half of
participation rather than something private to the checker.

**The gaps we already keep separate.** The repo tells a shape it could
not read apart from a shape that is not there, and a reference model
must not blur the two. Today `{ type: "unknown" }` means we failed to
read it, an absent field means there was nothing to read, and `ref`
means three different things at once: deliberately opaque, cut short by
`MAX_DEPTH`, or cut short by a cycle. Running those together is a defect
the current code already has, and a model that leans harder on `ref`
makes it worse rather than better.

So `ref` needs to say which one it is. A shape reduced to a name because
nobody needed more is a complete answer. A shape cut short at depth six
is an incomplete one. A shape we failed to read is `unknown` and stays
`unknown`. One more optional field on `ref` records which it is, and the
checker can then treat a complete reference as comparable and a
truncated one as `unknown`, which is what each of them deserves and
neither gets today.

## The questions this has to answer

**Could smaller pieces compose to this?** Yes, and most of them already
exist. `refFromType` gives a type's name and is already what the depth
cap falls back to. `bodyShapesMatch` compares. `readsProperty` and
`comesTo` are where participation comes from. The consumer field tree
the checker builds at check time is already a participation set,
computed and then thrown away. Two pieces are missing: a content hash,
and a place to record what a boundary touches.

**Does it reuse what exists?** `refFromType` is the emission path
unchanged. `packagePartOf` and `packagesDeclaring` in the fact layer
already map a path to a package, handle scoped names and nested
`node_modules`, and already refuse to call `typescript/lib/lib.*.d.ts` a
package. They are private to that module and they answer a different
question (which dependency a call belongs to), so what we can reuse is
the path walk rather than the function. `canonicalize` in the CLI is
this repo's canonical JSON idiom, and the normalization should read like
it. `bodyShapesMatch` keeps its signature and its three-valued result.

**Does it widen shared vocabulary?** By two words. "Provenance" for
where a type came from, and "touches" for what a boundary depends on.
Both are plain English, and the codebase has no existing word for either
one. We borrow the theory vocabulary, row polymorphism and structural
subtyping, rather than inventing it. "Merkle" and "content-addressed"
stay out of the IR field names and live in the prose that explains them.

**Is it over-designed?** All of it together, yes, for what a single
release can justify, and the recommendation splits it up accordingly.
The part that is useful on its own is participation, which changes what
the check means and needs no hash, no sharing and no provenance.

**Naming.** `hash` for the field, since what it contains is a content
hash, and calling it a fingerprint in one place and a hash in another
would cost every later reader a lookup. `touches` for participation and
`from` for provenance, because each one reads like the answer it gives
back. `hashOf(shape)` and `touchesOf(unit, value)` for the functions,
rather than `computeHash` or `getParticipation`. The shared store
contains `nodes`, and a reference is a node's hash, so neither "Merkle"
nor "content-addressed" needs to appear in a field name.

**Verified against code somebody wrote.** Saleor Dashboard and Twenty's
frontend, both public, both measured on current main with `--no-cache`,
plus a probe of what provenance the compiler actually gives up for a
type in each of those projects.

**What it does not do.** Assignability stays an approximation. We give
up nominal types, variance and uninstantiated generics, and a summary
will keep saying two branded types agree where tsc says they do not.
Participation makes the positive space precise and does nothing for the
negative space, so a consumer that depends on a status an endpoint never
returns is still invisible. This describes mutual recursion rather than
handling it. And the depth cap stays where it is, as the backstop for a
type nothing else stopped.

## Recommendation

There are four steps. The first has landed, and the rest are ordered so
that we can measure each one without the ones after it.

1. **The library-type fix, which merged as #66.** Saleor Dashboard now
   writes 15.9MB where it used to fail at V8's string cap, extraction is
   about a fifth faster, and the largest summary went from 259MB to
   242KB. Nothing in this proposal was needed for it.

2. **Participation, on the consumer side only.** The rules compose from
   `readsProperty` and `comesTo`, the field tree already exists inside
   the checker, and the discriminated union that keeps unenumerable
   apart from empty is all of the new vocabulary. Measure the dogfood
   run and both public corpora: how many findings disappear because they
   were about members nobody reads, and how many consumers come back
   unenumerable.

   This is the step worth arguing about first, because it changes what
   the check means rather than what it costs.

3. **The content hash, depth 1.** It adds rungs 1 and 2, fixes the
   reference-against-reference answer that is wrong today, and costs 41%
   and 29% of full-structure bytes on the two corpora while pointing at
   the exact differing member for 93% of shapes. 128 bits, because a
   collision is a correctness bug and a difference only costs time.

4. **Provenance, then sharing.** Provenance is what lets somebody redeem
   a reference and what makes a diff legible. We can derive it for a
   module-declared dependency and not for an ambient type, so it ships
   with the run-level compiler header that covers the second case. The
   cache has to gain a lockfile stamp in the same change, or summaries
   will report stale versions forever.

   Sharing comes last, and it is the smallest of the four: 11% of
   Saleor's bytes and 10% of Twenty's, with the threshold making almost
   no difference, and a type becoming a node by occurring more than
   once. The better argument for it is the two questions it answers
   rather than the bytes it saves: what else depends on a changed
   subtree, and what does not need deriving again.

   Each published file includes its own shape table. Two unrelated
   codebases share 15 nodes worth 975 bytes, so a fetchable store saves
   nothing across repositories and would add a step that can fail
   exactly where failing is worst. A reference the reader cannot resolve
   has to mean a shape we could not read, never a type with no members.

The two claims this proposal makes should not be allowed to borrow each
other's evidence. The library-type fix is what did the work on size.
Participation is what does the work on precision, and it only affects
size on the consumer side, since a provider has to record everything it
produces. Sharing is what stops that cost on the provider side growing
with reuse, and the numbers for it are above.
