# @suss/adapter-typescript

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

The TypeScript language adapter for suss. It extracts behavioral structure from TypeScript source using ts-morph.

## What this package is

`@suss/adapter-typescript` is the TypeScript language adapter. It walks ASTs with ts-morph and identifies code units such as handlers, loaders, actions and client call sites. It emits `RawCodeStructure` objects, and the extractor assembles those into `BehavioralSummary` IR.

It handles both sides of a boundary. On the provider side it reads handler registration, terminals, contracts and body shapes. On the client side it finds call sites, lifts them to the enclosing function, and tracks which response fields the caller reads through `expectedInput`.

## Where it fits in suss

It imports `@suss/behavioral-ir` for type references and `@suss/extractor` for the `RawCodeStructure` contract. Framework packs and the CLI consume it. In the pipeline it runs one level above the extractor, and feeds it the raw structures it builds from the TypeScript AST.

## Reading a value

Code outside the facility never reads the syntax to find out what a value is. `discovery/resolveValue.ts` is the entry point most callers want. `stringValueOf` folds a template and follows a name to the string it was written as. `objectLiteralOf` and `propertiesOf` read an object through whatever name it arrived under and fold a spread into it. `functionValueOf` and `writtenNodeOf` return the function or the expression a reference comes to. Under those are the `ResolutionStore` in `facts/store.ts` (`resolveWrittenValue`, `resolveObject`, `resolveCallable`, `argumentsPassedTo`, `importedNamesOf`, `importOriginsOf`, `exportsOf`), `resolve/functionBehind.ts`, `walk/unwrap.ts` for casts and parentheses, and `discovery/importScan.ts` for imports. Packs reach all of it through this package's exports. When the facility cannot read a spelling, add the case to the facility. `npm run check:readers` at the repo root fails on a reader written beside a call site instead. [`design/docs-internal/style.md#reading-a-value`](../../../design/docs-internal/style.md#reading-a-value) has the rule.

## How a project is loaded

When a `Project` is constructed, ts-morph parses every file in the tsconfig include glob. On a monorepo that is thousands of files the extraction never touches. The bootstrap avoids that in four steps:

1. Parse the tsconfig for its file list, without any AST work.
2. Read each file concurrently and run `ts.preProcessFile`, a token scan roughly ten times cheaper than a parse.
3. Keep the files whose imports match some active pack's `requiresImport` gate.
4. Add only those to the `Project`.

The closure pass loads the rest as symbol resolution reaches them. It only lazy-loads files the tsconfig already listed, so a run never pulls in `node_modules` content nobody asked for.

### Deep re-export chains

The compiler finds files by recursion. It reads a file, resolves that file's imports, then reads each of those the same way. Give it one file at the top of a long chain and it descends the entire chain in a single pass, so a barrel chain a few hundred modules deep overflows the call stack. A gated run makes that likely, because the bootstrap only loaded the entry file.

Two passes do the compiler's work ahead of it. Both walk the graph iteratively, starting from the far end, so that whenever the compiler asks about a module, the module below it is already resolved.

- **Loading.** Before a run walks any file, the adapter loads that file's import graph bottom up, so nothing is added until everything it imports is already there. It works out the graph by scanning tokens and resolving module paths, and never builds a program to do it. It only loads files the project could already reach, and leaves anything that resolves under `node_modules` for whoever asks for it. All the roots share a single visited set, so a file that several roots reach is read once. On a gated run this pass is also what puts the entry files into the project. The walked-file list is the bootstrap's candidate list, fixed before anything loads, and the load order puts each candidate after everything it imports. The compiler itself depends on that order. The program build processes files in the order they arrived and recurses into imports it has not seen. A chain entered from its top therefore costs stack depth equal to its length, and the same chain entered bottom up costs one frame per file.
- **Alias warming.** Once the graph is loaded, the adapter resolves each file's import bindings and export specifiers from the bottom up, so `export { x } from "./next"` never puts a whole chain on the stack. It only does this for graphs at least `WARM_DEPTH` deep. That number is well below the depth the compiler manages on its own, and well above anything an ordinary barrel file reaches, so it only decides where the time goes. Warming changes the order things resolve in, and never what they resolve to.

If the warmed compiler still cannot follow a chain, the adapter records that and does not throw. A provider whose exports could not be read would otherwise look the same as one that exports nothing. So the adapter notes the file in the extraction report and lets the run finish with the summaries it has.

## Extraction cache

This adapter uses the extraction cache from `@suss/extractor` that every language adapter shares. It supplies the files by reading the tsconfig's include list, and gives the tsconfig path as the config path that guards the entry along with the file list. Each adapter still chooses its own cache directory. This one keeps it beside the tsconfig, at `.suss/cache/`. A caller that supplies a `Project` with no tsconfig gets no cache unless it passes a directory, and `--no-cache` turns it off for one run. Before reusing a cached route, it reads the mount prefixes back out of each cached file's record to confirm the route's mount still resolves the same way. Each file's record also lists the project files it imports, and after an edit that added and removed no file, the import graph loader takes an unchanged file's imports from there instead of resolving them again. The reachable closure keeps what each function body's scan found as a unit record, described in `src/resolve/README.md`. See the extractor package's README for the design.

## Keeping a project between runs

The MCP server reads a project again after every edit, and it keeps one adapter per project rather than building one per run. Before each run it calls `refresh`, which stats every file the project has loaded, compares a file whose stamp moved with the text ts-morph parsed, and parses again only the files whose text changed. A file changed in the two seconds before the stat is compared whatever its stamp says, since a second write in the same clock tick can keep the stamp. The compiler builds the next program from the old one, so every other file keeps its parse and its binding. A run that misses the extraction cache refreshes once more after the cache's lookup, because the cache records the stamps that lookup took.

What was worked out from a changed file goes with it. The load walk forgets the file's imports and the chain depth of every file that reaches it, and every memo made with `createProgramMemo` is emptied, since a memo like that can rest on any file. A result that depends on one file's text alone uses `createPerFileCache`, which expires when that file is parsed again.

A file that joins or leaves the tsconfig's include set can change where an unchanged file's imports resolve, and a tsconfig edit changes the compiler options. In either case the adapter starts over with a new `Project`, and the run costs what a run with a warm disk cache costs.

A run served whole from the cache loads nothing, so `loadProgram` loads the walked files and builds the program ahead of time. The server calls it after a build while nobody is waiting.

## Status

Stable. Public API: `createTypeScriptAdapter` returns an adapter with `extractFromFiles` and `extractAll` methods, and `refresh` and `loadProgram` for a process that keeps it between runs. Provider-side extraction (handlers, terminals, contracts, body shapes) and client-side extraction (call sites, response field tracking) are both supported. See [`docs/theory/extraction-algorithm.md`](../../../docs/theory/extraction-algorithm.md) for the algorithm and [`design/status.md`](../../../design/status.md) for the capability matrix.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../../.github/badges/coverage-typescript.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the canonical design, see [docs/theory/architecture.md](../../../docs/theory/architecture.md).
