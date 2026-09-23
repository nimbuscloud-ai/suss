---
title: Contract sources
description: The ten things suss contract reads, from an OpenAPI document to a wrangler config, and the boundary each one produces.
---

# Contract sources

`suss contract` reads something your project already declares and writes the same summaries `suss extract` writes from code. Both go in the same folder, and `suss check` pairs them:

```bash
suss extract -f hono -o summaries/code.json
suss contract --from openapi orders.yaml -o summaries/orders.json
suss check --dir summaries/
```

There are ten sources. `SPEC` is a file path or an `http(s)` URL, and a fetched document is parsed by its extension, `.json` as JSON and anything else as YAML.

## `openapi`

An OpenAPI 3.x document, JSON or YAML. Every operation becomes one handler-kind summary with a transition per declared response.

```bash
$ suss contract --from openapi orders.yaml -o openapi.json
$ suss inspect openapi.json
openapi:orders.yaml
└─ POST /orders/{id}/refund  (openapi handler | line 0)
     Contract: 201, 404, 409
       -> 201 { id, amount }
       -> 404
       -> 409
```

The `Contract:` line lists what the spec declares, and suss compares a handler against that list. A response with no schema comes out with no body.

## `graphql`

A plain GraphQL SDL file. Every Query, Mutation and Subscription field becomes a resolver-kind summary on the provider side. These pair against the resolvers the Apollo and NestJS GraphQL packs find in code.

```bash
$ suss contract --from graphql schema.graphql -o gql.json
$ suss inspect gql.json
schema.graphql:Mutation.refundOrder
└─ gql:Mutation.refundOrder  (graphql resolver | line 0)
       if  graphql:resolver-error
         -> throw GraphQLError
       else
         -> return Order
```

## `graphql-documents`

Committed `.graphql` and `.gql` operation documents, one file or a directory walked recursively. Every query, mutation and subscription becomes a client-kind summary on the consumer side. Use this when your repo keeps its operations in files, since then nothing has to be traced through the code.

```bash
$ suss contract --from graphql-documents src/queries -o operations.json
$ suss inspect operations.json
src/queries/productList.graphql
└─ query ProductList  (graphql-documents client | line 0)
       if  graphql:operation-error
         -> throw GraphQLError
       else
         -> return { products }
   
       !! Fragment spread "...ProductListItem" has no matching fragment definition in the read set; its selections are not part of this summary.
```

The reader resolves each fragment spread against every fragment definition in the files it read, and inlines it into the stored document, so pairing sees the selected fields directly. A spread the reader cannot expand stays in the document as written and becomes a gap on that summary. The warning in the output above is one of these. Pass the whole directory and the reader finds the fragment.

Each operation summary stores its document text at `metadata.graphql.document`, the same place the TypeScript adapter puts documents it recovers from call sites, so moving an operation from a call site into a file changes no findings.

## `cloudformation`

A CloudFormation or SAM template. API Gateway REST and HTTP API resources become route summaries, SQS event-source mappings become consumers, and a function's `Environment` becomes its runtime-config contract.

```bash
$ suss contract --from cloudformation template.yaml -o cfn.json
$ suss inspect cfn.json
cloudformation:template.yaml:WidgetItemFunction:Get
└─ GET /widgets/{widgetId}  (apigateway handler | line 0)
     Contract: 
       if  aws:apigateway:status-504
         -> 504  !! undeclared
       elif  aws:apigateway:status-502
         -> 502  !! undeclared
```

API Gateway produces those two itself, whatever the handler's code does: 504 on an integration timeout and 502 when the Lambda errors. A configured authorizer adds 401 and 403, a request validator adds 400, and throttling adds 429. `!! undeclared` marks the ones the handler's own code doesn't account for.

## `serverless`

A Serverless Framework service file, or the directory it is in. The reader rewrites the functions block in SAM's form and passes it to the CloudFormation reader, so a route, a queue consumer or an environment contract comes out the same whichever manifest language declared it.

```bash
$ suss contract --from serverless serverless.yml -o sls.json
$ suss inspect sls.json
serverless:serverless.yml:createOrder:httpApi0
└─ POST /api/orders  (apigateway handler | line 0)
...
serverless:serverless.yml
├─ createOrder  (serverless library | line 1)
│
├─ processOrders  (serverless library | line 1)
│
├─ processOrders.sqs0 → aws_sqs OrdersQueue  (serverless consumer | line 1)
│
└─ processOrders.sqs1 → aws_sqs env:AUDIT_QUEUE_ARN  (serverless consumer | line 1)
```

`${self:...}` resolves against the document. A reference that only the deploy supplies keeps its token, as `env:AUDIT_QUEUE_ARN` does above. suss records that a queue is there without knowing its name, and pairs the consumer on that basis.

## `terraform`

A `.tf` file, or the directory a module lives in, since a module declares its resources across several files. The reader writes one summary per store the configuration declares.

```bash
$ suss contract --from terraform infra/ -o tf.json
$ suss inspect tf.json
infra/main.tf
├─ redis:<unnamed container>  (terraform library | line 1)
│
├─ s3:archive  (terraform library | line 1)
│    Table: acme-archive
│
└─ gcs:uploads  (terraform library | line 1)
     Table: acme-uploads
```

The AWS and Google Cloud providers both load, so one command covers a configuration using either. A resource whose name the configuration computes comes out unnamed.

## `wrangler`

A Cloudflare Worker's `wrangler.toml` or `wrangler.jsonc`, or the directory the Worker is in. The Worker comes out as a deployable with its configuration. The reader also writes one summary for each KV namespace, R2 bucket, D1 database and Queues channel the Worker is bound to.

```bash
$ suss contract --from wrangler . -o wrangler.json
$ suss inspect wrangler.json
wrangler:wrangler.toml
├─ edge-cache  (wrangler library | line 1)
│
├─ cloudflare-kv:SESSIONS  (wrangler library | line 1)
│    Table: prod-sessions
│
├─ r2:ARCHIVE  (wrangler library | line 1)
│    Table: prod-archive
│
└─ d1:LEDGER  (wrangler library | line 1)
     Table: prod-ledger
```

The binding name is what the Worker's code reads off its environment argument, and the store name is what the binding points at, so `-f cloudflare-workers` on the source pairs a read of `env.SESSIONS` against `prod-sessions` here.

## `appsync`

A CloudFormation or SAM template with `AWS::AppSync::*` resources. Each resolver becomes a summary with GraphQL resolver semantics.

```bash
$ suss contract --from appsync template.yaml -o appsync.json
$ suss inspect appsync.json
template.yaml:QueryNoteResolver
└─ gql:Query.note  (appsync resolver | line 0)
       if  aws:appsync:resolver-error
         -> throw Error
       else
         -> return Note
```

The schema can be inline in the template or in a `schema.graphql` next to it.

## `prisma`

A `schema.prisma` file. Every model becomes a storage-provider summary with its fields, and those summaries pair against the storage-access effects the Prisma pack finds in code.

```bash
$ suss contract --from prisma schema.prisma -o prisma.json
$ suss inspect prisma.json
schema.prisma
├─ postgresql:Order  (prisma library | line 1)
│    Serves: id (Int), total (Int), refundedAt (DateTime)
│
└─ postgresql:Refund  (prisma library | line 1)
     Serves: id (Int), orderId (Int), amount (Int)
```

The datasource provider is part of the identity, so `postgresql:Order` pairs with a Postgres read and not with something else called `Order`.

## `storybook`

A CSF3 stories file, or a directory of them. Each named story becomes a summary of the component with the props that story passes.

```bash
$ suss contract --from storybook src/components -o stories.json
$ suss inspect stories.json
src/components/Button.stories.tsx
├─ Button.Primary  (react component | line 12 | confidence: medium)
│      -> render <Button />
│
└─ Button.Disabled  (react component | line 18 | confidence: medium)
       -> render <Button />
```

The checker then has a set of prop combinations the component is expected to take. When the component starts requiring a prop that no story passes, that becomes a finding.

## Intent is not a `--from` source

`check` reads the intent documents your team writes directly:

```bash
suss check --dir summaries/ --intent intent/
```

[Check against your intent](/guides/check-against-intent) shows how.

## What a contract summary records

Every transition a contract source emits is marked `confidence: { source: "derived", level }`. With `derived`, inspect and diff can tell that the transition came from a declaration, and `level` says how precisely the source stated it. An OpenAPI `200` with a typed body schema is `high`. A `2XX` range expansion, or a body described with `additionalProperties: true`, is lower.

Read `derived` as a note about where the summary came from. A well-formed OpenAPI document is often more precise than the TypeScript behind it, so a derived summary can be the better description of the two. The checker pairs by method and normalized path whatever the source, so `:id` on one side matches `{id}` on the other. `confidence.source` stays on both sides for anybody who wants to filter by it.

There are four things a contract source deliberately does not do:

- **Validate its own input.** A malformed template or a broken `$ref` produces best-effort output. Validation is a job for the format's own tooling.
- **Predict runtime state.** A throttled endpoint can return 429, and whether it does depends on traffic. The summary covers every behavior that is possible.
- **Model authorization per caller.** The reader records "an authorizer is attached, so 401 and 403 are possible". Whether user X is denied on resource Z is runtime state.
- **Backfill a field the source left out.** An OpenAPI response with no body schema emits a null body.

## Adding a source

A new reader is one package, `@suss/contract-<format>`, plus a loader entry in `packages/cli/src/contract.ts`. Two decisions come first.

**Where the truth is.** It can be a spec (OpenAPI, GraphQL SDL), a deploy manifest (CloudFormation, Terraform, wrangler), a vendor's documented behavior, or a file the team writes by hand. The answer decides the package's name and what it depends on.

**Whether the resource has more than one manifest language.** An API Gateway route can be written in CloudFormation, in a Serverless service file, or in Terraform. So the resource semantics live in `@suss/contract-aws-apigateway`, and each manifest reader normalizes its own format and delegates to it. The Terraform reader does not reimplement API Gateway behavior. When there is no plausible second reader, as with a single OpenAPI document, one package is enough.

Then, for each setting in the format that changes behavior, decide what statuses, headers or bodies it can produce, whether it interacts with the handler's own transitions or is a transition of its own, and what attribution to record.

A transition gated by something outside the reader's view, such as an authorizer's decision or a throttler's state, uses an opaque predicate named `<vendor>:<service>:<contract>`:

```
aws:apigateway:status-401      // platform-injected status from an authorizer
aws:apigateway:status-429      // throttle-induced
stripe:cards:card_declined     // vendor contract
```

With stable namespaces, inspect and diff can group related transitions across readers.

When several settings produce the same status, emit one transition and list every contributor in `metadata.causes`. An authorizer and an API key requirement both produce 403, and a consumer has no way to tell which one fired. To the checker, several transitions for one status mean something different: sub-cases the consumer is expected to tell apart.

When the platform creates a boundary instead of modifying one, emit a standalone summary and set `metadata.synthetic` to a short name for the platform behavior that created it. The API Gateway reader sets it to `"cors-preflight"`. API Gateway with CORS configured responds to OPTIONS on every CORS-enabled path with no handler code behind it, and a consumer calling `fetch(path, { method: "OPTIONS" })` pairs with that summary through the ordinary matching rules.
