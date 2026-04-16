# @suss/cli

Command-line interface for suss. Wraps the extraction pipeline and checker into three commands: `extract`, `inspect`, and `check`.

## What this package is

`@suss/cli` is the user-facing entry point. It dynamically imports the adapter and framework packs so CLI startup doesn't pay the ts-morph cost unless extraction actually runs.

### Commands

```
suss extract -p tsconfig.json -f ts-rest [-f express] [-o summaries.json]
suss inspect summaries.json
suss check provider.json consumer.json [--json] [-o findings.json]
suss check --dir summaries/ [--json] [-o findings.json]
```

- **`extract`** discovers code units, runs the extraction pipeline, and outputs `BehavioralSummary[]` as JSON.
- **`inspect`** renders summaries as human-readable text.
- **`check`** (pairwise) runs the cross-boundary checker on explicit provider/consumer files.
- **`check --dir`** reads all JSON files from a directory, automatically pairs providers with consumers by `(method, normalizedPath)`, and checks each pair. Reports unmatched summaries.

### Built-in framework resolution

Pass `-f <name>` to select a framework. Built-in names: `ts-rest`, `react-router`, `express`, `fetch`. Custom packs are resolved via `@suss/framework-<name>` dynamic import.

## Where it sits in suss

Depends on everything: `@suss/behavioral-ir`, `@suss/extractor`, `@suss/adapter-typescript`, `@suss/checker`, and all framework/runtime packs. This is the only package that ties the full stack together.

## Coverage

![coverage](../../.github/badges/coverage-cli.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).
