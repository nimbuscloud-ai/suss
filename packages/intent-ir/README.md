# @suss/intent-ir

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

The team writes this side: what the code was *meant* to do, in a form that pairs against the derived `BehavioralSummary` of what it *does*.

## What this package is

It defines two kinds of document, told apart by `kind`. Both build on `@suss/ir-core`, so intent and behaviour describe boundaries the same way:

- **System intent** (`kind: boundary`) describes what one boundary should do, as named outcomes. The boundary is REST, function-call, message-bus, storage or unit-invocation, and every field of one comes off the `@suss/ir-core` schema for that protocol.
- **Outcome intent** (`kind: prd`) is a set of human `when` / `expect` scenarios. Each has an optional `link` to a system-intent outcome (`<intent-name>.<outcome-id>`). A scenario with no `link` is valid. It reads fully, and nobody has linked it to an outcome yet.

## Where it fits in suss

It is a peer of `@suss/behavioral-ir`, and both build on `@suss/ir-core`. Readers such as `@suss/contract-intent` parse files into `IntentDoc` and call `intentDocToSummary`. The checker then pairs the result against derived code summaries.

## Status

v0: REST, function-call, message-bus, storage and unit-invocation system intent, effects as outcomes, PRD outcome intent with optional links. GraphQL, runtime-config and metric boundaries have no block yet.

The file format is also published as a [JSON Schema](schema/intent-doc.schema.json), generated from the zod schemas at build time. An editor can check a document against it, and a tool in another language can read one without depending on this package. [Intent format](../../docs/reference/intent-format.md) goes through both document kinds field by field.

## More

- [What an intent document states](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../.github/badges/coverage-intent-ir.svg)

## License

Apache-2.0
