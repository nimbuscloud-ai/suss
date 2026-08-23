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

A channel is a subject, optionally qualified by the bus it travels on, written `${bus}#${subject}`. Two channels pair when their subjects are equal and their buses agree, and buses agree when they are the same or when either side does not know its bus.

The two sides rarely know the same amount. A CloudFormation template gives both the bus and the detail-type, and it goes out of its way to distinguish one bus from another, so when a side does know its bus we keep that precision. Code usually knows only the subject: the code pack reads `subject: 'order.placed'` from a handler's config, but which bus actually reaches that handler is deployment configuration the code never mentions. So `default#order.placed` pairs with `order.placed`, while `staging#order.placed` does not pair with `default#order.placed`.

The boundary key uses only the subject, so both forms end up in the same bucket and `channelsPair` compares the buses within it.

Schemas are the single source of truth (`@suss/ir-core/schemas`); the types are derived from them. The recursive `TypeShape` is a hand-written named export so consuming packages reference it by name across the package boundary rather than inlining the recursion.

## Boundary names

A container or an access path in a summary is a string that means one of three things, and the braces alone say which:

- A **literal** (`orders-v1`) is the name itself.
- A **pattern** (`{stage}-orders-v1`) is fixed text with `{}` holes for the parts a deployment fills in. A template writes `!Sub "${StageName}-orders-v1"` and the code writes `` `${stage}-orders-v1` ``: neither states a string, both agree about the fixed text, and each spells the parameter its own way.
- A **reference** (`{location.bucket}`, `{ORDER_TABLE}`) is one hole and no fixed text, saying where to go and ask rather than what the name is.

`boundaryName.ts` owns the syntax in both directions. `parseBoundaryName` turns a string into the discriminated `BoundaryName` value, `boundaryNameString` turns one back into exactly the string it came from, and everything else, `namesAgree`, `namesNothing`, `fixedTextLength`, `referenceName`, `referenceFromName`, is a view over that pair. Nothing outside the module reads or writes the braces itself: a second parser can disagree about which of the three a string is, and a second printer can spell a value the parser cannot read back. Both have happened. The two halves of caller grounding once spelled a reference differently and never met (#456), which is why writing one and reading one are the same module rather than a format each side implements for itself. `check:name-syntax` in CI keeps it that way.

The wire format is the string. Summaries on disk contain `orders-v1`, `{stage}-orders-v1`, `{location.table}` unchanged, so nothing about this layout is a schema change, and an old summary reads the same as a new one.

### How two names pair

`namesAgree` says whether two names are the same name. Two patterns agree when their fixed parts line up, since a hole on one side meets a hole on the other. A pattern and a literal agree when the fixed text is where the pattern says it is, which is what happens when one side hardcoded what the other parameterized. A reference agrees with nothing until something settles it, since one bare hole would otherwise agree with every name there is.

A hole covers anything, because a name has no separator every project agrees on: a region is written `us-east-1`, and a hole that stopped at the first hyphen would miss it. The cost is that one name can be covered by two patterns, `orders-{suffix}` and `orders-blue-{suffix}` both cover `orders-blue-v1`, so choosing between them belongs to whichever pass picks a provider for an access. `fixedTextLength` is what such a pass ranks by: the pattern that states more fixed text is the more specific one, and two patterns that state the same amount settle nothing between them.

### A name that says where to go and ask

Some code cannot say what it reaches. A storage layer takes the bucket as an argument, and a service reads its table name out of the deployment. Neither states a name, and a name is what the rest of suss pairs on, so both write a reference instead.

```ts
referenceName({ root: "location", fields: ["bucket"] }); // "{location.bucket}"
referenceName({ root: "ORDER_TABLE", fields: [] }); // "{ORDER_TABLE}"
referenceFromName("{location.bucket}"); // { root: "location", fields: ["bucket"] }
```

The root is the value the code starts from, and the fields are what it reads inside that value. A language adapter writes one while reading source, and the checker settles it much later by joining over a whole run: `{location.bucket}` against what each caller passed for `location`, `{ORDER_TABLE}` against what the deployment sets. Whether the root is a parameter of the unit or a variable the deployment sets is not in the string, on purpose: it depends on the unit's inputs and their roles, which the grounding pass already has in hand, and a bare `{X}` is deliberately tried both ways there. A root kind written into the name would either be ignored or change which of those runs.

### Two look-alike conventions that stay apart

A REST route path also spells its parameters with braces (`/users/{id}`), but a route hole stops at the `/` between segments, so route paths keep their own comparison beside the REST semantics. A message-bus channel never uses braces at all; its `bus#subject` form has its own module, described above.

## Words OpenTelemetry already has

A summary says what a unit can reach. A trace says what it did reach. Comparing the two is the point, and it only works if both sides spell a boundary the same way, so wherever OpenTelemetry's semantic conventions have a word for something in a binding, that is the word suss writes.

The values are theirs. A Postgres table is `postgresql`, not `postgres`; a DynamoDB table is `aws.dynamodb`; an SQS queue is `aws_sqs` and an SNS topic is `aws.sns`, spelled the two different ways the conventions spell them.

The field names are ours. Each protocol module says which attribute each of its fields goes under, and `semconvAttributes(binding)` reads a binding as the attributes a span would state:

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

A field appears in that projection only when the value suss writes is the value a span gets, so the comparison is byte for byte with nothing in between. Three kinds of field stay out of it:

- **A field the conventions have no attribute for.** A secondary index (`accessPath`) is one, and a GraphQL resolver's type and field are another, since the conventions describe the operation a client sent and not the resolver the server ran for one field of it.
- **A value suss writes where the source stated none.** `scope: "default"` means no source said which database, and a REST method of `"*"` means the route responds to every method. A span says neither.
- **The same thing under a different string.** `service.name` and `cloud.resource_id` both point at the deployable a `runtime-config` boundary belongs to, but `instanceName` is the deployment template's logical id, which is neither of those strings.

Where the conventions have no word at all, suss keeps its own: a store they never covered (`s3`, `gcs`, `r2`, `d1`, `cloudflare-kv`), a bus they never covered (`eventbridge`, `bullmq`, `nats`, the Cloudflare triggers), a metric's system and type, and every boundary nobody crosses at run time, which is a function call across a package boundary, a contract a template declares, and an intent. Those are the boundaries suss exists for, and no observability convention has a word for them.

Adding a protocol means filling in `semconv` on its definition, empty included, so the question gets answered rather than skipped.

## Where it fits in suss

Both `@suss/behavioral-ir` (what code does) and `@suss/intent-ir` (what the team meant) build on this package, so neither IR depends on the other. They describe boundaries in the same vocabulary, and suss compares them rather than merging them. `@suss/behavioral-ir` re-exports these primitives, so existing consumers keep importing them from there unchanged.

## Status

v0: type shapes, boundary bindings + constructors, source locations, confidence. Stable surface; new boundary semantics are added as variants.

## Coverage

![coverage](../../.github/badges/coverage-ir-core.svg)

## License

Apache-2.0
