# bootstrap/

Bootstrap sets up the ts-morph `Project` lazily and decides which files get parsed. It also gives later passes an O(1) lookup for finding a source file by path or path suffix.

## Place in the pipeline

Bootstrap runs once at the start of an extraction. Before discovery dispatches, the cache layer checks whether a previous extraction's manifest can serve the run. If it can't, bootstrap creates the `Project`, uses each pack's `requiresImport` gate to work out which files are candidates for it, and pre-parses the candidates. Discovery then runs against those parsed files. Later passes, such as the reachable closure and rethrow enrichment, add more files on demand through `lazyAddSourceFile` and find them again through the source-file lookup.

## Key files

- `lazyProjectInit.ts:createLazyProject` builds the `Project`, plus the `projectFileSet` that the closure pass uses to tell files "in" the project from files in node_modules.
- `lazyProjectInit.ts:lazyAddSourceFile` adds a file on demand. It always calls `addSourceFileAtPath`, even when `getSourceFile` succeeds, because type-checker symbol resolution can surface files that `project.getSourceFiles()` does not list until they are added again.
- `bootstrap/preFilter.ts:computePackApplicability` is the per-file dispatch gate, based on import declarations. `requiresImport: []` means "ungated", so every file qualifies. Sub-path imports match by prefix.
- `bootstrap/sourceFileLookup.ts:createSourceFileLookup` provides exact-path and `bySuffix` lookup. The suffix lookup scans the cached file list, so its cost grows with the number of files and not with tree depth.

## Gotchas

- **Order matters.** The cache layer reads the tsconfig file list (via `readTsconfigFileList`, which doesn't parse) BEFORE pack applicability runs, and that list feeds the cache key. Bootstrap builds the `Project` only AFTER the cache check decides an extraction is needed.
- **`requiresImport: []` vs. `undefined`.** Both mean "ungated". The empty array is the explicit form: the pack author considered the gate and chose every file. Recognizer-only packs without discovery patterns rely on this. Without a gate they walk every file, which gives the right result but is slow on large monorepos.
- **`lazyAddSourceFile` is idempotent and adds the file again.** ts-morph's `getSourceFile` returns the parsed file if it is present, but the type checker can refer to symbols in files that the current `Project` view does not include. Calling `addSourceFileAtPath` again is safe, and it makes sure the file is available for symbol resolution during closure walks.
- **`bySuffix` lookup is O(N) in file count.** That cost is acceptable for the rethrow-enrichment pass, which runs once per summary over a file count the project bounds. For lookups that run more often, use the exact path.

## Sibling modules

- `discovery/` consumes the loaded files and the per-pack applicability map.
- `resolve/reachableClosure.ts` calls `lazyAddSourceFile` to load callees that the discovery pass didn't pre-parse.
- `resolve/rethrowEnrichment.ts` uses `createSourceFileLookup` to locate summaries by their file path.
