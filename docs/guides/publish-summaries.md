---
title: Publish summaries
description: Write your service's summaries to a file, commit it, and let another repo check its own code against them without reading your source.
---

# Publish summaries

Write the summaries to a file with `-o` and commit it. Another repo reads that file and checks its own code against it, with no access to yours.

```bash
npx suss extract -p tsconfig.json -f hono -o suss/catalog.json
git add suss/catalog.json
```

The file travels because `extract` writes every path in it relative to the package root, and nothing else in it depends on the machine that wrote it:

```json
{
  "kind": "handler",
  "location": {
    "file": "src/api.ts",
    "range": { "start": 5, "end": 13 },
    "exportName": "get",
    "workspace": "catalog-api"
  },
  "confidence": { "source": "inferred_static", "level": "high" },
  "schemaVersion": 6
}
```

Regenerate it in CI on every change to the service, the same way a generated client or an OpenAPI document is regenerated, so the committed file and the code never drift.

## How a downstream repo reads it

Drop the file in the folder it runs `check --dir` over, beside its own extract output:

```bash
cp node_modules/@acme/catalog/suss/catalog.json summaries/
npx suss extract -p tsconfig.json -f fetch -o summaries/web.json
npx suss check --dir summaries/
```

`check --dir` pairs by boundary, so it does not matter which run wrote which file, or whether the two sides were extracted from the same repository, the same language, or the same day. Naming both files does the same for one pair:

```bash
npx suss check node_modules/@acme/catalog/suss/catalog.json summaries/web.json
```

[Work across services](/guides/work-across-services) has the two-repo flow end to end, with what a finding looks like when the two sides disagree.

## What the file guarantees

Every summary is stamped with a `schemaVersion`, and the parsers in `@suss/behavioral-ir` read every version ever published. A file written by an older suss does not need rewriting, and a newer reader upgrades it as it parses. Version 6 is current; [Summary format](/reference/summary-format) lists what each version changed and documents every field.

Two ways to consume the JSON:

- **TypeScript or JavaScript:** install `@suss/behavioral-ir` and call `parseSummaries(json)`, which validates and narrows in one step. The types come from the same schemas.
- **Anything else:** validate against the JSON Schema the build generates from those schemas, at `packages/behavioral-ir/schema/behavioral-summary.schema.json`.

Transition ids are deterministic per branch, built from the function name, the terminal kind, the status and a hash of the conditions, so two files from two points in time diff against each other. `suss inspect --diff before.json after.json` reports what moved between them.

## A library with no framework in it

A package whose public API is plain functions has a boundary too: everything its `exports` makes reachable. The `package-exports` pack reads that side without a list of exports from you.

```bash
npx suss extract -p tsconfig.json -f package-exports -o suss/summaries.json
```

```
packages/ledger/src/index.ts
├─ @acme/ledger::postEntry  (package-exports library | line 6)
│      if  entry.total < 0
│        -> throw RangeError
│      else
│        -> return { accepted }
│
└─ @acme/ledger::voidEntry  (package-exports library | line 14)
       if  id === ""
         -> return null
       else
         -> return { voided }
```

The same run reads the other side, one summary per function that imports one of those exports, so a monorepo checks its own packages against each other:

```
packages/app/src/checkout.ts
└─ checkout → @acme/ledger::postEntry  (package-exports caller | line 3)
       -> return
         + packages/ledger/src/index.postEntry →
```

Both sides come from the workspace manifest, so the caller side is discovered for a sibling package in the same workspace and not for a dependency under `node_modules`. Publishing the provider side of a library and pairing it from a separate repository does not work yet.

An API built on a framework uses that framework's pack instead of `package-exports`, and produces REST or GraphQL bindings the same way.

## A summary with no code behind it

Where there is no source to read, a summary can be written by hand or generated from documentation. `confidence` says which, and how much to trust it:

```json
{
  "confidence": { "source": "declared", "level": "low" }
}
```

`source` is `inferred_static` for anything `extract` derived, `declared` for a hand-written claim, `derived` for one generated from a contract or a document, and `inferred_ai` for one a model produced. `level` is `high`, `medium` or `low`. A reader can weigh a summary by both.

For a library that publishes nothing of its own, a community repository can maintain summaries the way DefinitelyTyped maintains type definitions. The format is the same; only where the summaries came from differs.
