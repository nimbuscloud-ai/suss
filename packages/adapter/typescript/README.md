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

## Extraction cache

A second run over an unchanged repository returns the first run's summaries from disk, and a run after an edit re-extracts only the files the edit can affect. The cache lives in `.suss/cache/` beside the tsconfig, is off for caller-supplied projects, and `--no-cache` skips it for one run. `cache.ts` implements it; this section is the design.

### The key

An entry is only readable by a run that agrees with the one that wrote it on everything that changes what extraction produces. The entry directory's name hashes: the cache schema version, the adapter version plus a content hash of the loaded adapter and analysis bundles, each pack's name, declared version, code hash and config digest, the project files the packs read off disk, the extraction config (`includeReachable`, `gapHandling`), and the tsconfig path.

A pack reads project files no walk ever sees: aws-lambda reads the SAM template that says which handlers exist, and a `packageExports` pattern reads the `package.json` whose `exports` map says which files are on a package's boundary. Editing one of those changes what the run produces while every source file hashes the same, so a pack lists them under `discoveryInputs` and the key takes their paths and their content. Which files they are depends on the files the run walks, so this part of the key is settled per run, after the file list is read and before the lookup. Inside the entry, the tsconfig's own stamp and a stamp per project file guard the rest. A run built from source instead of a bundle has no code hash, and declines to cache at all.

### Whole reuse, then per-file reuse

The fast path compares stats alone: same mtime and size on the tsconfig and every file means the previous summaries come back verbatim, with no parse and no hashing. When stats moved, the run hashes the moved files' content; a touch that changed nothing becomes a hit. When content did change, the per-file layer takes over: the manifest records, for every walked file, which summaries its walk produced (wherever those summaries' functions live), and which other files that walk read. A file whose own hash and whose recorded reads are all unchanged gets its summaries served from the manifest; everything else is re-extracted with the full project loaded, and the results merge.

### What "which other files" means

Cross-file reads are recorded from several directions at once:

- The files the walked file references directly, which covers the types and helpers it imports itself. The whole import closure was measured and rejected: on a repository with import cycles through its app module, one edited controller invalidated a third of the tree.
- Every file the resolution store walked while answering a question asked during the file's walk, hop by hop, which covers re-export chains the store followed and values wired up outside the import graph, an injected class constructed in another file among them.
- The files of every function the reachable closure entered from the file's units, plus one import hop past each, plus what the store answered during those scans.
- Export tables read and aliases resolved through the module-exports helpers, wherever the resolution landed.
- The file that claimed a unit this file's walk would otherwise have claimed, since the claim decided what this file's output leaves out.
- The mount prefixes the walk consumed, re-checked by id against the rebuilt index on every partial run, so a mount added or changed in a file the router never imports still invalidates its routes.
- The packs that applied to the file, re-checked against the fresh gate on every partial run, so a barrel that starts re-exporting a framework flips the file back to walked.

A file declines caching when one of its summaries takes part in a run-level GraphQL join: it has a document label (schema lifting moves SDL between summaries sharing one) or it is an operation (client stamping writes the project-wide sole client onto every one). A code-first resolver joins with nothing and stays cacheable. Summaries built by run-level passes (wrapper-caller expansion, library env-read markers, schema documents) belong to no file and are recomputed on every partial run. Units the cache serves are excluded from closure emission the way a cold run's seeds are, so a re-walked file reaching a cached unit never duplicates it.

### What stage one does not promise

A type read more than one import hop away, through a chain no recorded mechanism followed, can change a summary's printed types without invalidating it. The middle file of a deep re-export chain has the same hole when the compiler, not the store, resolved the chain. A dependency upgrade under `node_modules` invalidates nothing (the pack and adapter hashes account for library knowledge instead). Recording what each answer read, per answer, is stage two of #422 and closes these.

A re-extracted summary can also differ from a cache-free run in one representational way: type-shape expansion shares a per-run memo, so a run that walks five files can expand a shape to a different depth than a run that walks a thousand, and the shape digest moves with it. The summary was computed fresh either way; nothing served is stale.

### Invalidation, wholesale

The schema version is part of the entry directory's name, so a format change makes every old entry unreachable rather than misread, and the eviction pass deletes it in time. `MAX_ENTRIES` bounds a cache directory at two entries.

## Status

Stable. Public API: `createTypeScriptAdapter` returns an adapter with `extractFromFiles` and `extractAll` methods. Provider-side extraction (handlers, terminals, contracts, body shapes) and client-side extraction (call sites, response field tracking) are both supported. See [`docs/extraction-algorithm.md`](../../../docs/extraction-algorithm.md) for the algorithm and [`design/status.md`](../../../design/status.md) for the capability matrix.

## Coverage

![coverage](../../../.github/badges/coverage-typescript.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the canonical design, see [docs/architecture.md](../../../docs/architecture.md).
