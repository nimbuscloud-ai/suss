# @suss/extractor

Assembly engine that turns raw language-adapter output into a `BehavioralSummary`.

## What this package is

`@suss/extractor` is the core assembly layer of the suss pipeline. Language adapters (such as `@suss/adapter-typescript`) parse source code and produce a `RawCodeStructure`, a normalized, adapter-specific intermediate form. The extractor's `assembleSummary` function converts that structure into the final `BehavioralSummary` IR, handling condition polarity, terminal mapping, gap detection, confidence assessment, and `expectedInput` pass-through for client field tracking. It also exports the `RawCodeStructure` type, the `PatternPack` interface, and all related raw types so adapters can share a common contract.

## Where it fits in suss

It imports `@suss/behavioral-ir` for the IR types it produces. `@suss/adapter-typescript`, all framework packs, and the CLI use it. It comes directly between the language adapters and the rest of the pipeline.

## Status

Stable. `assembleSummary`, `detectGaps`, and `assessConfidence` are the public API. The `RawCodeStructure` and `PatternPack` interfaces are the contract that language adapters and framework packs implement against.

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

## Composing the wrappers around a unit

A route's wire behaviour is not only what its own body does. Middleware, error handlers and validation hooks produce responses for it without appearing in it, which is why a service whose auth middleware returns 401 used to look like every route disagreed with its contract.

A wrapper is a meta-function: it takes a unit and returns a unit. Its own body says what it does once you know which call is the continuation, so the adapter reads the call to that parameter as a `delegate` terminal. A path through the wrapper that reaches it hands control to the wrapped unit; a path that ends first responds on its own.

```
composed = the wrapper's short circuits
         + (its pass-throughs x the wrapped unit's transitions)
```

`composeWrappers` runs that over a whole run's summaries. It reads the `wrappers` metadata a unit records, finds each wrapper's summary by file and name, and folds them innermost first, the way `mw1(mw2(handler))` reads. A wrapper the framework only calls on a throw goes on last and replaces the paths that ended by throwing with its own response. Every transition a wrapper contributed records which one, under `wrappers.from`, so a reader asking why a route returns 401 lands in the middleware.

What it does not read:

- **Anything after the continuation returns.** A middleware that inspects the response on the way back out is read up to the `next()` call and no further.
- **A wrapper whose continuation the pack does not declare, or whose call the walk cannot see.** Nothing says where control passes on, so the wrapper's outcomes are reported beside the unit's own rather than around them.
- **A throw the walk never saw.** An error handler composes over the paths that end by throwing, so a route whose 500 comes from a call the walk could not follow still does not report 500.
- **Registration order against route order.** A wrapper registered after a route still composes into it.

Composition multiplies paths, so it is capped by the same `MAX_PATHS` budget path enumeration uses. Past it the two sides are reported side by side and the unit gets a gap saying so.

## Coverage

![coverage](../../.github/badges/coverage-extractor.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the canonical design, see [docs/architecture.md](../../docs/architecture.md).
