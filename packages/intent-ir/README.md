# @suss/intent-ir

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

The team-authored side of the loop: what the code was *meant* to do, in a form that pairs against the derived `BehavioralSummary` of what it *does*.

## What this package is

Two citizens, discriminated by `kind`, both built on `@suss/ir-core` so intent and behaviour describe boundaries the same way:

- **System intent** (`kind: boundary`): what one boundary should do, as named outcomes. The boundary is REST, function-call, message-bus, storage or unit-invocation, and every field of one comes off the `@suss/ir-core` schema for that protocol.
- **Outcome intent** (`kind: prd`): human `when` / `expect` scenarios, each with an optional `link` to a system-intent outcome (`<intent-name>.<outcome-id>`). A scenario with no `link` is a valid state to be in: it reads fully, and nothing has linked it to an outcome yet.

## Where it fits in suss

It is a peer of `@suss/behavioral-ir`; both build on `@suss/ir-core`. Readers (e.g. `@suss/contract-intent`) parse files into `IntentDoc` and call `intentDocToSummary`; the checker pairs the result against derived code summaries.

## Status

v0: REST, function-call, message-bus, storage and unit-invocation system intent, effects as outcomes, PRD outcome intent with optional links. GraphQL, runtime-config and metric boundaries have no block yet.

## More

- [What an intent document states](./DESIGN.md)
- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Every package and pack suss ships](https://nimbuscloud-ai.github.io/suss/reference/packages)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../.github/badges/coverage-intent-ir.svg)

## License

Apache-2.0
