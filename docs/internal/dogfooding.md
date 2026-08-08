# Dogfooding: suss on suss

What happens when you run suss against its own source. We're not
after a shipping report. We want to sit in the user's chair and ask
"I have a TypeScript codebase, I want summaries, what happens?"

What follows is what worked, what didn't, and what the experience
tells us about the pack interface. The reproducer
lives in [`scripts/dogfood.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/dogfood.mjs); run it
with `node scripts/dogfood.mjs` (after `npm run build`).

## Setup

The script walks every `@suss/*` package and, for each package,
runs the adapter twice:

- **`packageExports`**: produces `library`-kind provider
  summaries for the package's public API (reachable from
  `package.json` entry points, following barrel re-exports
  through `ts-morph`).
- **`packageImport`**: produces `caller`-kind consumer
  summaries for every function in the package that calls into
  another `@suss/*` package.

Both sides land in `<pkg>/.suss/suss-summaries.json`, in the
format the "Publishing summaries" section of
`docs/behavioral-summary-format.md` proposes. A package that means
to publish its contract writes that file into `dist/` alongside its
build. This run only analyses this repo locally, so the file goes
beside the extraction cache instead, where git and npm both already
ignore it. The consolidated
roll-up (`scripts/dogfood-report.json`) includes a `pairing`
section: we run `pairSummaries` across the union of all
packages, and record every matched provider↔consumer edge
under `fn:<package>::<exportPath>`.

## What the run produces

**202 export + 785 internal + 278 consumer summaries across 38/38 `@suss/*` packages. 270 cross-package edges paired.**

We count library summaries on two lines because the two move for different reasons.

The 202 export summaries describe what the packages promise callers. Each one comes with a package and an export path that we build a pairing key from, and that path is either one a manifest declares or a method you reach through one. That number only moves when a package's public surface moves.

The 785 internal summaries come from the transitive-closure pass. Every helper a pack-recognised entry point reaches through a static call chain gets its own summary, and `recognition: "reachable"` is what tells them apart. A helper we reached this way is inside a package rather than on its edge, so it has no export path and cannot pair, and `pairSummaries` reports all 785 under `unmatched.noBinding`. That number moves when extraction changes, and also when someone adds or removes a private helper.

Mixed into one number, the two hid each other. `@suss/cli` declares ten exports, and adding one module of five module-private helpers to it moved the old provider count from 70 to 75, which looked like the package growing its API when no caller could reach any of the five.

`scripts/dogfood.mjs` writes these counts to `scripts/dogfood-baseline.json`, which we commit, and CI runs the script on every push. [What CI enforces](#what-ci-enforces) covers what happens when a number moves.

Top consumed exports (packages most depended on by others in the
suss monorepo):

| Export | Callers |
|--------|--------:|
| `@suss/adapter-typescript::createTypeScriptAdapter` | 43 |
| `@suss/adapter-typescript::createTypeScriptAdapter.extractAll` | 43 |
| `@suss/behavioral-ir::restBinding` | 22 |
| `@suss/behavioral-ir::functionCallBinding` | 13 |
| `@suss/behavioral-ir::messageBusBinding` | 12 |
| `@suss/checker::checkAll` | 11 |
| `@suss/manifest-aws::refTarget` | 8 |
| `@suss/behavioral-ir::runtimeConfigBinding` | 6 |
| `@suss/extractor::assembleSummary` | 6 |
| `@suss/behavioral-ir::graphqlResolverBinding` | 5 |

Every edge is a behavioural pair. The provider summary describes
what the called function does (its conditions and outputs, branch by
branch), and the consumer summary describes what the enclosing
function does around the call. The checker's existing pairing
machinery does the matching. There is no new pairing rule, only a new
`boundaryKey` branch for `function-call` semantics that uses
`package` and `exportPath`.

## What the output looks like

### Library provider

`@suss/checker::predicatesMatch` is a fair mid-sized example, a
4-branch dispatch that returns a string literal per branch:

```
@suss/checker::predicatesMatch
  package-exports:@suss/checker library | packages/checker/src/predicates.ts:12

    if  predicateContainsOpaque(a) || predicateContainsOpaque(b)
      -> return "unknown"
    elif  predicateContainsUnresolved(a) || predicateContainsUnresolved(b)
      -> return "unknown"
    elif  a.type !== b.type
      -> return "nomatch"
    else
      -> return "match" | "nomatch"
```

The header reads "package `@suss/checker`, export
`predicatesMatch`". The provenance line says the
`package-exports:@suss/checker` pack produced a `library`-kind unit
rooted at `predicates.ts:12`. Each branch shows the predicate that
decides it and the literal value that path returns, with no opaque
conditions.

### Consumer (caller)

`checkDir` from `@suss/cli` consumes `@suss/checker::checkAll`:

```
checkDir → @suss/checker::checkAll
  package-exports:@suss/cli caller | packages/cli/src/check.ts:104

    if  !(fs.existsSync(path.resolve())) || !(fs.statSync(resolved).isDirectory())
      -> throw Error
    elif  fs.readdirSync(resolved).filter().length === 0
      -> throw Error
    else
      -> return { findings, hasErrors, result }
```

The header is written as `caller → target`. `checkDir` is the
enclosing function that contains the call, and
`@suss/checker::checkAll` is what it consumes. Its own decision tree
has three branches: two throws that validate the input, and a
happy-path return with the record we expect.

### Pairing

When you run the checker across the union of all summaries, that
consumer summary pairs with the provider summary for
`@suss/checker::checkAll` through the key
`fn:@suss/checker::checkAll`. This is the same machinery the REST
checker has used for HTTP boundaries since day one, except that the
key comes from `function-call` semantics instead of from
`method + path`.

For the full interpretation guide (header shapes, branch
rendering, gap annotations), see [CLI reference: Reading the output](/reference/cli#reading-the-output).

## What this exercises

- **`packageExports` discovery**: resolves `types` / `default` /
  `import` conditions on `exports`, falls back to `types` /
  `main` / `module` when `exports` isn't set, rewrites
  `dist/*.d.ts` → `src/*.ts`, follows barrel re-exports.
- **`packageImport` discovery**: walks the named and default
  imports from the packages it targets, records call expressions
  on a bare identifier, and deduplicates by (enclosing function ×
  consumed binding).
- **`library` and `caller` `CodeUnitKind`s**: the provider side and
  the consumer side of the in-process `function-call` boundary.
  Both slot into `BOUNDARY_ROLE` correctly.
- **Per-package contracts**: the generated
  `.suss/suss-summaries.json` files now contain both sides
  together, so anyone consuming the published package can run their
  own summaries against the shipped contract with `suss check`.

## Where the unmatched summaries come from

The run leaves 134 providers and 8 consumers unpaired, plus the
753 with no binding. Every group has a cause.

**The 753 with no binding are expected.** All of them have
`recognition: "reachable"` and `kind: "library"`. They are the
internal helpers the transitive-closure pass picks up, and
`@suss/adapter-typescript` alone contributes 342 of them from
things like `nodeKey` and `locationKey` in `resolve/`. A helper
nothing outside its file calls is not on a boundary, so it has
no package or export path, and `pairSummaries` therefore cannot
build a key for it. The name is what misleads: these do have a
`function-call` binding, and all they lack is the package and
export path a pairing key needs. Anyone who wants the number
smaller should change how `pairSummaries` reports, not what the
adapter sees.

**Of the 134 unmatched providers, 23 point at something suss
should be recognizing.**

- **17 are the `default` export of a package the CLI only ever
  loads through a dynamic `import()`.** `loadFramework` reaches
  for `mod.default` and nothing else, so treating one of those
  thunks as a consumer edge would recover the default and no
  more. 39 unmatched providers are in those nineteen packages.
  The other 22 are named exports, and they go unmatched for the
  ordinary reason below rather than because of the dynamic
  import. `fastifyFramework` and `honoFramework` are two of the
  22: nobody imports them by name, so the dynamic `import()` is
  not what hides them.
- **6 are `@suss/ir-core` exports that `@suss/behavioral-ir`
  re-exports**, `graphqlResolverBinding` and `messageBusBinding`
  among them. A consumer's boundary key uses the specifier the
  consumer wrote, so it pairs with the barrel's copy of the
  provider and leaves `ir-core`'s original unmatched. Both
  providers describe the same function, and following a re-export
  back to the package that declares it would collapse the pair.

The remaining 111 are ordinary: exports whose only callers are
inside their own package or in tests, which the run does not
scan.

**The 8 unmatched consumers are member calls on a returned or
parsed value**, like `checkAll(...).findings.filter(...)` and
`SuppressionFileSchema.safeParse(...)`. The consumer records the
whole member chain as its export path, and nothing publishes a
provider under that key. This is the number
`dogfoodInvariants.mjs` puts a ceiling on, because what bounds
it is how well suss resolves rather than how large this repo is.

## What CI enforces

Two things, and they fail for different reasons.

**The invariants** live in `scripts/dogfoodInvariants.mjs` and
`npm run dogfood` checks them on every run, with no baseline and
no git ref involved:

1. Every function a package declares as a callable export has a
   provider summary. The declared set comes from each manifest's
   `exports` map, read through the TypeScript compiler, so it is
   a second opinion that nothing in suss produced. The export
   count in the baseline reads the same set from the same place,
   so the count and the invariant cannot disagree about what a
   package exposes.
2. Every summary a pack recognised comes with the package and
   export path we build a pairing key from. The transitive closure
   is the exception, since a helper we reached is not on a
   boundary.
3. No more than eight consumers go unpaired while their provider
   is in the same run.

These stay true whatever the source looks like. Move an export
between packages and both sides still balance. Delete one and
there is nothing left to require. Strip a package back to types
and it asks for nothing at all.

**The counts** live in `scripts/dogfood-baseline.json` and
`npm run check:dogfood` compares a fresh run against the copy
committed in the same tree. They only act as a floor: a number
going up is fine and needs no refresh, and CI on main pushes the
refreshed file back so the floor keeps up with the source.

The counts are there because the invariants cannot see a
recognizer that stops firing at some call sites while it keeps
firing at others. Every declared export still has its summary,
every boundary still has its key, and the only thing that moved
is how much of the closure suss reached. That closure is 785 of
the 987 library summaries, so leaving it unguarded would leave
most of the run unguarded. The internal line is where it shows
up: stop the closure expanding and internal falls to nothing
while every export and every invariant still passes.

A refactor moves the internal line too, and that is why it is its
own line rather than folded into the export count. Pulling a
helper out of a function raises it, inlining one lowers it, and a
reviewer who reads "internal fell, exports held" knows to ask
which of the two happened. When both counts were in one number
there was nothing to ask.

### What this blocks, and what to do about it

A count going down fails the build. That is the point, and it
means these ordinary changes fail until you do something about
them:

| What you did | What to do |
|---|---|
| Deleted an export or folded two helpers into one | `npm run dogfood`, commit the refreshed baseline |
| Inlined a private helper, or moved one behind a call the closure cannot follow | Same. The internal line drops and the export line stays put |
| Moved an export from one package to another | Same. The losing package's line drops and the gaining package's rises, and you see both in the diff |
| Narrowed a recognizer that was over-firing | Same. This is the case worth being careful about, since the diff looks identical to a regression |
| Renamed a package in place | Nothing. Packages are keyed by directory, so the rename looks like one package whose name changed |
| Moved a package to a different directory | `npm run dogfood`, commit. The old path leaves the baseline and the new one enters it |

The refreshed baseline lands in the pull request diff as a
per-package delta against main, which is where a reviewer reads
it. A drop nobody can explain is the signal. Nothing else can
lower a committed number, and no bot refreshes the file on a
pull request branch, so the drop cannot pass through unseen.

### Its relationship to `check:self`

`scripts/checkSelf.mjs` is the other place suss runs on suss, and
the two answer different questions. `check:self` extracts the
public exports of the two checker packages and runs the CLI's
`check` against the intent specs under `intent/`, asking whether
those exports still behave the way the specs say. It reports and
never fails. The dogfood run asks how much of its own source suss
can see at all, across all 44 packages, and it does fail. Neither
one replaces the other. `check:self` covers two packages in depth
against intent someone wrote by hand, and the dogfood run covers
the whole workspace by breadth.

## What's still out of scope

- **Dynamic `import()`.** The CLI reaches nineteen packages only
  through `BUILTIN_FRAMEWORKS`, a record of
  `() => import("@suss/framework-…")` thunks. `packageImport`
  walks static named and default imports, so none of those loads
  is a consumer edge.
- **Re-export provenance.** `@suss/behavioral-ir` re-exports six
  `@suss/ir-core` exports. A consumer's boundary key uses the
  specifier it imported from, so the barrel's copy of the provider
  pairs and `ir-core`'s original does not.
- **Namespace imports.** We don't track `import * as X from "pkg"`
  on the consumer side yet.
- **Declarative-data packs.** The framework packs (ts-rest,
  Express, Fastify, React, React Router, Apollo) export a single
  factory that returns a `PatternPack` data structure. Their
  public API is structurally small: one summary per pack, each
  with a minimal body. That's correct, because a pack is data
  rather than behaviour. The 38/38 coverage counts them as
  analysed, not as substantive.

## The in-process API holds up

You feed two discovery variants from one pack into the adapter and
paired provider and consumer summaries come out, which is the same
thing the original three-experiment dogfood showed. One friction is
left: `PatternPack` still requires `languages`, `terminals`, and
`inputMapping` even for a pack that doesn't care about several of
them, and putting defaults on the type would cut the boilerplate
for ad-hoc use.

## Follow-ups tracked

These don't land in this pass. They go on the backlog:

1. Treating a dynamic `import()` as a consumer-side edge, so that
   suss can see a plugin registry of import thunks as a dependency.
2. Following a re-export back to the package that declares the
   function, so a barrel does not hide the original provider.
3. Namespace imports (`import * as X`) and pattern exports
   (`./utils/*`).
4. Defaults on `PatternPack` to reduce scaffolding friction.
