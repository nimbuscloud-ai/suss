# @suss/adapter-typescript

TypeScript language adapter for suss. It extracts behavioral structure from TypeScript source using ts-morph.

## What this package is

`@suss/adapter-typescript` is the TypeScript language adapter. It walks ASTs via ts-morph, identifies code units (handlers, loaders, actions, client call sites), and emits `RawCodeStructure` objects that the extractor assembles into `BehavioralSummary` IR.

It supports both provider-side extraction (handler registration, terminal discovery, contract reading, body-shape extraction) and client-side extraction (call-site discovery, enclosing-function lifting, response field tracking via `expectedInput`).

## Where it fits in suss

It imports `@suss/behavioral-ir` for type references and `@suss/extractor` for the `RawCodeStructure` contract. Framework packs and the CLI consume it. It runs one level above the extractor in the pipeline, feeding it raw structures produced from TypeScript AST analysis.

## How a project is loaded

ts-morph parses every file in the tsconfig include glob when a `Project` is constructed, which on a monorepo is thousands of files the extraction never touches. The bootstrap avoids that in four steps:

1. Parse the tsconfig for its file list, without any AST work.
2. Read each file concurrently and run `ts.preProcessFile`, a token scan roughly ten times cheaper than a parse.
3. Keep the files whose imports match some active pack's `requiresImport` gate.
4. Add only those to the `Project`.

The closure pass loads the rest as symbol resolution reaches them. It will only lazy-load files the tsconfig already knew about, so a run never pulls in `node_modules` content nobody asked for.

### Deep re-export chains

The compiler finds files by recursing. It reads a file, resolves that file's imports, then reads each of those the same way. If you hand it one file at the top of a long chain, it will descend the entire chain in a single pass, and a barrel chain a few hundred modules deep will overflow the call stack. A gated run makes that likely, because the bootstrap only loaded the entry file.

Two passes get ahead of the compiler. Both walk the graph iteratively, starting from the far end, so that by the time the compiler asks about any module, the one below it has already been resolved.

- **Loading.** Before a run walks any file, we load that file's import graph bottom up, so nothing is added until everything it imports is already there. We work out the graph by scanning tokens and resolving module paths, never by building a program. We only load files the project could already reach; anything that resolves under `node_modules` we leave for whoever asks for it. All the roots share a single visited set, so a file that several roots reach gets read once instead of once per root. On a gated run this pass is also what puts the entry files into the project: the walked-file list is the bootstrap's candidate list, fixed before anything loads, and the load order puts each candidate after everything it imports. That order matters to the compiler itself. The program build processes files in the order they arrived and recurses into imports it has not seen, so a chain entered from its top costs stack depth equal to its length, while the same chain entered bottom up costs one frame per file.
- **Alias warming.** Once the graph is loaded, we resolve each file's import bindings and export specifiers from the bottom up, so `export { x } from "./next"` never puts a whole chain on the stack. We only do this for graphs at least `WARM_DEPTH` deep. That number is well below the depth the compiler manages on its own, and well above anything an ordinary barrel file reaches, so all it decides is where we spend time. Warming changes the order things resolve in, never what they resolve to.

If the warmed compiler still cannot follow a chain, we record that rather than throwing. A provider whose exports we could not read would otherwise look exactly like one that exports nothing, so we note the file in the extraction report and let the run finish with the summaries it has.

## Status

Stable. Public API: `createTypeScriptAdapter` returns an adapter with `extractFromFiles` and `extractAll` methods. Provider-side extraction (handlers, terminals, contracts, body shapes) and client-side extraction (call sites, response field tracking) are both supported. See [`docs/extraction-algorithm.md`](../../../docs/extraction-algorithm.md) for the algorithm and [`docs/internal/status.md`](../../../docs/internal/status.md) for the capability matrix.

## Coverage

![coverage](../../../.github/badges/coverage-typescript.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the canonical design, see [docs/architecture.md](../../../docs/architecture.md).
