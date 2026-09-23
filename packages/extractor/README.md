# @suss/extractor

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

The assembly engine that turns raw language-adapter output into a `BehavioralSummary`.

## What this package is

`@suss/extractor` is the core assembly layer of the suss pipeline. Language adapters such as `@suss/adapter-typescript` parse source code and produce a `RawCodeStructure`, a normalized intermediate form that each adapter fills in its own way. The extractor's `assembleSummary` function converts that structure into the final `BehavioralSummary` IR. Along the way it handles condition polarity, terminal mapping, gap detection and confidence assessment, and passes `expectedInput` through for client field tracking. The package also exports the `RawCodeStructure` type, the `PatternPack` interface, and the related raw types, so every adapter shares one contract.

## Where it fits in suss

It imports `@suss/behavioral-ir` for the IR types it produces. `@suss/adapter-typescript`, all framework packs, and the CLI use it. It comes directly between the language adapters and the rest of the pipeline.

## Status

Stable. `assembleSummary`, `detectGaps`, and `assessConfidence` are the public API. Language adapters and framework packs implement against the `RawCodeStructure` and `PatternPack` interfaces.

## Minimal usage

```ts
import { assembleSummary } from "@suss/extractor";
import type { RawCodeStructure } from "@suss/extractor";

const raw: RawCodeStructure = {
  identity: {
    name: "getUser",
    kind: "handler",
    file: "src/routes/user.ts",
    range: { start: 0, end: 100 },
    exportName: "getUser",
    exportPath: ["getUser"],
  },
  boundaryBinding: null,
  parameters: [],
  branches: [
    {
      conditions: [],
      terminal: {
        kind: "response",
        statusCode: { type: "literal", value: 200 },
        body: { typeText: "User", shape: null },
        exceptionType: null,
        message: null,
        component: null,
        delegateTarget: null,
        emitEvent: null,
        location: { start: 80, end: 100 },
      },
      effects: [],
      location: { start: 0, end: 100 },
      isDefault: true,
    },
  ],
  dependencyCalls: [],
  declaredContract: null,
};

const summary = assembleSummary(raw);
// summary.transitions[0].output.type === "response"
```

## More

- [How the extractor assembles a summary](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../.github/badges/coverage-extractor.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the canonical design, see [docs/theory/architecture.md](../../docs/theory/architecture.md).
