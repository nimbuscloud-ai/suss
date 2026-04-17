# @suss/cli

Command-line interface for suss. Wraps the extraction pipeline, the human-readable inspector, and the cross-boundary checker.

## What this package is

`@suss/cli` is the user-facing entry point. It dynamically imports the language adapter and pattern packs so CLI startup doesn't pay the ts-morph cost unless extraction actually runs.

### Commands

```sh
# Extract behavioral summaries from a TypeScript project
suss extract -p tsconfig.json -f ts-rest [-f express] [-o summaries.json]

# Render a single summaries file as human-readable text
suss inspect summaries.json

# Show what changed between two summary files
suss inspect --diff before.json after.json

# Overview of every provider/consumer pair in a directory of summaries
suss inspect --dir summaries/

# Pairwise check: compare one provider against one consumer
suss check provider.json consumer.json [--json] [-o findings.json]

# Directory check: auto-pair providers with consumers by (method, path)
suss check --dir summaries/ [--json] [-o findings.json] [--fail-on warning]

# Generate summaries from a declared contract (no source extraction)
suss stub --from openapi spec.yaml [-o provider.json]
```

### Options

**`extract`**
- `-p, --project` — path to `tsconfig.json` (required)
- `-f, --framework` — pattern pack name (repeatable)
- `-o, --output` — write JSON to file instead of stdout
- `--files` — limit extraction to specific source files
- `--gaps` — gap handling: `strict` (default), `permissive`, or `silent`

**`check`**
- `--dir` — directory of summary JSON files; auto-pairs by `(method, normalizedPath)`
- `--json` — emit findings as JSON
- `-o, --output` — write findings to file instead of stdout
- `--fail-on` — exit-code threshold: `error` (default), `warning`, `info`, or `none`

**`stub`**
- `--from` — stub source kind (today: `openapi`)
- `-o, --output` — write JSON to file instead of stdout
- Positional argument: path to the spec file

### Built-in framework resolution

Pass `-f <name>` to select a pattern pack. Built-in names: `ts-rest`, `react-router`, `express`, `fastify`, `fetch`, `axios`. Custom packs are resolved via `@suss/framework-<name>` dynamic import.

### Exit codes

`suss check` exits non-zero when findings meet the `--fail-on` threshold (default: any error-severity finding). Useful for CI gating.

## Where it sits in suss

Depends on everything: `@suss/behavioral-ir`, `@suss/extractor`, `@suss/adapter-typescript`, `@suss/checker`, and all framework/runtime packs. This is the only package that ties the full stack together.

## Coverage

![coverage](../../.github/badges/coverage-cli.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the summary format the CLI reads and writes, see [`docs/behavioral-summary-format.md`](../../docs/behavioral-summary-format.md).
