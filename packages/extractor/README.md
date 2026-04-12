# @suss/extractor

Assembly engine that turns raw language-adapter output into a `BehavioralSummary`.

## What this package is

`@suss/extractor` is the core assembly layer of the suss pipeline. Language adapters (such as `@suss/adapter-typescript`) parse source code and produce a `RawCodeStructure` — a normalized, adapter-specific intermediate form. The extractor's `assembleSummary` function converts that structure into the final `BehavioralSummary` IR, handling condition polarity, terminal mapping, gap detection, and confidence assessment. It also exports the `RawCodeStructure` type and all related raw types so adapters can share a common contract.

## Where it sits in suss

Imports `@suss/behavioral-ir` for the IR types it produces. Consumed by `@suss/adapter-typescript`, all framework packs, and the CLI. It sits directly between the language adapters and the rest of the pipeline.

## Status

Phase 1 complete and stable. `assembleSummary`, `detectGaps`, and `assessConfidence` are the settled public API. See [`docs/status.md`](../../docs/status.md).

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

## Coverage

![coverage](../../.github/badges/coverage-extractor.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the canonical design, see [docs/architecture.md](../../docs/architecture.md).
