# @suss/behavioral-ir

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Core type definitions and utilities for the suss behavioral intermediate representation.

## What this package is

`@suss/behavioral-ir` defines the types the rest of suss shares. It contains the `BehavioralSummary` interface, which is the canonical output of the extraction pipeline, along with the supporting types such as `Transition`, `Predicate`, `Input`, `Output`, `Effect` and `TypeShape`. It also provides `diffSummaries`, the only runtime utility in this package.

Every other suss package either consumes these types or produces values that conform to them. This package does not depend on any other suss package.

## Where it fits in suss

`@suss/behavioral-ir` has zero dependencies, and every other package builds on it. `@suss/extractor`, `@suss/adapter-typescript`, all framework packs, and the CLI depend on it. It never imports from its suss siblings.

## Status

Stable. The IR types and `diffSummaries` are the public API. The format is also published as a [JSON Schema](schema/behavioral-summary.schema.json) and a [spec document](../../docs/reference/summary-format.md), so consumers in any language can validate and interpret summaries without a runtime dependency on this package.

## Minimal usage

```ts
import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";

function firstTransition(summary: BehavioralSummary): Transition | undefined {
  return summary.transitions[0];
}
```

## Reading and writing summary files

`@suss/behavioral-ir/files` has the reader and writer every suss command uses. It needs Node's file system, so it is a separate entry point.

```ts
import { readSummaryFile, writeSummaryFile } from "@suss/behavioral-ir/files";

const summaries = readSummaryFile(".suss/code.json");
writeSummaryFile(".suss/copy.json", summaries);
```

`writeSummaryFile` writes one summary per line with no indentation, to a temporary file that it renames over the target once the write is complete. `readSummaryFile` reads that layout a line at a time, so a file larger than one JavaScript string (about 512 MB) still reads, and it validates each summary as it goes. It also reads an indented file small enough to fit in one string. Either way the result equals what `parseSummaries` returns for the same JSON. A file that cannot be read throws a `JsonFileError`, whose `problem` says whether the file was missing, was not JSON, was too large to read whole, or was not summaries. `readJsonFile` and `writeDocumentFile` do the same for any JSON document, without the summary schema. `documentPieces` gives the text of that layout piece by piece, and `writeFileAtomically` writes pieces through the same temporary file, for a caller that hashes the text before it decides where the file goes. The extraction cache writes its manifest, its index and its shards through them.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../.github/badges/coverage-ir.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the canonical design, see [docs/theory/architecture.md](../../docs/theory/architecture.md).
