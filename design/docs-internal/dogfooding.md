# Dogfooding: suss on suss

We run suss against its own source to see what a user sees. The question is the one a user starts with: "I have a TypeScript codebase and I want summaries. What happens?"

Below is what worked, what didn't, and what the run shows about the pack interface. The script that reproduces it is [`scripts/dogfood.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/dogfood.mjs). Run it with `node scripts/dogfood.mjs` after `npm run build`.

## Setup

The script goes through every `@suss/*` package and runs the adapter twice on each:

- **`packageExports`** produces `library`-kind provider summaries for the package's public API. It starts from the `package.json` entry points and follows barrel re-exports through `ts-morph`.
- **`packageImport`** produces `caller`-kind consumer summaries for every function in the package that calls into another `@suss/*` package.

Both sides are written to `<pkg>/.suss/suss-summaries.json`, in the format that the "Publishing summaries" section of `docs/reference/summary-format.md` proposes. A package that wants to publish its contract writes that file into `dist/` next to its build. This run only analyses the repo locally, so the file goes next to the extraction cache instead, where git and npm already ignore it. The combined report (`scripts/dogfood-report.json`) has a `pairing` section. We run `pairSummaries` over the union of all packages and record every matched provider↔consumer edge under `fn:<package>::<exportPath>`.

## What the run produces

The current counts are in `scripts/dogfood-baseline.json`: export, internal and consumer summaries per package and in total, the number of cross-package edges paired, and the calls the walk could not follow. `scripts/dogfood.mjs` writes that file, we commit it, and CI runs the script on every push. [What CI enforces](#what-ci-enforces) explains what happens when a number moves. The script also prints the most consumed exports, which is the quickest way to see which packages the rest of the monorepo depends on most.

We count library summaries on two lines because the two change for different reasons.

The export summaries describe what the packages promise their callers. Each one has a package and an export path, and we build a pairing key from those. The path is either one a manifest declares or a method you reach through one. This number only changes when a package's public surface changes.

The internal summaries come from the transitive-closure pass. Every helper that a recognised entry point reaches through a static call chain gets its own summary, marked `recognition: "reachable"`. A helper found this way is inside a package, away from its edge, so it has no export path and cannot pair. `pairSummaries` reports every one of them under `unmatched.noBinding`. This number changes when extraction changes, and also when someone adds or removes a private helper.

When both were one number, each hid changes in the other. `@suss/cli` declares ten exports. Adding one module with five module-private helpers moved the old provider count from 70 to 75. That looked like the package's API growing, but no caller could reach any of the five.

Every edge pairs two behaviours. The provider summary describes what the called function does, branch by branch, with its conditions and outputs. The consumer summary describes what the enclosing function does around the call. The checker's existing pairing code does the matching. We added no new pairing rule, only a new `boundaryKey` branch for `function-call` semantics that uses `package` and `exportPath`.

## What the output looks like

### Library provider

`@suss/checker::predicatesMatch` is a typical mid-sized example. It is a 4-branch dispatch that returns a string literal from each branch:

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

The header means "package `@suss/checker`, export `predicatesMatch`". The provenance line says the `package-exports:@suss/checker` pack produced a `library`-kind unit that starts at `predicates.ts:12`. Each branch shows the predicate that decides it and the literal value that path returns. None of the conditions are opaque.

### Consumer (caller)

`checkDir` in `@suss/cli` consumes `@suss/checker::checkAll`:

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

The header is written as `caller → target`. `checkDir` is the enclosing function that contains the call, and `@suss/checker::checkAll` is what it consumes. Its own decision tree has three branches: two throws that validate the input, and a return on the success path with the record we expect.

### Pairing

When you run the checker over the union of all summaries, that consumer summary pairs with the provider summary for `@suss/checker::checkAll` through the key `fn:@suss/checker::checkAll`. The REST checker has paired HTTP boundaries with the same code from the start. The only difference is that this key comes from `function-call` semantics instead of from `method + path`.

For the full guide to reading the output (header formats, how branches render, gap annotations), see [CLI reference: Reading the output](/reference/cli#reading-the-output).

## What this exercises

- **`packageExports` discovery** resolves the `types`, `default` and `import` conditions on `exports`. When `exports` isn't set it falls back to `types`, `main` and `module`. It rewrites `dist/*.d.ts` → `src/*.ts` and follows barrel re-exports.
- **`packageImport` discovery** walks the named and default imports from the packages it targets, records call expressions on a bare identifier, and deduplicates by (enclosing function × consumed binding).
- **The `library` and `caller` `CodeUnitKind`s** are the provider side and the consumer side of the in-process `function-call` boundary. Both fit into `BOUNDARY_ROLE` correctly.
- **Per-package contracts**: the generated `.suss/suss-summaries.json` files now contain both sides together. Anyone who consumes a published package can run `suss check` with their own summaries against the contract it ships.

## Where the unmatched summaries come from

The run leaves some providers and consumers unpaired, plus a large group with no binding. Each group has a known cause.

**The 753 with no binding are expected.** All of them have `recognition: "reachable"` and `kind: "library"`. They are the internal helpers the transitive-closure pass picks up, and `@suss/adapter-typescript` alone contributes 342 of them, from functions like `nodeKey` and `locationKey` in `resolve/`. A helper that nothing outside its file calls is not on a boundary. It has no package or export path, so `pairSummaries` cannot build a key for it. The name of the group is misleading. These summaries do have a `function-call` binding, and they only lack the package and export path a pairing key needs. If you want the number smaller, change how `pairSummaries` reports it. The adapter is seeing the right thing.

**Of the 154 unmatched providers, 23 point at something suss should be recognizing.**

- **17 are the `default` export of a package that the CLI only loads through a dynamic `import()`.** `loadFramework` only reads `mod.default`, so treating one of those thunks as a consumer edge would recover the default and nothing else. Those nineteen packages have 39 unmatched providers between them. The other 22 are named exports, and they are unmatched for the ordinary reason described below. The dynamic import is not the cause. `fastifyFramework` and `honoFramework` are two of the 22: nobody imports them by name, so the dynamic `import()` is not what hides them.
- **6 are `@suss/ir-core` exports that `@suss/behavioral-ir` re-exports**, including `graphqlResolverBinding` and `messageBusBinding`. A consumer's boundary key uses the specifier the consumer wrote. So it pairs with the barrel's copy of the provider and leaves the original in `ir-core` unmatched. Both providers describe the same function. Following a re-export back to the package that declares it would merge them into one.

The remaining 131 are ordinary. They are exports whose only callers are inside their own package or in tests, and the run does not scan those. Twenty of them are methods that `factorySurface` now finds on a builder function in the same file, such as `storageCalls` and `sqlStatements` in `@suss/recognize`, plus a few discovery-context factories in the TypeScript adapter. Each of those methods exists and would pair if something called it, but today nothing outside its package does.

**The 12 unmatched consumers call a method that only exists on a value's declared return type.**

- `SuppressionFileSchema.safeParse(...)` and `IntentDocSchema.safeParse(...)` both call a method zod puts on every schema object. The method comes from the imported `ZodType` type. Nothing in the schema's own file builds it.
- `evaluate(...).facts(relation)`, in `@suss/resolution`'s tests, calls a method that `@suss/datalog`'s `Database` class declares. `evaluate` returns the `Database` instance its caller passed in and does not build one. So when suss traces the value back, it arrives at a function parameter. To find the method it would need to arrive at an object literal that a factory built.
- `callerLiteralReads` and `forwardedParameter` in `@suss/runtime-node` each call `findEnclosingFunction(node).getParameters()`. `findEnclosingFunction` returns whichever function-like ancestor it reached, and `getParameters` is a method ts-morph declares on that node's type. The adapter's own code does not build it.
- `forwardedParameter` also calls `symbolBehind(reference)?.getValueDeclaration()`, and so does `directEnvRead`, since it stopped matching a parameter by its spelling and started comparing declarations. This is the same pattern one call further in. `symbolBehind` returns a ts-morph symbol, and `getValueDeclaration` is a method on that symbol.
- The remaining six are the same thing in three more packs. `propertyOf(...).getText()` and `propertyValueOf(...).getText()` are in `@suss/contract-storybook`. `writtenNodeOf(...).getExpression()`, `writtenNodeOf(...).getArguments()` and `arrayLiteralOf(...).getElements()` are in `@suss/framework-drizzle`. `climbSyntax(...).getParent()` is in `@suss/framework-aws-sqs`, and it appeared when that pack stopped climbing past casts and parentheses by itself.

To find the method, every one of these needs suss to read a declared or inferred type. `factorySurface` does not do that. It reads what a function's own body returns and never asks the type checker what that return value is. The count goes up each time another pack drops its own reader and calls the adapter's resolvers instead, since every one of those resolvers returns a ts-morph node.

The `returnsClass` fact does not help with any of them. An adapter emits it only for a function whose body returns no value of its own, and every function above does return something. `evaluate` returns the database it was given, and the rest return a node they walked to. For those functions the adapter never reads the annotation.

A method the language declares on every value used to show up here too, and those entries were noise. `readSqlAccess(...).map(...)` asked for `@suss/sql::readSqlAccess.map`, and the count went up by one for every pack that called a shared reader. Now a call through a method declared in TypeScript's own lib files produces no consumer at all. When the value under it came from a call, suss records that call separately. When the value is an exported constant, as in `ROOT_CLASS_NAMES.join(", ")`, nothing in the package was called. A method that somebody declared still goes through, and that keeps `client.send(...)` on an SDK client working. The first half of that change took the count from eleven to seven. The second took it from twenty to twelve without changing the pairs.

## What CI enforces

CI checks two things, and they fail for different reasons.

**The invariants** are in `scripts/dogfoodInvariants.mjs`, and `npm run dogfood` checks them on every run. They use no baseline and no git ref:

1. Every function a package declares as a callable export has a provider summary. The declared set comes from each manifest's `exports` map, read through the TypeScript compiler, so it is a second opinion that nothing in suss produced. The export count in the baseline reads the same set from the same place, so the count and the invariant always agree on what a package exposes.
2. Every summary a pack recognised has the package and export path we build a pairing key from. The transitive closure is the exception, since a helper it reached is not on a boundary.
3. No more than three consumers go unpaired while their provider is in the same run.

These stay true however the source changes. Move an export between packages and both sides still balance. Delete one and there is nothing left to require. Strip a package back to types and it requires nothing at all.

**The counts** are in `scripts/dogfood-baseline.json`, and `npm run check:dogfood` compares a fresh run against the copy committed in the same tree. They only act as a floor. A number going up is fine and needs no refresh, and CI on main pushes the refreshed file back so the floor keeps up with the source.

We keep the counts because the invariants cannot see a recognizer that stops firing at some call sites and keeps firing at others. Every declared export still has its summary and every boundary still has its key. The only thing that changed is how much of the closure suss reached. The closure makes up most of the library summaries (the internal line in the baseline is several times the export line), so without a guard on it, most of the run would have no guard. The internal line is where such a change shows up. If the closure stops expanding, the internal count drops to nothing while every export and every invariant still passes.

A refactor moves the internal line too, which is why it is its own line and not part of the export count. Pulling a helper out of a function raises it, and inlining one lowers it. A reviewer who reads "internal fell, exports held" knows to ask which of the two happened. When both counts were one number, there was nothing to ask.

`unfollowedCalls` is the one count that runs the other way. It counts the calls the closure met and could not resolve, so it measures what suss could not see. `check:dogfood` fails when it rises, not when it drops. Better resolution brings it down. New code that reaches something through indirection pushes it up, and the same baseline refresh records that. The classifier that decides which unfollowed calls are counted and which are background noise is documented in `packages/adapter/typescript/src/resolve/README.md`.

### What this blocks, and what to do about it

A count going down fails the build. We want that, and it means the ordinary changes below fail until you act on them:

| What you did | What to do |
|---|---|
| Deleted an export or folded two helpers into one | `npm run dogfood`, commit the refreshed baseline |
| Inlined a private helper, or moved one behind a call the closure cannot follow | Same. The internal line drops and the export line stays put |
| Moved an export from one package to another | Same. The losing package's line drops and the gaining package's rises, and you see both in the diff |
| Narrowed a recognizer that was over-firing | Same. Be careful with this case, since the diff looks identical to a regression |
| Renamed a package in place | Nothing. Packages are keyed by directory, so the rename looks like one package whose name changed |
| Moved a package to a different directory | `npm run dogfood`, commit. The old path leaves the baseline and the new one enters it |
| Added code that calls a method on an interface nothing wires up | Same, and this one raises `unfollowedCalls` instead of lowering a count. Check the new gaps look the way you expect before you commit the refresh |

The refreshed baseline shows up in the pull request diff as a per-package change against main, and that is where a reviewer reads it. A drop nobody can explain is the warning sign. Nothing else can lower a committed number, and no bot refreshes the file on a pull request branch, so a drop cannot get through without someone seeing it.

### Its relationship to `check:self`

`scripts/checkSelf.mjs` is the other place suss runs on itself, and the two check different things. `check:self` extracts the public exports of the two checker packages and runs the CLI's `check` against the intent specs under `intent/`, to see whether those exports still behave the way the specs say. It reports and never fails. The dogfood run measures how much of its own source suss can see at all, across every package in this repo, and it does fail. You need both. `check:self` goes deep on two packages against intent someone wrote by hand, and the dogfood run covers the whole workspace in breadth.

## What's still out of scope

- **Dynamic `import()`.** The CLI reaches nineteen packages only through `BUILTIN_FRAMEWORKS`, a record of `() => import("@suss/framework-…")` thunks. `packageImport` walks static named and default imports, so none of those loads becomes a consumer edge.
- **Re-export provenance.** `@suss/behavioral-ir` re-exports six `@suss/ir-core` exports. A consumer's boundary key uses the specifier it imported from, so the barrel's copy of the provider pairs and the original in `ir-core` does not.
- **Namespace imports.** We don't track `import * as X from "pkg"` on the consumer side yet.
- **Declarative-data packs.** The framework packs (ts-rest, Express, Fastify, React, React Router, Apollo) each export a single factory that returns a `PatternPack` data structure. Their public API is small by design: one summary per pack, each with a minimal body. That is correct, because a pack is data and has little behaviour. The package count in the baseline counts them as analysed, not as substantive.

## The in-process API holds up

You feed two discovery variants from one pack into the adapter, and paired provider and consumer summaries come out. The original three-experiment dogfood showed the same thing. One friction is left. `PatternPack` still requires `languages`, `terminals` and `inputMapping`, even for a pack that doesn't use several of them. Defaults on the type would cut that boilerplate for one-off use.

## Follow-ups tracked

These are on the backlog and not part of this work:

1. Treat a dynamic `import()` as a consumer-side edge, so that suss can see a plugin registry of import thunks as a dependency.
2. Follow a re-export back to the package that declares the function, so a barrel does not hide the original provider.
3. Namespace imports (`import * as X`) and pattern exports (`./utils/*`).
4. Defaults on `PatternPack` to reduce scaffolding friction.
