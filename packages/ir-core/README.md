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

## A name that says where to go and ask

Some code cannot say what it reaches. A storage layer takes the bucket as an argument, and a service reads its table name out of the deployment. Neither states a name, and a name is what the rest of suss pairs on, so both write a reference instead: one hole, no fixed text, saying where to go and ask.

```ts
referenceName({ root: "location", fields: ["bucket"] }); // "{location.bucket}"
referenceName({ root: "ORDER_TABLE", fields: [] }); // "{ORDER_TABLE}"
referenceFromName("{location.bucket}"); // { root: "location", fields: ["bucket"] }
```

The root is the value the code starts from, and the fields are what it reads inside that value. A language adapter writes one of these while reading source, and the checker settles it much later by joining over a whole run: `{location.bucket}` against what each caller passed for `location`, `{ORDER_TABLE}` against what the deployment sets. Those two sides live in different packages, and a reference is worth nothing unless both spell it the same way, so writing one and reading one are this pair of functions rather than a format each side implements for itself.

`namesNothing` is true of every reference, which is what keeps one out of pairing until something settles it. A name with fixed text around the hole is not a reference: `{stage}-orders` states most of itself and pairs on the fixed text.

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
