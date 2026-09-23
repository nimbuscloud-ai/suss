# @suss/framework-package-exports

The pack for the boundary between packages in one workspace.

A workspace package's public API is whatever its `package.json` makes
reachable, and every import of it from a sibling package uses that
contract. The pack marks both sides:

- one `library` unit per public export, found by resolving the
  package's `exports` / `main` / `types` fields back to source files
- one `caller` unit per function that calls an import from a sibling
  package

Both sides come out as `function-call` bindings with the package name
and export path on them. The checker pairs each caller with the export
it calls, and `suss ask "what calls @scope/pkg"` has an answer.

## Usage

```bash
suss extract -f package-exports -p tsconfig.json
```

The pack needs no configuration. The list of packages comes from the
project, since no library defines it. So the pack's patterns declare
`workspaces: true`, and the adapter reads the workspace manifest and
applies the patterns once for each package it finds. The manifest is
the first `package.json` with a `workspaces` field (npm and yarn, in
array or `{ packages: [...] }` form) or `pnpm-workspace.yaml` at or
above the project root. A glob in the manifest can use literal
segments and `*` within a segment (`packages/*`, `packages/*/*`,
`tools/cli`). Negation patterns are skipped.

On the provider side, suss maps published entry points back to source
by swapping `dist/` for `src/` and `.d.ts` for `.ts`. A package that
builds somewhere else resolves only if its `main` or `exports` already
point at source.

## What v0 leaves out

- Pattern exports (`./utils/*`) and `development` / `require`-only
  conditions on the `exports` field.
- Namespace imports (`import * as X`) on the consumer side.
