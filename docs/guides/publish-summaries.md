---
title: Publish summaries with your package
description: Ship pre-built behavioral summaries in your package so consumers get cross-boundary checking without your source.
---

# Publish summaries


Summaries travel well: `suss extract` produces relative file paths, and the format contains no machine-specific data. A library author can publish pre-built summaries alongside their package, and consumers get cross-boundary checking without the library's source code.

## Convention

Add a `suss` field to your `package.json` pointing to the summary file:

```json
{
  "name": "my-api",
  "suss": {
    "summaries": "./dist/suss-summaries.json"
  }
}
```

Then extract and include the file in your published package. For plain public APIs, meaning any function reachable through the package's `exports` / `main` / `module` / `types`, the `packageExports` discovery variant produces one summary per public export, so you never have to list the exports by hand:

```js
// build-summaries.mjs
import { createTypeScriptAdapter } from "@suss/adapter-typescript";

const pack = {
  name: "package-exports:my-api",
  languages: ["typescript"],
  protocol: "in-process",
  discovery: [{
    kind: "library",
    match: {
      type: "packageExports",
      packageJsonPath: new URL("./package.json", import.meta.url).pathname,
    },
  }],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw",  match: { type: "throwExpression" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

const adapter = createTypeScriptAdapter({
  tsConfigFilePath: "./tsconfig.json",
  frameworks: [pack],
});
fs.writeFileSync("dist/suss-summaries.json", JSON.stringify(adapter.extractAll(), null, 2));
```

APIs built on a framework (Express / ts-rest / Apollo resolvers / …) use a framework pack in place of `packageExports`, and they produce REST- or GraphQL-semantics bindings the same way.

suss itself does this: `scripts/dogfood.mjs` runs the same setup against every `@suss/*` package. A package that means to publish its contract writes it into `dist/` alongside the build, as above. The dogfood run only analyses this repo locally and nothing reads the output back, so it writes to `<pkg>/.suss/suss-summaries.json` instead, next to the extraction cache and outside anything npm ships. See `design/docs-internal/dogfooding.md` for the run output.

Consumers can check against published summaries directly:

```sh
suss check node_modules/my-api/dist/suss-summaries.json my-consumer-summaries.json
```

## Community-maintained summaries

For libraries that don't publish their own summaries, a community repository can maintain them, the way DefinitelyTyped maintains type definitions. The same `BehavioralSummary[]` format applies; only where the summaries came from is different.

## Summaries without source code

When source code isn't available, a summary can be authored by hand (`confidence.source: "declared"`) or generated from a contract or documentation (`confidence.source: "derived"`). Set `confidence.level` to reflect how much to trust it:

```json
{
  "confidence": { "source": "declared", "level": "low" }
}
```

Tools can use this to adjust how much they trust the summary.

