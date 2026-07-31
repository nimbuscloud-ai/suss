# @suss/ir-core

Primitives shared across suss's intermediate representations: the shapes every IR references, in one place that none of them depend on each other to reach.

## What this package is

The types that any suss IR is built from:

- `TypeShape`: the structural shape of a value, for body / payload / field comparison.
- `BoundaryBinding` + the `Semantics` variants (rest, function-call, graphql-resolver, graphql-operation, runtime-config, storage-relational, message-bus), plus the eight blessed binding constructors (`restBinding`, `functionCallBinding`, …).
- `SourceLocation` and `Confidence` (`source` + `level`).

```ts
import { restBinding, type TypeShape } from "@suss/ir-core";

const binding = restBinding({
  transport: "http",
  method: "GET",
  path: "/users/:id",
  recognition: "express",
});
```

Schemas are the single source of truth (`@suss/ir-core/schemas`); the types are derived from them. The recursive `TypeShape` is a hand-written named export so consuming packages reference it by name across the package boundary rather than inlining the recursion.

## Where it sits in suss

The base both `@suss/behavioral-ir` (what code does) and `@suss/intent-ir` (what the team meant) build on, so neither IR depends on the other. They describe boundaries in the same vocabulary and are compared rather than merged. `@suss/behavioral-ir` re-exports these primitives, so existing consumers keep importing them from there unchanged.

## Status

v0: type shapes, boundary bindings + constructors, source locations, confidence. Stable surface; new boundary semantics are added as variants.

## Coverage

![coverage](../../.github/badges/coverage-ir-core.svg)

## License

Apache-2.0
