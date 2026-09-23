---
title: Publish summaries
description: Write your service's summaries to a file, commit it, and let another repo check its own code against them without reading your source.
---

# Publish summaries

Write the summaries to a file with `-o` and commit it. Another repo can then check its own code against that file without access to yours.

```bash
npx suss extract -p tsconfig.json -f hono -o suss/catalog.json
git add suss/catalog.json
```

The file works on any machine, because `extract` writes every path in it relative to the package root and nothing else in it depends on the machine that wrote it:

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

Regenerate it in CI on every change to the service, the same way you regenerate a client or an OpenAPI document, so the committed file keeps up with the code.

## How a downstream repo reads it

The downstream repo puts the file in the folder it passes to `check --dir`, next to its own extract output:

```bash
cp node_modules/@acme/catalog/suss/catalog.json summaries/
npx suss extract -p tsconfig.json -f fetch -o summaries/web.json
npx suss check --dir summaries/
```

`check --dir` pairs summaries by boundary, so it does not matter which run wrote which file. The two sides can come from different repositories and different languages, and they do not have to be written on the same day. You can also pass both files to check one pair:

```bash
npx suss check node_modules/@acme/catalog/suss/catalog.json summaries/web.json
```

[Work across services](/guides/work-across-services) walks through the two-repo flow end to end and shows a finding for two sides that disagree.

## What the file guarantees

suss stamps every summary with a `schemaVersion`, and the parsers in `@suss/behavioral-ir` read every version ever published. A file an older suss wrote does not need rewriting, because a newer reader upgrades it as it parses. Version 6 is current. [Summary format](/reference/summary-format) lists what each version changed and documents every field.

You can consume the JSON in two ways:

- **TypeScript or JavaScript:** install `@suss/behavioral-ir` and call `parseSummaries(json)`, which validates and narrows in one step. The types come from the same schemas.
- **Anything else:** validate against the JSON Schema the build generates from those schemas, at `packages/behavioral-ir/schema/behavioral-summary.schema.json`.

Transition ids are deterministic per branch. suss builds each one from the function name, the terminal kind, the status and a hash of the conditions, so you can diff two files written at different times. `suss inspect --diff before.json after.json` reports what moved between them.

## A library with no framework in it

A package whose public API is plain functions has a boundary too: everything its `exports` makes reachable. The `package-exports` pack reads that side without you listing the exports.

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

The same run also reads the calling side. It writes one summary for each function that imports one of those exports, so a monorepo can check its own packages against each other:

```
packages/app/src/checkout.ts
└─ checkout → @acme/ledger::postEntry  (package-exports caller | line 3)
       -> return
         + packages/ledger/src/index.postEntry →
```

suss finds both sides through the workspace manifest. It finds the caller side for a sibling package in the same workspace, but it does not look for one under `node_modules`. You cannot yet publish the provider side of a library and pair it from a separate repository.

An API built on a framework uses that framework's pack instead of `package-exports`, and gets REST or GraphQL bindings the same way.

## A summary with no code behind it

When there is no source to read, you can write a summary by hand or generate one from documentation. `confidence` records which of those it was, and how much to trust it:

```json
{
  "confidence": { "source": "declared", "level": "low" }
}
```

`source` is `inferred_static` for anything `extract` derived, `declared` for a hand-written claim, `derived` for one generated from a contract or a document, and `inferred_ai` for one a model produced. `level` is `high`, `medium` or `low`. A reader can weigh a summary by both.

For a library that publishes no summaries of its own, a community repository can maintain them the way DefinitelyTyped maintains type definitions. Those summaries use the same format. Only their origin is different.
