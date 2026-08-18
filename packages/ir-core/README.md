# @suss/ir-core

Primitives shared across suss's intermediate representations: the pieces every IR references, in one place that each of them can reach without depending on the others.

## What this package is

The types that any suss IR is built from:

- `TypeShape`: the structure of a value, for body / payload / field comparison.
- `BoundaryBinding` + the `Semantics` variants (rest, function-call, graphql-resolver, graphql-operation, runtime-config, storage, message-bus), plus the eight blessed binding constructors (`restBinding`, `functionCallBinding`, …).
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

## Message-bus channels

A channel is a subject, optionally qualified by the bus that carries it, written `${bus}#${subject}`. Two channels pair when their subjects are equal and their buses agree, and buses agree when they are the same or when either side does not know its bus.

The two sides rarely know the same amount. A CloudFormation template gives both the bus and the detail-type, and it goes out of its way to distinguish one bus from another, so when a side does know its bus we keep that precision. Code usually knows only the subject: the code pack reads `subject: 'order.placed'` from a handler's config, but which bus actually reaches that handler is deployment configuration the code never mentions. So `default#order.placed` pairs with `order.placed`, while `staging#order.placed` does not pair with `default#order.placed`.

The boundary key uses only the subject, so both forms end up in the same bucket and `channelsPair` compares the buses within it.

Schemas are the single source of truth (`@suss/ir-core/schemas`); the types are derived from them. The recursive `TypeShape` is a hand-written named export so consuming packages reference it by name across the package boundary rather than inlining the recursion.

## Names with a hole in them

A deployed resource is often called something built at deploy time. A template writes `!Sub "${StageName}-orders-v1"` and the code writes `` `${stage}-orders-v1` ``, so neither side states a string, both agree about the fixed text, and each spells the parameter its own way. A name is written here as fixed text with `{}` holes, and `namesAgree` says whether two of them are the same name.

A hole stops at the separator between it and what comes next. No separator works for every project, so the rule does not name one, it takes the separator from the pattern: when the fixed text after a hole starts with a character that is not a letter or a digit, that character divides the deploy-time value from the rest of the name, and the value may not contain it. So `{env}-publications-v1` covers `prod-publications-v1`, and it does not cover `prod-creator-publications-v1`, which the hole could only reach by swallowing a `-`.

A greedy hole was the earlier rule, and a module declaring both of those tables had one storage access pair with each of them. The table the code never touches keys on something else, so the run reported a selector mismatch on a boundary that code never reaches.

A hole at the end of a name, and a hole whose next character is a letter or a digit, has no separator to stop at, and it still covers anything. That costs a pair when the value has the separator inside it: `{region}-orders` does not cover `us-east-1-orders`, though `orders-{region}` still covers `orders-us-east-1`. Missing a pair is the better failure of the two, since a wrong match reports findings about a store the code never touches.

One name can still be covered by two patterns. A hole at the end covers anything, so `orders-{suffix}` and `orders-blue-{suffix}` both cover `orders-blue-v1`. Choosing between them belongs to whichever pass picks a provider for an access, and `fixedTextLength` is what such a pass ranks by: the pattern that states more fixed text is the more specific one, and two patterns that state the same amount settle nothing between them.

## Where it fits in suss

Both `@suss/behavioral-ir` (what code does) and `@suss/intent-ir` (what the team meant) build on this package, so neither IR depends on the other. They describe boundaries in the same vocabulary, and suss compares them rather than merging them. `@suss/behavioral-ir` re-exports these primitives, so existing consumers keep importing them from there unchanged.

## Status

v0: type shapes, boundary bindings + constructors, source locations, confidence. Stable surface; new boundary semantics are added as variants.

## Coverage

![coverage](../../.github/badges/coverage-ir-core.svg)

## License

Apache-2.0
