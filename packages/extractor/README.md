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

## Which branch an effect belongs to

An adapter finds the calls a body makes once, and it finds the branches separately. Something then has to say which branch each call runs on. `guardsHoldOn` and `runsBefore` in `effectGuards.ts` are that decision, and both adapters that make it call these rather than keeping a copy.

A call belongs to a branch when two things are true of it.

- **No guard the call is written under was recorded the other way around on the branch.** A call inside `if (flag)` stays off every branch that recorded `!flag`. A call written above every guard has none, so it reaches all of them.
- **The call is written no later than the terminal's last line.** A call written after an early return did not run on that early return's path. The terminal's last line and not its first, because `return new Promise((resolve) => resolve(read()))` runs the call inside its own expression.

Neither test is enough on its own, and the two ways to get it wrong are both ordinary code.

```ts
const found = await dynamo.send(new GetItemCommand({ TableName: "Invoices" }));
if (!found.Item) {
  return { statusCode: 404, body: JSON.stringify({ error: "no invoice" }) };
}
return { statusCode: 200, body: JSON.stringify({ invoice: found.Item }) };
```

The read is under no guard, so guards alone put it on both branches, which is right. Source order alone would too. But `JSON.stringify` inside the 404 return is under `!found.Item`, and its line comes before the 200 return, so source order alone would put it on the 200 branch, where it never ran. Guards catch that. Turn the example around, put the read after the 404 return, and guards alone put it on the 404 branch, where it also never ran. Source order catches that.

The first test asks whether the branch contradicts the guard, not whether the branch repeats it. That matters because a branch often cannot speak about a guard at all. The path engine opacifies a loop, so a terminal after the loop records nothing about an `if` inside the loop body, and the same goes for a call inside a `catch` or inside a callback the walk descended into. The commonest shape in this repo is an accumulator: a loop that pushes into an array under a condition, then returns the array. Requiring the branch to repeat the guard takes those pushes off the only branch there is, and the unit comes out calling nothing at all. So silence on the branch leaves the effect in place, and only a guard written down the other way around takes it off.

Comparison is by the condition's polarity and the text it was written as, the same key a transition id is built from. An adapter therefore has to spell a guard on an effect the way it spells the same guard on a branch, or the two never meet and the guard is treated as silence.

## Coverage

![coverage](../../.github/badges/coverage-extractor.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the canonical design, see [docs/architecture.md](../../docs/architecture.md).
