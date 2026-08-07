# @suss/adapter-python

Python language adapter for suss. It parses source with tree-sitter (WASM), resolves names with its own lexical binder, and emits behavioral structure through the same shared assembly layer the TypeScript adapter uses.

## What this package is

`@suss/adapter-python` is the Python language adapter, per [`docs/internal/facts-and-rules.md`](../../../docs/internal/facts-and-rules.md)'s Layer 1 contract: discover units, emit summaries in the shared IR, emit facts. It parses a file with `web-tree-sitter` and a vendored Python grammar (`grammar/tree-sitter-python.wasm`, no native build step), builds module/class/function scopes over the tree (imports, assignments, `global`/`nonlocal`), resolves an import to the repo file it names, and discovers routes from decorated functions and class methods whose decorator resolves to a pack-configured module. When a pack declares router mounting (FastAPI's `APIRouter` plus `include_router`), the adapter composes a route's path from the two literal prefixes, one mount hop deep, and a route it cannot compose keeps its name with no path and a gap saying why. Discovered units become `RawCodeStructure` objects handed to `@suss/extractor`'s `assembleSummary`, the same assembly code the TypeScript adapter uses.

v0 (this slice) does no path-engine work: a route's transitions are empty, or one transition describing a declared response shape (a FastAPI `response_model` / `status_code`, or a return annotation), never a decomposed branch. See [`docs/internal/proposals/language-adapters.md`](../../../docs/internal/proposals/language-adapters.md) for what a later slice adds.

## Where it sits in suss

Depends on `@suss/extractor` (for `RawCodeStructure` / `assembleSummary`), `@suss/behavioral-ir`, `@suss/datalog` (for the fact database), and `web-tree-sitter`. Framework packs under `packages/framework/*` (`@suss/framework-flask-restx`, `@suss/framework-fastapi`) consume its `PythonPack` contract; nothing in this package knows what any particular library's decorators are named.

## Grammar asset

`grammar/tree-sitter-python.wasm` is a checked-in binary asset, not a build output. See [`grammar/README.md`](./grammar/README.md) for its provenance and how to bump it.

## Coverage

![coverage](../../../.github/badges/coverage-python.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
