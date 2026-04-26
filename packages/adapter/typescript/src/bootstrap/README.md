# bootstrap/

Sets up the ts-morph `Project` lazily, gates which files get parsed, and provides O(1) lookup for later passes that need to find a source file by path or path suffix.

## Place in the pipeline

Runs once at the start of an extraction. Before discovery dispatches, the cache layer checks whether the run can be served from a previous extraction's manifest. If not, bootstrap creates the `Project`, computes which files are candidates for each pack via `requiresImport` gates, and pre-parses the candidates. Discovery then runs against those parsed files; later passes (reachable-closure, rethrow enrichment) lazy-add additional files via `lazyAddSourceFile` and find them again via the source-file lookup.

## Key files

- `lazyProjectInit.ts:createLazyProject` — builds the `Project` and the `projectFileSet` the closure pass needs to know what's "in" the project vs. node_modules.
- `lazyProjectInit.ts:lazyAddSourceFile` — on-demand file addition. Always calls `addSourceFileAtPath` even when `getSourceFile` succeeds, because type-checker symbol resolution surfaces files that aren't in `project.getSourceFiles()` until you re-add them.
- `bootstrap/preFilter.ts:computePackApplicability` — per-file dispatch gate based on import declarations. `requiresImport: []` means "ungated" (every file). Sub-path imports match by prefix.
- `bootstrap/sourceFileLookup.ts:createSourceFileLookup` — exact-path and `bySuffix` lookup. The suffix path scans the cached file list (linear in file count, not tree depth).

## Non-obvious things

- **Order matters.** The cache layer reads the tsconfig file list (via `readTsconfigFileList`, which doesn't parse) BEFORE pack applicability runs. That feeds the cache key. Bootstrap's `Project` construction happens AFTER the cache check decides extraction is needed.
- **`requiresImport: []` vs. `undefined`.** Both mean "ungated," but the empty array is the explicit "I considered this and decided every file" signal. Recognizer-only packs without discovery patterns rely on this — without a gate they walk every file, which is correct but slow on large monorepos.
- **`lazyAddSourceFile` is idempotent and re-adds.** ts-morph's `getSourceFile` returns the parsed file if present, but the type checker can hold references to symbols in files that aren't in the current `Project` view. Re-calling `addSourceFileAtPath` is safe and ensures the file's available for symbol resolution during closure walks.
- **`bySuffix` lookup is O(N) in file count.** For the rethrow-enrichment pass, that's fine — it runs once per summary and the file count is bounded by the project. For higher-frequency lookups, prefer exact-path.

## Sibling modules

- `discovery/` consumes the loaded files and the per-pack applicability map.
- `resolve/reachableClosure.ts` calls `lazyAddSourceFile` to bring in callees that the discovery pass didn't pre-parse.
- `resolve/rethrowEnrichment.ts` uses `createSourceFileLookup` to locate summaries by their file path.
