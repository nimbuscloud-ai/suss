# @suss/framework-package-exports

The PatternPack for the boundary between packages in one workspace.

A workspace package's public API is whatever its `package.json` makes
reachable, and every import of it from a sibling package is a use of
that contract. The pack marks both sides:

- one `library` unit per public export, from resolving the package's
  `exports` / `main` / `types` fields back to source files
- one `caller` unit per function that calls an import of a sibling
  package

Both sides come out as `function-call` bindings with the package name
and export path on them, so the checker pairs a caller against the
export it calls, and `suss ask "what calls @scope/pkg"` has an answer.

## Usage

```bash
suss extract -f package-exports -p tsconfig.json
```

The pack needs no configuration. Which packages exist belongs to the
project, not to any library, so the pack's patterns say
`workspaces: true` and the adapter reads the workspace manifest and
applies them once per package it finds. The manifest is the first
`package.json` with a `workspaces` field (npm and yarn, array or
`{ packages: [...] }` form) or `pnpm-workspace.yaml` at or above the
project root. Globs in the manifest support literal segments and `*`
within a segment (`packages/*`, `packages/*/*`, `tools/cli`);
negation patterns are skipped.

The provider side resolves published entry points back to source with
the `dist/` to `src/` and `.d.ts` to `.ts` convention. A package that
builds elsewhere resolves only if its `main` or `exports` already
point at source.

## What v0 leaves out

- Pattern exports (`./utils/*`) and `development` / `require`-only
  conditions on the `exports` field.
- Namespace imports (`import * as X`) on the consumer side.
