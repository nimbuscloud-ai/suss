# Dogfooding: suss on suss

What happens when you run suss against its own source. The goal
isn't a shipping report — it's the "sit in the user's chair"
exercise of asking "I have a TypeScript codebase, I want
summaries, what happens?"

This doc captures what worked, what didn't, and what the
experience surfaces about the pack interface. The reproducer
lives in [`scripts/dogfood.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/dogfood.mjs); run it
with `node scripts/dogfood.mjs` (after `npm run build`).

## Setup

The script walks every `@suss/*` package and, for each package,
runs the adapter twice:

- **`packageExports`** — produces `library`-kind provider
  summaries for the package's public API (reachable from
  `package.json` entry points, following barrel re-exports
  through `ts-morph`).
- **`packageImport`** — produces `caller`-kind consumer
  summaries for every function in the package that calls into
  another `@suss/*` package.

Both sides land in `<pkg>/.suss/suss-summaries.json`, in the
format proposed in `docs/behavioral-summary-format.md`'s
"Publishing summaries" section. A package that means to publish
its contract writes that file into `dist/` alongside its build;
this run is local analysis of this repo, so it goes beside the
extraction cache instead, where git and npm both already ignore
it. The consolidated
roll-up (`scripts/dogfood-report.json`) includes a `pairing`
section: `pairSummaries` is run across the union of all
packages, and every matched provider↔consumer edge is recorded
by `fn:<package>::<exportPath>`.

## What the run produces

**202 export + 785 internal + 278 consumer summaries across 38/38 `@suss/*` packages. 270 cross-package edges paired.**

Library summaries are counted on two lines because they move for different reasons.

The 202 export summaries describe what the packages promise callers. Each one carries a package and an export path that a pairing key is built from, and the path is one a manifest declares, or a method reached through one. That number only moves when a package's public surface moves.

The 785 internal summaries come from the transitive-closure pass. Every helper a pack-recognised entry point reaches through a static call chain gets its own summary, with `recognition: "reachable"` telling them apart. A reached helper sits inside a package rather than on its edge, so it carries no export path and cannot pair, and `pairSummaries` reports all 785 under `unmatched.noBinding`. That number moves when extraction changes, and also when someone adds or removes a private helper.

Mixed into one number they hid each other. `@suss/cli` declares ten exports, and adding one module of five module-private helpers to it moved the old provider count from 70 to 75, which read as the package having grown its API when no caller could reach any of the five.

`scripts/dogfood.mjs` writes these counts to `scripts/dogfood-baseline.json`, which is committed, and CI runs the script on every push. [What CI enforces](#what-ci-enforces) covers what happens when a number moves.

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

Every edge is a behavioural pair: the provider summary describes
what the called function does (per-branch conditions + outputs);
the consumer summary describes what the enclosing function does
around the call. The checker's existing pairing machinery does
the matching — no new pairing rule, just a new `boundaryKey`
branch for `function-call` semantics with `package` + `exportPath`.

## What the output looks like

### Library provider

`@suss/checker::predicatesMatch` is a fair mid-sized example — a
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

Header reads "package `@suss/checker`, export `predicatesMatch`";
provenance says the `package-exports:@suss/checker` pack produced
a `library`-kind unit rooted at `predicates.ts:12`. Each branch
shows the predicate that decides it and the literal return value
for that path — no opaque conditions.

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

Header shape is `caller → target` — `checkDir` is the enclosing
function that contains the call; `@suss/checker::checkAll` is
what it consumes. Its own decision tree has three branches: two
input-validation throws and a happy-path return with the
expected record shape.

### Pairing

When you run the checker across the union of all summaries, that
consumer summary pairs with the provider summary for
`@suss/checker::checkAll` via the key
`fn:@suss/checker::checkAll`. Same machinery the REST checker
has used for HTTP boundaries since day one — the key just comes
from `function-call` semantics instead of `method + path`.

For the full interpretation guide (header shapes, branch
rendering, gap annotations), see [CLI reference: Reading the output](/reference/cli#reading-the-output).

## What this exercises

- **`packageExports` discovery** — resolves `types` / `default` /
  `import` conditions on `exports`, falls back to `types` /
  `main` / `module` when `exports` isn't set, rewrites
  `dist/*.d.ts` → `src/*.ts`, follows barrel re-exports.
- **`packageImport` discovery** — walks named + default imports
  from targeted packages, records bare-identifier call
  expressions, deduplicates by (enclosing function × consumed
  binding).
- **`library` and `caller` `CodeUnitKind`s** — provider /
  consumer sides of the in-process `function-call` boundary.
  Both slot into `BOUNDARY_ROLE` correctly.
- **Per-package contracts** — the generated
  `.suss/suss-summaries.json` files now contain both sides
  together; consumers of the published package can run their
  own summaries against the shipped contract via `suss check`.

## Where the unmatched summaries come from

The run leaves 134 providers and 8 consumers unpaired, plus the
753 with no binding. Every group has a cause.

**The 753 with no binding are expected.** All of them have
`recognition: "reachable"` and `kind: "library"`. They are the
internal helpers the transitive-closure pass picks up, and
`@suss/adapter-typescript` alone contributes 342 of them from
things like `nodeKey` and `locationKey` in `resolve/`. A helper
nothing outside its file calls is not on a boundary, so it has
no package or export path, so `pairSummaries` cannot build a key
for it. The name is what misleads: these do carry a
`function-call` binding, they only lack the package and export
path a pairing key needs. Anyone who wants the number smaller
should change how `pairSummaries` reports, not what the adapter
sees.

**Of the 134 unmatched providers, 23 point at something suss
should be recognizing.**

- **17 are the `default` export of a package the CLI only ever
  loads through a dynamic `import()`.** `loadFramework` reaches
  for `mod.default` and nothing else, so treating one of those
  thunks as a consumer edge would recover the default and no
  more. 39 unmatched providers sit in those nineteen packages;
  the other 22 are named exports, and they are unmatched for the
  ordinary reason below rather than because of the dynamic
  import. `fastifyFramework` and `honoFramework` are two of the
  22: nobody imports them by name, so nothing about dynamic
  `import()` is hiding them.
- **6 are `@suss/ir-core` exports that `@suss/behavioral-ir`
  re-exports**, `graphqlResolverBinding` and `messageBusBinding`
  among them. A consumer's boundary key names the specifier it
  wrote, so it pairs with the barrel's copy of the provider and
  leaves `ir-core`'s original unmatched. Both providers describe
  the same function, and following a re-export back to the
  package that declares it would collapse the pair.

The remaining 111 are ordinary: exports whose only callers live
inside their own package or in tests, which the run does not
scan.

**The 8 unmatched consumers are member calls on a returned or
parsed value**, like `checkAll(...).findings.filter(...)` and
`SuppressionFileSchema.safeParse(...)`. The consumer records the
whole member chain as its export path, and no provider is
published under that key. This is the number
`dogfoodInvariants.mjs` holds a ceiling on, because what bounds
it is how well suss resolves rather than how large this repo is.

## What CI enforces

Two things, and they fail for different reasons.

**The invariants** live in `scripts/dogfoodInvariants.mjs` and
`npm run dogfood` checks them on every run, with no baseline and
no git ref involved:

1. Every function a package declares as a callable export has a
   provider summary. The declared set comes from each manifest's
   `exports` map, read through the TypeScript compiler, so it is
   a second opinion arrived at without suss. The export count in
   the baseline reads the same set from the same place, so the
   count and the invariant cannot disagree about what a package
   exposes.
2. Every summary a pack recognised carries the package and export
   path a pairing key is built from. The transitive closure is
   the exception, since a reachable helper is not on a boundary.
3. No more than eight consumers go unpaired while their provider
   sits in the same run.

These hold whatever the source looks like. Move an export between
packages and both sides still balance. Delete one and there is
nothing left to require. Strip a package back to types and it
asks for nothing at all.

**The counts** live in `scripts/dogfood-baseline.json` and
`npm run check:dogfood` compares a fresh run against the copy
committed in the same tree. They only act as a floor: a number
going up is fine and needs no refresh, and CI on main pushes the
refreshed file back so the floor keeps up with the source.

The counts are there because the invariants cannot see a
recognizer that stops firing at some call sites while still
firing at others. Every declared export still has its summary,
every boundary still has its key, and the only thing that moved
is how much of the closure suss reached. That closure is 785 of
the 987 library summaries, so leaving it unguarded would leave
most of the run unguarded. The internal line is where it shows
up: stop the closure expanding and internal falls to nothing
while every export and every invariant holds.

A refactor moves the internal line too, and that is the reason it
is its own line rather than folded into the export count. Pulling
a helper out of a function raises it, inlining one lowers it, and
a reviewer reading "internal fell, exports held" knows to ask
which of the two happened. When both counts sat in one number
there was nothing to ask.

### What this blocks, and what to do about it

A count going down fails the build. That is the point, and it
means these ordinary changes fail until you do something:

| What you did | What to do |
|---|---|
| Deleted an export or folded two helpers into one | `npm run dogfood`, commit the refreshed baseline |
| Inlined a private helper, or moved one behind a call the closure cannot follow | Same. The internal line drops and the export line holds |
| Moved an export from one package to another | Same. The losing package's line drops and the gaining package's rises, both in the diff |
| Narrowed a recognizer that was over-firing | Same. This is the case worth being careful about, since the diff looks identical to a regression |
| Renamed a package in place | Nothing. Packages are keyed by directory, so the rename reads as one package whose name changed |
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
can see at all, across all 38 packages, and it does fail. Neither
subsumes the other: `check:self` covers two packages in depth
against authored intent, the dogfood run covers the whole
workspace by extent.

## What's still out of scope

- **Dynamic `import()`.** The CLI reaches nineteen packages only
  through `BUILTIN_FRAMEWORKS`, a record of
  `() => import("@suss/framework-…")` thunks. `packageImport`
  walks static named and default imports, so none of those loads
  is a consumer edge.
- **Re-export provenance.** Six `@suss/ir-core` exports are
  re-exported by `@suss/behavioral-ir`. A consumer's boundary key
  names the specifier it imported from, so the barrel's copy of
  the provider pairs and `ir-core`'s original does not.
- **Namespace imports.** `import * as X from "pkg"` is not yet
  tracked on the consumer side.
- **Declarative-data packs.** Framework packs (ts-rest, Express,
  Fastify, React, React Router, Apollo) export a single factory
  that returns a `PatternPack` data structure. Their public API
  is structurally small — one summary per pack, trivially
  bodied. That's correct: a pack is data, not behaviour. The
  38/38 coverage counts them as analysed, not as substantive.

## The in-process API still feels clean

Two discovery variants in one pack, fed into the adapter, out
comes paired provider/consumer summaries — the same properties
the original three-experiment dogfood highlighted. The one
remaining friction: `PatternPack` still requires `languages` /
`terminals` / `inputMapping` even for packs that don't care
about several of them; defaults on the type would reduce the
boilerplate for ad-hoc usage.

## Follow-ups tracked

Not landing in this pass; they go on the backlog:

1. Dynamic `import()` as a consumer-side edge, so a plugin
   registry of import thunks is a dependency suss can see.
2. Following a re-export back to the package that declares the
   function, so a barrel does not hide the original provider.
3. Namespace imports (`import * as X`) and pattern exports
   (`./utils/*`).
4. Defaults on `PatternPack` to reduce scaffolding friction.
