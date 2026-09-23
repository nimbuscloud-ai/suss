# @suss/ir-core

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Primitives shared across suss's intermediate representations. Every IR refers to these pieces, and keeping them in one package lets each IR reach them without depending on the others.

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

The schemas in `@suss/ir-core/schemas` are the single source of truth, and the types are derived from them. The recursive `TypeShape` is a hand-written named export, so consuming packages refer to it by name across the package boundary and do not inline the recursion.

## Message-bus channels

A channel is a subject, optionally qualified by the bus it travels on, written `${bus}#${subject}`. Two channels pair when their subjects are equal and their buses agree. Buses agree when they are the same, or when either side does not know its bus.

The two sides rarely know the same amount. A CloudFormation template gives both the bus and the detail-type, and it distinguishes one bus from another on purpose, so when a side does know its bus, suss keeps that precision. Code usually knows only the subject. The code pack reads `subject: 'order.placed'` from a handler's config, but which bus reaches that handler is set by deployment configuration that the code never mentions. So `default#order.placed` pairs with `order.placed`, while `staging#order.placed` does not pair with `default#order.placed`.

The boundary key uses only the subject, so both forms end up in the same bucket, and `channelsPair` compares the buses within it.

## Boundary names

A container or an access path in a summary is a string that means one of three things, and the braces alone decide which:

- A **literal** (`orders-v1`) is the name itself.
- A **pattern** (`{stage}-orders-v1`) is fixed text with `{}` holes for the parts a deployment fills in. A template writes `!Sub "${StageName}-orders-v1"` and the code writes `` `${stage}-orders-v1` ``. Neither states the full string, both agree about the fixed text, and each writes the parameter its own way.
- A **reference** (`{location.bucket}`, `{ORDER_TABLE}`) is one hole with no fixed text. It records where to look up the name, because the name itself is not known.

`boundaryName.ts` handles the syntax in both directions. `parseBoundaryName` turns a string into the discriminated `BoundaryName` value, and `boundaryNameString` turns one back into exactly the string it came from. Everything else, `namesAgree`, `namesNothing`, `fixedTextLength`, `referenceName`, `referenceFromName`, is built on that pair. No code outside the module reads or writes the braces itself. A second parser can disagree about which of the three a string is, and a second printer can write a value the parser cannot read back. Both have happened. The two halves of caller grounding once wrote a reference differently and never matched (#456). That is why writing a name and reading one live in the same module, and each side does not implement the format for itself. `check:name-syntax` in CI keeps it that way.

The wire format is the string. Summaries on disk contain `orders-v1`, `{stage}-orders-v1` and `{location.table}` unchanged, so this layout is not a schema change, and an old summary reads the same as a new one.

### How two names pair

`namesAgree` decides whether two names are the same name. Two patterns agree when their fixed parts line up, since a hole on one side meets a hole on the other. A pattern and a literal agree when the fixed text is where the pattern puts it. That happens when one side hardcoded what the other parameterized. A reference agrees with nothing until something settles it, because one bare hole would otherwise agree with every name there is.

A hole covers anything, because projects do not share a separator for names. A region is written `us-east-1`, and a hole that stopped at the first hyphen would miss it. The cost is that one name can be covered by two patterns: `orders-{suffix}` and `orders-blue-{suffix}` both cover `orders-blue-v1`. Choosing between them is the job of whichever pass picks a provider for an access. Such a pass ranks by `fixedTextLength`. The pattern that states more fixed text is the more specific one, and two patterns that state the same amount leave the choice open.

### References

Some code cannot state what it reaches. A storage layer takes the bucket as an argument, and a service reads its table name out of the deployment. Neither states a name, and the rest of suss pairs on names, so both write a reference instead.

```ts
referenceName({ root: "location", fields: ["bucket"] }); // "{location.bucket}"
referenceName({ root: "ORDER_TABLE", fields: [] }); // "{ORDER_TABLE}"
referenceFromName("{location.bucket}"); // { root: "location", fields: ["bucket"] }
```

The root is the value the code starts from, and the fields are what it reads inside that value. A language adapter writes a reference while reading source. The checker settles it much later by joining over a whole run: it matches `{location.bucket}` against what each caller passed for `location`, and `{ORDER_TABLE}` against what the deployment sets. The string does not record whether the root is a parameter of the unit or a variable the deployment sets, and that is on purpose. The answer depends on the unit's inputs and their roles, which the grounding pass already has, and that pass tries a bare `{X}` both ways on purpose. A root kind written into the name would either be ignored or change which of those attempts runs.

### Route paths and message-bus channels

A REST route path also writes its parameters with braces (`/users/{id}`). A route hole stops at the `/` between segments, so route paths keep their own comparison next to the REST semantics. A message-bus channel never uses braces. Its `bus#subject` form has its own module, described above.

## OpenTelemetry vocabulary

A summary records what a unit can reach, and a trace records what it did reach. Comparing the two is the goal, and that only works if both sides write a boundary the same way. So wherever OpenTelemetry's semantic conventions have a word for something in a binding, suss writes that word.

The values come from the conventions. A Postgres table is `postgresql`, and `postgres` is wrong. A DynamoDB table is `aws.dynamodb`. An SQS queue is `aws_sqs` and an SNS topic is `aws.sns`, spelled the two different ways the conventions spell them.

The field names are suss's own. Each protocol module declares which attribute each of its fields maps to, and `semconvAttributes(binding)` returns a binding as the attributes a span would have:

```ts
semconvAttributes(
  storageBinding({
    recognition: "prisma",
    storageSystem: "postgresql",
    scope: "orders",
    container: "users",
  }),
);
// { "db.system.name": "postgresql", "db.namespace": "orders",
//   "db.collection.name": "users" }
```

A field appears in that projection only when the value suss writes is the value a span gets, so the comparison is byte for byte with no translation. Three kinds of field stay out of it:

- **A field the conventions have no attribute for.** A secondary index (`accessPath`) is one. A GraphQL resolver's type and field are another, because the conventions describe the operation a client sent and say nothing about the resolver the server ran for one field of it.
- **A value suss writes where the source stated none.** `scope: "default"` means no source said which database, and a REST method of `"*"` means the route responds to every method. A span has neither.
- **The same thing under a different string.** `service.name` and `cloud.resource_id` both identify the deployable that a `runtime-config` boundary belongs to. `instanceName` is the deployment template's logical id, which matches neither of those strings.

Where the conventions have no word at all, suss keeps its own. That covers a store they never covered (`s3`, `gcs`, `r2`, `d1`, `cloudflare-kv`), a bus they never covered (`eventbridge`, `bullmq`, `nats`, the Cloudflare triggers), and a metric's system and type. It also covers every boundary nobody crosses at run time: a function call across a package boundary, a contract a template declares, and an intent. suss exists for those boundaries, and no observability convention has a word for them.

Adding a protocol means filling in `semconv` on its definition, even when it is empty, so the question is always answered and never skipped.

## Where it fits in suss

`@suss/behavioral-ir` (what code does) and `@suss/intent-ir` (what the team meant) both build on this package, so neither IR depends on the other. They describe boundaries in the same vocabulary, and suss compares them without merging them. `@suss/behavioral-ir` re-exports these primitives, so existing consumers keep importing them from there unchanged.

## Status

v0: type shapes, boundary bindings + constructors, source locations, confidence. The surface is stable, and new boundary semantics are added as variants.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../.github/badges/coverage-ir-core.svg)

## License

Apache-2.0
