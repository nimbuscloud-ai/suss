# @suss/intent-ir

The team-authored side of the loop: what the code was *meant* to do, in shapes that pair against the derived `BehavioralSummary` of what it *does*.

## What this package is

Two citizens, discriminated by `kind`, both built on `@suss/ir-core` so intent and behaviour describe boundaries the same way:

- **System intent** (`kind: boundary`): what one boundary should do, as named outcomes. The boundary is REST **or** function-call; each outcome is a `response` (status + body), a `returns` (a function/handler return value), or a `throws` (an error). The function-call form is what lets suss check its own non-HTTP surface.
- **Outcome intent** (`kind: prd`): human `when` / `expect` scenarios, each with an optional `link` to a system-intent outcome (`<intent-name>.<outcome-id>`). A scenario with no `link` is a valid pending-link state: fully readable, not yet machine-linked.

```ts
import { IntentDocSchema, intentDocToSummary } from "@suss/intent-ir";

const doc = IntentDocSchema.parse(/* parsed YAML / JSON */);
const summary = intentDocToSummary(doc); // normalised, checker-ready
```

`schema.ts` is the authoring surface (friendly to write); `summary.ts` is the normalized shape the checker consumes (boundaries as `ir-core` `BoundaryBinding`s, bodies as `TypeShape`s, one flat outcome list) plus the transform between them. `source` provenance (`author` / `inferred` / `inferred, curated`) rides along for the inference path.

The design is documented in [`docs/internal/proposals/intent-specs.md`](../../docs/internal/proposals/intent-specs.md).

## Where it sits in suss

Peer to `@suss/behavioral-ir`; both build on `@suss/ir-core`. Readers (e.g. `@suss/contract-intent`) parse files into `IntentDoc` and call `intentDocToSummary`; the checker pairs the result against derived code summaries.

## Status

v0: REST + function-call system intent, PRD outcome intent with optional links. The checker integration and reader migration build on this.

## Coverage

![coverage](../../.github/badges/coverage-intent-ir.svg)

## License

Apache-2.0
