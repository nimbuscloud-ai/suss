# Contracts

Your API document says `GET /invoices/:id` returns 200, 404 or 500. The handler has never produced a 500, and somebody in the web app wrote a retry path for one anyway. The panel that renders the invoice treats every 200 as a live invoice, and since last quarter the handler has been sending voided invoices back as 200 as well.

Every one of those is true on its own. The trouble shows up only when you put two of them side by side, and nothing in a normal pipeline does that.

"Contract" is the most overloaded word in suss, and this page is where it gets pinned down. It works through what kind of truth an artifact about code can tell you, then the three contracts that exist at every boundary, then the shapes those contracts arrive in. How bad a finding is follows from the first of those.

Related: [`cross-boundary-checking.md`](cross-boundary-checking.md) for the checker mechanics, [`contract-sources.md`](contract-sources.md) for the readers that turn a declared artifact into summaries, [`boundary-semantics.md`](boundary-semantics.md) for how boundaries themselves vary.

## The three contracts, in one run

Here is that invoice endpoint as three files. The contract is a ts-rest router, so the declaration lives in the repo beside the code. An OpenAPI document read with `suss contract --from openapi` plays the same part.

```ts
// src/contract.ts
export const contract = c.router({
  getInvoice: {
    method: "GET",
    path: "/invoices/:id",
    responses: {
      200: c.type<{ id: string; total: number; state: string }>(),
      404: c.type<{ error: string }>(),
      500: c.type<{ error: string }>(),
    },
  },
});
```

```ts
// src/handler.ts
export const router = s.router(contract, {
  getInvoice: async ({ params }) => {
    const invoice = await findInvoice(params.id);

    if (!invoice) {
      return { status: 404 as const, body: { error: "not found" } };
    }

    if (invoice.voidedAt) {
      return {
        status: 200 as const,
        body: { id: invoice.id, total: 0, state: "void" },
      };
    }

    return {
      status: 200 as const,
      body: { id: invoice.id, total: invoice.total, state: "open" },
    };
  },
});
```

```ts
// src/invoicePanel.ts
export async function loadInvoice(id: string) {
  const response = await fetch(`/invoices/${id}`);

  if (response.status === 200) {
    const invoice = await response.json();
    return { total: invoice.total };
  }

  throw new Error("could not load invoice");
}
```

Read both sides with `suss extract -f ts-rest -f fetch -o summaries/all.json`, which writes three summaries, then print them:

```bash
suss inspect summaries/all.json
```

```
src/handler.ts
└─ GET /invoices/{id}  (ts-rest handler | line 8)
     Contract: 200, 404, 500
       if  !findInvoice()
         -> 404 { error }
       elif  findInvoice().voidedAt
         -> 200 { id, total, state }
       else
         -> 200 { id, total, state }
           + src/db.findInvoice →

     Reaches:
       invocation findInvoice

       !! Declared response 500 is never produced by the handler

src/invoicePanel.ts
└─ GET /invoices/{id}  (fetch client | line 1)
       if  fetch().status === 200
         -> return { total }
       else
         -> throw Error
           + fetch
           + response.json

     Reaches:
       interaction GET /invoices/{id}
       invocation fetch
       invocation response.json

src/db.ts
└─ findInvoice  (reachable library | line 5)
       -> return Invoice (src/db.ts)

3 summaries.
```

All three contracts are in that output. `Contract: 200, 404, 500` is the declaration, read off the router. Under the handler are the branches it actually takes, and under the client are the ones the panel depends on. `check` compares them pairwise:

```bash
suss check --dir summaries/
```

```
Compared 1 boundary.

  1 boundary had nothing to pair with, so nothing was checked across it.
  Run the same command with --all to list them.

────────────────────────────────────────────────────────────
[ERROR] providerContractViolation
  Declared response 500 is never produced by the handler
  provider: src/handler.ts::getInvoice (src/handler.ts:8)
  consumer: src/invoicePanel.ts::loadInvoice (src/invoicePanel.ts:1)
  boundary: ts-rest (http) GET /invoices/:id
────────────────────────────────────────────────────────────
7 findings: 1 error, 6 warning, 0 info

Not shown: 4 unhandledProviderCase (warning), 2 consumerContractViolation (warning). Run the same command with --all to see them.

suss met a call it could not follow in one unit, of 3, so that one is described in part. `suss inspect` says which calls.
```

Why the 500 is an error while the other six findings are warnings depends on what each side of the comparison is: a specification, an observation, or a derivation.

## Three kinds of truth

An artifact about code can only answer one sort of question, and which sort decides everything that follows.

| Kind of truth | What it tells you | Examples | Completeness |
|---|---|---|---|
| **Specification** | what should happen | OpenAPI, TypeScript interfaces, Storybook stories, Prisma schemas, CloudFormation templates | Under-specified. Declares what is allowed, and rarely when each case fires |
| **Observation** | what did happen, once | Snapshots, Pact recordings, Playwright tests, production logs | Point-samples. Covers only what was tested |
| **Derivation** | what the code does, across all paths | A suss `BehavioralSummary` | Complete over paths, limited by analyzer fidelity |

The `BehavioralSummary` is the only artifact suss produces itself, and it fills the derivation row. Every declared contract and every contract source suss reads is a specification or an observation.

The interesting findings compare one kind against another:

- **Derivation ⊄ Specification**: the code takes a path the specification never declares. The handler produces a 500 that OpenAPI does not mention.
- **Specification ⊄ Derivation**: the specification declares a case the code cannot reach. That is the error in the run above.
- **Observation ⊄ Derivation**: something happened that the code should not be able to produce. Rare, high signal, usually a bug.
- **Derivation ⊄ Observation**: the code reaches paths no test covered. A coverage signal rather than a finding.

Each pair has its own severity and its own owner, and the severity comes from the kinds of truth involved rather than from the file format the contract arrived in. [Severity follows the kind of truth](#severity-follows-the-kind-of-truth) below spells that out.

## The three contracts at a boundary

Every API boundary has three behavioral contracts whether or not anyone writes them down. The checker compares them pairwise, and each comparison catches a different class of failure. Which checker function fires for which comparison is in [`cross-boundary-checking.md`](cross-boundary-checking.md).

### 1. The declared contract, authored and optional

ts-rest `responses`, an OpenAPI schema, a GraphQL SDL. It says which statuses and body structures are supposed to exist. This is a **specification**, and it is what most tools check against. A person wrote it, so it can be wrong, incomplete, or a year out of date. When it exists it is the one thing the provider team and the consumer team both point at.

In the run above this is `Contract: 200, 404, 500`, read straight off the ts-rest router.

### 2. The provider's inferred contract, a derivation

The set of transitions the provider actually produces: under condition A output X, under condition B output Y. It says more than the declaration in three ways.

- **Sub-cases inside one status code.** The declaration says 200 returns an invoice. The derivation says 200 returns `{ total: 0, state: "void" }` when `invoice.voidedAt` is set, and `{ total, state: "open" }` otherwise. The declaration collapses two behaviors into one.
- **A body that varies per condition.** Each transition has its own `Output.body`.
- **Gaps.** The declaration says 500 is possible and the implementation never produces it, or the implementation returns 418 and the declaration never mentions it.

### 3. The consumer's inferred contract, a derivation

What the consumer depends on: which status codes it branches on, which body fields it reads, which conditions it tests on the response. Nobody writes this one down. It is not in OpenAPI, not in the types, and not in a Pact test unless somebody thought to write that exact example. It is the contract that causes an incident when it breaks. suss reads it out of the consumer's own source:

- Status branching. `if (response.status === 200)` means the consumer expects 200 as a case, and the run above shows that this consumer expects nothing else.
- Field access. `invoice.total` means the consumer depends on `total` being there.
- Response conditions. `if (invoice.state === "void")` would mean the consumer tells a sub-case apart by a body field. This consumer does not, which is why the run reports the two 200s as one.

## Contract shapes

The three contracts above are HTTP-flavoured. Across domains, contracts arrive in more shapes than "schema", and a substantive domain usually uses several. Each shape is one of the three kinds of truth.

### 1. Schema: what types flow across?

Structural declarations of the interface: types, cardinality, required-ness, enumerated values.

- OpenAPI 3.x, ts-rest `responses`, CFN `MethodResponses`, GraphQL SDL in part
- Prisma schemas, TypeScript interfaces for props
- Message schemas (Avro, Protobuf, JSON Schema), database DDL

**Kind of truth:** specification. It declares what is allowed to cross, and says nothing about when each case fires.

### 2. Examples: what does one valid interaction look like?

Recorded pairs of input and output, or request and response: Pact contracts, HAR captures, fixture files, API docs with curl examples.

**Kind of truth:** observation. It captures what happened once. Coverage is as good as the example set and never better.

### 3. Tests: what should be true when X happens?

Behavioral assertions, usually interaction sequences: Playwright and Cypress specs, RTL component tests, supertest integration tests.

**Kind of truth:** observation of asserted behavior under specific inputs. The coverage limit is the same one Examples have.

### 4. Snapshots: what did the output look like?

Serialized captures of output for specific inputs: Jest and Vitest `.snap` files, visual-regression baselines, golden query results.

**Kind of truth:** observation, plus a regression anchor. "This output is what we agreed to yesterday, tell me when it changes." It covers structure only, for the inputs that were tested.

### 5. Design: what should this look like or do?

Design artifacts upstream of the code: Figma and Sketch files, design tokens, prototypes, accessibility specifications.

**Kind of truth:** intent. It declares what the output should be whether or not any code exists. It usually covers the visual and interactive side only, and business logic is invisible in a design file.

## How suss absorbs contracts today

Everything shipped today is a **specification**: schema-shaped artifacts across the HTTP, GraphQL, AppSync, message-bus, storage and component domains. Point `suss contract --from <source>` at one and you get summaries in the same form `extract` produces. A CloudFormation template, for example:

<!-- suss:example fixtures=aws-lambda -->

```bash
suss contract --from cloudformation fixtures/aws-lambda/template.yaml -o cfn.json
suss inspect cfn.json
```

That template declares 32 summaries, six of them routes. One route, with the other 31 cut:

<!-- suss:excerpt -->

```
cloudformation:fixtures/aws-lambda/template.yaml:ListWidgetsFunction:List
└─ GET /widgets  (apigateway handler | line 0)
     Contract:
       if  aws:apigateway:status-504
         -> 504  !! undeclared
       elif  aws:apigateway:status-502
         -> 502  !! undeclared
```

Those two statuses are not in anybody's handler. API Gateway produces them itself, on an integration timeout and an integration failure, and a caller receives them the same as any other response. The template is the only place they are written down. [`pipelines.md`](pipelines.md) shows the whole run and what the other 26 summaries are.

The readers that ship:

- `@suss/contract-openapi`, OpenAPI 3.x (schema, HTTP)
- `@suss/contract-cloudformation`, CFN and SAM templates with API Gateway resources (schema, HTTP), built on the internal `@suss/contract-aws-apigateway` shared library
- `@suss/contract-appsync`, CFN templates with `AWS::AppSync::*` resources and the SAM `AWS::Serverless::GraphQLApi` shorthand (schema, GraphQL)
- `@suss/contract-graphql`, plain GraphQL SDL files (schema, GraphQL), plus committed `.graphql` and `.gql` operation documents through `--from graphql-documents` (spec, GraphQL). Each query, mutation and subscription becomes a client-kind summary that pairs against resolver summaries without any call-site tracing
- `@suss/contract-serverless`, Serverless Framework service files (schema, HTTP and message bus). The reader restates the `functions` block in SAM's forms and hands it to the CloudFormation reader, so a route or a queue consumer comes out the same whichever manifest language declared it
- `@suss/contract-terraform`, a Terraform configuration, one `.tf` file or the directory a module lives in (schema, across whichever resources the AWS and GCP provider data cover)
- `@suss/contract-wrangler`, a Cloudflare Worker's `wrangler.toml` or `wrangler.jsonc` (schema, the Worker's own configuration plus a summary per KV namespace, R2 bucket, D1 database and Queues channel it is bound to)
- `@suss/contract-prisma`, `schema.prisma` files (schema, storage)
- `@suss/contract-storybook`, CSF3 `.stories.tsx` files (spec, component domain)

Framework packs also read a declaration straight out of the source, which is how `Contract: 200, 404, 500` reached the invoice summary above. ts-rest `responses`, Apollo and NestJS GraphQL `typeDefs`, and ts-rest-zod schemas all populate per-protocol contract metadata at extraction time.

The comparison checkers in `@suss/checker` work per protocol: HTTP schema against derived transitions, GraphQL contract agreement, message-bus producer against consumer, storage access against a Prisma schema, env-var config, Storybook stories against the React component. The mechanics are in [`cross-boundary-checking.md`](cross-boundary-checking.md).

Three shapes have no reader yet:

- **Observation shapes.** No reader ingests Jest snapshots, Playwright traces or production observability data. One observation does reach a summary, and it comes from running the code. `suss corroborate --experimental` generates inputs that satisfy a claim's own conditions and runs the handler on them. The verdict goes in `confidence.corroboration`: `observed` when every run agreed, `refuted` with the input that disagreed, or `untested` when nothing produced a verdict. `ConfidenceSource` has no `observation` value, because corroboration adds evidence to a derivation instead of being an artifact of its own.
- **Test shapes.** The same gap. RSpec, supertest and RTL assertions are not a source.
- **Design shapes.** Figma and design-token integration is deferred on purpose. Design files rarely live in the repo, and the API integration costs more than the signal is worth. Design stays in the taxonomy because intent is a kind of truth the others do not cover, and no reader for it is planned.

## Intent

Intent is partly shipped. It has an artifact stream of its own, separate from the contract sources above.

Team-authored intent specs (`*.intent` and `*.prd`, read by `@suss/contract-intent`) parse to `IntentSummary` rather than `BehavioralSummary`, and `@suss/checker-intent` pairs them against derived code through `suss check --dir summaries/ --intent intent/`. There are two kinds:

- **System intent** (`*.intent`), the contract a boundary should satisfy, structural and machine-comparable: "`POST /auth/login` returns 429 with `{ error, retryAfter }`".
- **Outcome intent** (`*.prd`), what should happen for the user, scenario-shaped: "a rate-limited request gets a friendly rejection", with scenarios that can link to system-intent outcomes.

Third-party schemas express some intent, but an OpenAPI document was authored as a wire contract and a Prisma schema as a data model, not as a statement of what the team wanted. That is why intent docs are **open** specifications. They set a floor, what must exist, rather than a closed list of everything allowed. Code that exceeds intent is possibly-missing intent, reported as info rather than as a violation. Boundary-level intent checks ship today, and PRD scenario coverage ships alongside them.

## Severity follows the kind of truth

Severity comes from the kinds of truth being compared, not from the format the contract arrived in:

- Derivation violates a specification → `error`. The code has drifted from what it promised. That is the `providerContractViolation` in the invoice run: the router promises a 500 and no branch produces one.
- Observation violates a specification → `warning`. Something happened that the spec said could not.
- Observation missing for a specification case → `info`. A coverage gap rather than a bug.
- Two specifications disagree → `warning`. Somebody has to reconcile them. This is the `contractDisagreement` finding.

Two derivations disagreeing with each other is a warning, which is why the other six findings in the invoice run are warnings. Whether an uncovered status is a defect depends on intent the code does not state, so the run reports it and leaves the call to you.

The same rule assigns intent severities: a derivation that violates declared system intent is an error, and a derivation that exceeds open intent is info. These are heuristics and we refine them as more shapes ship. Not every combination is meaningful, and not every one needs the same severity.

## Metadata namespacing

A declaration lives under the protocol it describes, whichever pipeline produced it. A GraphQL contract read from an SDL file and one read from Apollo's `typeDefs` both land in `metadata.graphql.declaredContract`, so the checker never asks where it came from. The namespaces in use:

- `metadata.http.*`: declaredContract, statusAccessors, bodyAccessors, statusRange
- `metadata.graphql.*`: declaredContract, document, schemaSdl
- `metadata.appsync.*`: kind, UNIT or PIPELINE
- `metadata.sourceDocument.label`: which document a summary was read out of
- `metadata.storybook.*` and `metadata.component.*`: story-level and component-context metadata

A new protocol adds its own `metadata.<protocol>.*` namespace rather than nesting by source. The checker reads the namespace it understands and downstream tooling ignores the rest.

`metadata.sourceDocument` is the exception to protocol scoping, because it says nothing about a protocol. One document declares many boundaries and states things every one of them relies on. A GraphQL schema is the case that ships: the reader emits one summary standing for the schema document, puts the SDL on it at `metadata.graphql.schemaSdl`, and gives every summary read out of that document the same label. The checker walks from a resolver to its document to read the schema, so the schema is written down once instead of being repeated on every one of a large schema's hundreds of root fields. An OpenAPI document's `components.schemas` and a CloudFormation template's parameters have the same shape and are not read this way yet.

## How new domains get added

Adding a domain, React or Postgres or Kafka, is four questions:

1. **What is the boundary?** Component and DOM, code and database, producer and queue.
2. **What is the observable channel?** The DOM tree plus events, a SQL query plus its result set, a message envelope.
3. **Which contract shapes exist in this domain?** List them from the five above, and say which are common and which are missing.
4. **Which shapes feed a meaningful check against which other shapes?** Not every combination is useful, so we design that per domain.

For each domain suss ships an extractor (a pattern pack plus adapter support), one or more contract-source readers for the dominant shapes, and the checker extensions for the comparisons worth making. Shipping all three at once is not required.

## What this page commits us to

- No checker logic assumes a contract is schema-shaped. Every check says which shapes it operates on.
- The `@suss/contract-*` naming stays as the surface for new readers, one package per source.
- Metadata namespacing follows the protocol-first convention, `metadata.<protocol>.*`.
- The five-shape taxonomy is the working vocabulary. When a concrete artifact does not fit, we change the taxonomy rather than forcing the artifact into a slot.
- The interesting cross-shape comparisons are protocol-specific. Generalisation happens from the bottom up, not as a universal framework designed in advance.
