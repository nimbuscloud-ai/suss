---
title: What each suss command does, step by step
description: Trace extract, contract, check and ask end to end, with a run at each stage to compare your own output against.
---

# Pipelines

A run gave you something you did not expect: a summary with no branches in it, or a route that paired with nothing. The cause is nearly always one step between your files and the output, and working out which step should not need a trip through the source. Each command below is traced end to end, with a run at each stage to compare yours against.

For the static package picture, see [`architecture.md`](architecture.md). For what a finding means, see [`cross-boundary-checking.md`](cross-boundary-checking.md).

## `suss extract`

Turns a project into `BehavioralSummary[]`.

The CLI parses the flags and hands off. `@suss/adapter-typescript` builds a ts-morph `Project` from the given `tsconfig`, walks the source files, and looks for discovery matches from each pack it was given. A discovery match identifies one code unit: a handler, a client call site, a loader.

Each matched unit then goes through the five extraction steps in [`extraction-algorithm.md`](extraction-algorithm.md). The adapter finds the terminals, enumerates the paths that reach each one, reads the conditions along each path, turns those conditions into predicates, and assembles a branch. It reads the contract too, when the pack declares one. What comes out per unit is a `RawCodeStructure`: plain data with no AST references, ready to be serialized or tested against a fixture.

`@suss/extractor.assembleSummary` then normalizes each `RawCodeStructure` into a `BehavioralSummary`. It wraps un-decomposed conditions as `opaque` and records a gap wherever the contract and the code disagree, or wherever a return matched no terminal pattern. Then it assesses confidence and assembles the summary. The CLI collects the array, parses it back through the IR validator as a sanity check, and writes it to disk.

Python and Ruby take the same route through `@suss/adapter-python` and `@suss/adapter-ruby`, which parse with tree-sitter instead of ts-morph and emit the same `RawCodeStructure`. `--lang` says which one to use, and when you leave the flag off suss works it out from what the directory contains.

<!-- suss:unchecked it runs against gothinkster/node-express-realworld-example-app, which this repository does not check in -->

Here it is over an Express and Prisma API, [gothinkster/node-express-realworld-example-app](https://github.com/gothinkster/node-express-realworld-example-app), with `--explain` to print the counts behind the total:

```bash
suss extract -p tsconfig.app.json -f express -f axios -f prisma --explain -o summaries/code.json
```

```
  Where these came from:
    26  files in the tsconfig
    13  files read
     7  files importing express
    20  boundaries recognized by express
    20  summaries from express
    20  of those, summaries saying what express does
     0  files importing axios
     0  boundaries recognized by axios
     0  summaries from axios
     0  of those, summaries saying what axios does
    12  files importing @prisma/client
    20  unit bodies prisma could look inside
    79  effects prisma recognized
```

Above that, `extract` prints one success line, `Wrote 46 summaries to <path> in 0.88s`, with the absolute path of the file it wrote and an elapsed time that moves from run to run.

Read the funnel from the top. 26 files were in the tsconfig and 13 survived the pre-filter, which skips a file when it imports nothing any pack is looking for. Seven of those import express, and express found 20 routes in them. The axios column is all zeroes because this repository lists axios in its `package.json` and never calls it, which is what a pack that found nothing looks like. Prisma discovers no boundaries of its own, because it is made of recognizers: it looked inside the 20 units express found and recognized 79 database calls in them.

`--timing` says where the time went, one row per phase, ordered by cost. The milliseconds differ on every run and the rows below a millisecond swap places, so read the shares rather than the numbers:

```
Timing:
     360ms   41.6%  preFilter
     355ms   41.1%  extract per-file
      82ms    9.5%  expandReachableClosure
      34ms    3.9%  loadImportGraphs
      16ms    1.9%  lazyProjectInit
       6ms    0.7%  mountPrefix
       5ms    0.6%  enrichRethrows
       2ms    0.2%  readTsconfigFileList
       2ms    0.2%  stampGraphqlClientRefs
       1ms    0.2%  deriveBoundaryEffects
       1ms    0.1%  stampModuleImports
       0ms    0.0%  synthesizeSubUnits
       0ms    0.0%  liftSchemasOntoDocuments
       0ms    0.0%  expandWrapperCallers
       0ms    0.0%  project.getSourceFiles
       0ms    0.0%  cache.merge
       0ms    0.0%  cache.write
       0ms    0.0%  emitLibraryEnvReadMarkers
       0ms    0.0%  warmExportChains
       0ms    0.0%  cache.lookup
     865ms  100.0%  total
  cache: miss (no-manifest)
```

Deciding which files a pack could match costs as much as extracting from the ones that survive, which is why the pre-filter exists at all. The last line says whether the run reused a previous one; `--no-cache` forces the miss shown here.

The same run as a sketch, from the command down to the file it writes:

```
User
 │  suss extract -p tsconfig.json -f ts-rest -o out.json
 ▼
@suss/cli
 │
 ▼
@suss/adapter-typescript
 │  build ts-morph Project from tsconfig
 │
 │  for each source file:
 │    for each pack (ts-rest, axios, …):
 │      discovery.patterns → matched code units
 │      for each unit:
 │        run the 5 extraction steps (terminals, paths, conditions,
 │                                    predicates, assembly)
 │        produce RawCodeStructure
 │        │
 │        ▼
 │      @suss/extractor.assembleSummary(raw)
 │        wraps opaque predicates, detects gaps, assesses confidence
 │        ▼
 │      BehavioralSummary
 │
 ▼
BehavioralSummary[] → write out.json
```

The adapter and extractor split is the invariant this pipeline is built on: the adapter owns everything that touches the AST, and the extractor never sees a node. Adding a language means writing a new adapter that emits `RawCodeStructure`, and the extractor does not change. That is how Python and Ruby arrived.

## `suss inspect`

Renders summaries in a form meant for people.

`suss inspect summaries.json` loads the file, runs it through `safeParseSummaries` so any malformed JSON fails with a path-pointed error before anything renders, then formats each summary as a tree of transitions with their conditions, outputs and gaps. One summary out of a three-summary file, with the other two cut:

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
```

Three things in that block are notation rather than content, and they come up in every rendering.

A line starting `+` is an **effect**: something the branch does besides producing its output. `+ src/db.findInvoice →` says this branch calls `findInvoice`, and the arrow says that callee has a summary of its own in the same run, so you can go and read it. The name comes with a path when the callee lives in another file, which is why this one reads `src/db.findInvoice` rather than plain `findInvoice`.

**Reaches** collects the same effects for the whole unit, so you can see everything a handler touches without reading down its branches.

A line starting `!!` is a **gap**: something suss could not settle, written down instead of dropped. This one is the contract promising a 500 that no branch produces. A gap in the output is the difference between "there is nothing here" and "suss could not tell", and keeping them apart is why an empty answer never looks like an all-clear.

`suss inspect --diff before.json after.json` and `suss inspect --dir summaries/` are variants over the same load-and-parse plumbing. The first uses `diffSummaries` to compute added, removed and changed transitions per summary pair. The second uses `pairSummaries` to show which summaries face which, and which ones matched nothing.

<!-- suss:unchecked the two summary files it compares are a sketch, so there is nothing on disk to run it over -->

`--diff` is the mode a pull request wants. Add one branch to an Express route so admins get an extra field, read the route again into `after/api.json`, then compare it against the file from before the change:

```bash
suss inspect --diff before/api.json after/api.json
```

```
handler:GET /users/{id}
  express handler
  2 changes
    + 200 { id, name, role, admin }  when  db.findById() && db.findById().role === "admin"
    ~ 200 { id, name, role }  when  db.findById()
      -> 200 { id, name, role }  when  db.findById() && !(db.findById().role === "admin")
```

Two changes from one added `if`. The admin case is new, and the plain 200 is the same response under a narrower condition: it is now the case where the user exists and is not an admin. A `~` line is a transition that kept its output and changed its guard, printed with the guard from before and the guard from after, so a reader can tell a narrowed branch from a branch that went away.

A handler is paired with the one before it by its route, so a renamed handler on the same route pairs, and a route that moved to another path prints as removed and added. A client is paired by its own name under the route it calls, since several callers share one route, and its key reads `client:GET /pet/{petId}::getPetById`.

All three modes share one failure path. If `safeParseSummaries` reports issues, the CLI prints `Invalid summary file <path>: <issue paths>` and exits non-zero, and nothing renders.

## `suss check`

Pairs providers with consumers and emits findings.

The CLI loads the files through `safeParseSummaries`, the same validation path `inspect` uses, then calls `checkPair(provider, consumer)`. That runs seven independent check functions one after another and concatenates their findings:

- `checkProviderCoverage`: does the consumer handle every status code the provider produces? It also looks at sub-cases within one status, where the provider's branches are told apart by a predicate the consumer never tests.
- `checkResponseMisread`: does a consumer path read a body field off a response that does not include it, with nothing on that path telling that response apart from the one that does? The read comes back undefined and nothing throws.
- `checkConsumerSatisfaction`: does the consumer handle status codes the provider never produces? Those are dead branches.
- `checkContractConsistency`: is the handler's behavior consistent with the contract attached to it, a ts-rest `responses` block or an OpenAPI schema?
- `checkConsumerContract`: does the consumer read fields the declared contract never promised, so it depends on an undeclared implementation detail?
- `checkBodyCompatibility`: do the consumer's body-field reads line up with the bodies the provider produces, per status?
- `checkSemanticBridging`: does the provider produce a distinguishing literal or a field-presence discriminator that the consumer collapses into one branch?

Each check is pure over `(provider, consumer)`, emits `Finding[]`, and knows nothing about the other six. The findings are then rendered, human-readable or JSON, and the exit code comes from `--fail-on`: `error`, `warning`, `info` or `none`.

`suss check --dir summaries/` is the same flow with a step in front. `pairSummaries` groups every summary by its boundary key and by its role from `BOUNDARY_ROLE[kind]`, and produces matched pairs plus buckets of unmatched providers, unmatched consumers, and summaries that took no part. `checkPair` runs on each matched pair.

<!-- suss:unchecked it runs against gothinkster/node-express-realworld-example-app, which this repository does not check in -->

Over the same Express and Prisma API, with the schema read into the same folder by `suss contract --from prisma src/prisma/schema.prisma -o summaries/prisma.json`:

```bash
suss check --dir summaries/
```

```
Compared 4 boundaries.

  20 provider-side boundaries have no client to compare against.
  5 boundaries had nothing to pair with, so nothing was checked across them.
  Run the same command with --all to list them.

3 findings: 0 error, 3 warning, 0 info

Not shown: 3 boundaryFieldUnused (warning). Run the same command with --all to see them.

suss met a call it could not follow in 19 units, of 50, so those are described in part. `suss inspect` says which calls.
```

The four boundaries compared are the four Prisma models, each against every query that reads or writes it. The 20 uncompared providers are the HTTP routes: the front end for this API is in another repository, so nothing in this run is on the other side of them. The five that paired with nothing are `function-call:reachable` helpers, functions a route reaches and nobody imports, so no boundary key addresses them. Each of those three lines is a different reason for silence, which is why the run keeps them apart.

The grouping in `pairSummaries` only knows the method and the path, so a store, a queue and a runtime's configuration all come back unpaired from it. Each of those has a pass of its own, and each records what it compared into the same `pairs` list. `checkAll` drops those from the unmatched buckets afterwards, which is what stops one table being reported as compared and unpaired in the same run.

<svg class="suss-diagram" viewBox="0 0 660 356" role="img" aria-labelledby="check-title check-desc">
  <title id="check-title">How a folder of summaries becomes findings</title>
  <desc id="check-desc">Every summary in the folder is grouped by its boundary key and by whether it provides or consumes. Groups holding both sides become pairs, which run through seven independent checks. Groups holding one side are reported as waiting for a counterpart.</desc>

  <defs>
    <marker id="check-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <text class="axis" x="330" y="14" text-anchor="middle">summaries/</text>
  <rect class="box-data" x="150" y="24" width="80" height="30" rx="5" />
  <text class="label-mono" x="190" y="43" text-anchor="middle">api.json</text>
  <rect class="box-data" x="240" y="24" width="80" height="30" rx="5" />
  <text class="label-mono" x="280" y="43" text-anchor="middle">web.json</text>
  <rect class="box-data" x="330" y="24" width="90" height="30" rx="5" />
  <text class="label-mono" x="375" y="43" text-anchor="middle">stripe.json</text>
  <rect class="box-data" x="430" y="24" width="80" height="30" rx="5" />
  <text class="note" x="470" y="43" text-anchor="middle">and so on</text>

  <line class="arrow" x1="330" y1="54" x2="330" y2="76" marker-end="url(#check-arrow)" />

  <rect class="box" x="140" y="82" width="380" height="56" rx="6" />
  <text class="label" x="330" y="102" text-anchor="middle">Group every summary by the boundary it describes</text>
  <text class="note" x="330" y="119" text-anchor="middle">the key is (method, path) for HTTP, and each summary is</text>
  <text class="note" x="330" y="133" text-anchor="middle">either the side that provides it or the side that calls it</text>

  <line class="arrow" x1="260" y1="138" x2="220" y2="176" marker-end="url(#check-arrow)" />
  <line class="arrow" x1="400" y1="138" x2="490" y2="176" marker-end="url(#check-arrow)" />

  <rect class="box" x="30" y="182" width="380" height="40" rx="6" />
  <text class="label" x="220" y="200" text-anchor="middle">Both sides present</text>
  <text class="note" x="220" y="215" text-anchor="middle">one pair per group</text>

  <rect class="box" x="430" y="182" width="210" height="40" rx="6" />
  <text class="label" x="535" y="200" text-anchor="middle">One side only</text>
  <text class="note" x="535" y="215" text-anchor="middle">reported, not compared</text>

  <line class="arrow" x1="220" y1="222" x2="220" y2="244" marker-end="url(#check-arrow)" />

  <rect class="box" x="30" y="250" width="380" height="70" rx="6" />
  <text class="label" x="220" y="269" text-anchor="middle">Seven checks, each reading only this pair</text>
  <text class="note" x="220" y="286" text-anchor="middle">statuses in both directions, sub-cases within a status, body</text>
  <text class="note" x="220" y="300" text-anchor="middle">fields, misread fields, the contract, and semantic bridging</text>
  <text class="note" x="220" y="314" text-anchor="middle">none of them can see what another found</text>

  <line class="arrow" x1="220" y1="320" x2="220" y2="340" marker-end="url(#check-arrow)" />
  <text class="label" x="220" y="352" text-anchor="middle">Findings</text>
</svg>

A boundary's **semantics** is what kind of meeting point it is: a REST route, a GraphQL field, a queue subject, a database table. Each kind knows two things about itself. It knows what key its two sides pair by, and it knows what counts as those two sides agreeing. Pairing asks the semantics for both rather than branching on the protocol, which is why adding a kind of boundary never touches the pairing code. See [`boundary-semantics.md`](boundary-semantics.md).

## `suss contract --from openapi`

Turns an OpenAPI 3.x document into `BehavioralSummary[]` marked `confidence.source: "derived"`. The output is in the same form `suss extract` produces, and it pairs with extracted consumers.

`@suss/contract-openapi` walks every `(path, operation)` in the document. For each operation it emits one handler summary with one transition per declared response, the status code plus the body schema converted to a `TypeShape`, `metadata.http.declaredContract` populated so `checkContractConsistency` can cross-check a provider you extract later, and `confidence.source: "derived"` so a downstream reader knows where it came from.

<!-- suss:unchecked the command that writes the file it reads is in the prose above rather than in a block, so there is nothing to run first -->

Over the Petstore document in `examples/petstore-axios-openapi`, `suss contract --from openapi petstore-openapi.json -o out/provider.json` writes 19 summaries, one per operation. Reading them back:

```bash
suss inspect out/provider.json
```

The first two of the nineteen, with the rest cut:

```
openapi:petstore-openapi.json
├─ PUT /pet  (openapi handler | line 0)
│    Contract: 200, 400, 404, 422, default
│      -> 200 { id, name, category, photoUrls, ... }
│      -> 400
│      -> 404
│      -> 422
│      -> default
│
├─ POST /pet  (openapi handler | line 0)
│    Contract: 200, 400, 422, default
│      -> 200 { id, name, category, photoUrls, ... }
│      -> 400
│      -> 422
│      -> default
```

The run ends with `19 summaries.`, which is the count to check against your own document's operation count when a route goes missing.

The lines with no shape after the status are the responses Petstore declares with no schema. They still become transitions, because a caller has to handle a 400 whether or not anybody wrote down what is in it. These summaries came out of a document rather than out of source, so there is no line in a source file to point at and the location reads `line 0`.

The CLI writes the result to disk after round-tripping it through `safeParseSummaries`, to catch any drift in the structure.

## `suss contract --from cloudformation`

This is the most layered of the contract readers, because one physical API can be written several ways in CloudFormation and all of them should produce the same summaries.

Three layers, separated on purpose. Parsing the raw template, turning a file on disk into plain data and resolving CloudFormation's intrinsic YAML tags, lives in `@suss/manifest-aws`, shared with the manifest-driven framework packs. On top of it, the **manifest-reader** layer in `@suss/contract-cloudformation` walks the parsed tree and builds normalized `RestApiConfig` and `HttpApiConfig` values: which API this is, which endpoints, which authorizer, CORS, throttle, and integration config. That happens in `buildRestApiConfigs`, `buildHttpApiConfigs`, `readSamApiEvents`, `readSamHttpApiEvents` and `readCors`, and it is pure grouping. It handles `AWS::ApiGateway::RestApi` plus `AWS::ApiGateway::Method`, `AWS::ApiGatewayV2::Api` plus `Route` plus `Integration`, the SAM `AWS::Serverless::Api` and `AWS::Serverless::HttpApi` shorthand, and SAM `Events.Api` and `Events.HttpApi` blocks. It also handles an inline OpenAPI body on a RestApi.

The **resource-semantics** layer turns each normalized config into `BehavioralSummary[]` with the transitions the platform injects: 401 and 403 from an authorizer, 403 from an API key, 400 from a request validator, 429 from a throttle, 502 and 504 from the integration, and an OPTIONS preflight for CORS. That logic is `restApiToSummaries` and `httpApiToSummaries` in `@suss/contract-aws-apigateway`, which you can use on its own, so a hand-authored API Gateway path with no CloudFormation involved would go straight into the semantics layer. When the manifest has an inline OpenAPI body, the CloudFormation reader hands that part to `@suss/contract-openapi` instead.

Over the SAM template in `fixtures/aws-lambda`:

<!-- suss:example fixtures=aws-lambda -->

```bash
suss contract --from cloudformation fixtures/aws-lambda/template.yaml -o cfn.json
suss inspect cfn.json
```

That template gives 29 summaries, and `inspect` prints all of them, about a hundred lines. Six are routes, and each looks like this:

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

Neither status is in the Lambda. API Gateway produces the 504 on an integration timeout and the 502 on an integration failure, and a caller receives both the same as any other response. The template is the only place they are written down, which is the whole reason this reader exists. `Contract:` is empty because this route declares no responses of its own, and `!! undeclared` on each line says the same thing from the other side: the status is one the declaration never mentions.

The other 23 are the template's own resources, printed as one tree under the template's name. Here is where that tree starts:

<!-- suss:excerpt -->

```
cloudformation:fixtures/aws-lambda/template.yaml
├─ ConfirmTokenFunction  (cloudformation library | line 1)
│
├─ ListWidgetsFunction  (cloudformation library | line 1)
│
├─ WidgetItemFunction  (cloudformation library | line 1)
```

and where it ends:

<!-- suss:excerpt -->

```
├─ ScheduledSyncFunction.Nightly → eventbridge schedule:ScheduledSyncFunction.Nightly  (cloudformation consumer | line 1)
│
└─ MixedTriggerFunction.Sweep → eventbridge schedule:MixedTriggerFunction.Sweep  (cloudformation consumer | line 1)

29 summaries.
```

A Lambda becomes a `library` summary and a queue becomes one too. The wiring between them becomes a `consumer` summary that says which function reads which queue, and one of those reads `OrderIndexerFunction.Orders → aws_sqs default#order.placed`: the template routes that EventBridge subject into a queue, and that queue feeds that Lambda, so the reader followed the rule to the queue to the function. The `29 summaries.` line at the end is the count to check when a resource you expected goes missing.

The three layers, and why each one is separate:

<svg class="suss-diagram" viewBox="0 0 660 316" role="img" aria-labelledby="cfn-title cfn-desc">
  <title id="cfn-title">The three layers of the CloudFormation reader</title>
  <desc id="cfn-desc">A template is parsed once into plain data, grouped into normalized API configurations, then turned into summaries with the statuses API Gateway itself produces. Each layer lives in its own package so the layer above it can be reached without the layers below.</desc>

  <defs>
    <marker id="cfn-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <rect class="box-data" x="215" y="8" width="230" height="30" rx="6" />
  <text class="label-mono" x="330" y="27" text-anchor="middle">template.yaml</text>
  <line class="arrow" x1="330" y1="38" x2="330" y2="58" marker-end="url(#cfn-arrow)" />

  <rect class="box" x="120" y="64" width="420" height="56" rx="6" />
  <text class="label" x="330" y="84" text-anchor="middle">Parse the template</text>
  <text class="note" x="330" y="101" text-anchor="middle">a file becomes plain data, resolving CloudFormation's own tags</text>
  <text class="label-mono" x="330" y="116" text-anchor="middle">@suss/manifest-aws</text>
  <line class="arrow" x1="330" y1="120" x2="330" y2="140" marker-end="url(#cfn-arrow)" />

  <rect class="box" x="120" y="146" width="420" height="70" rx="6" />
  <text class="label" x="330" y="166" text-anchor="middle">Group it into one shape per API</text>
  <text class="note" x="330" y="183" text-anchor="middle">a REST API, an HTTP API, and the SAM shorthand for either</text>
  <text class="note" x="330" y="198" text-anchor="middle">all describe the same thing, so they normalize to one config</text>
  <text class="label-mono" x="330" y="213" text-anchor="middle">@suss/contract-cloudformation</text>
  <line class="arrow" x1="330" y1="216" x2="330" y2="236" marker-end="url(#cfn-arrow)" />

  <rect class="box" x="120" y="242" width="420" height="70" rx="6" />
  <text class="label" x="330" y="262" text-anchor="middle">Say what the gateway returns</text>
  <text class="note" x="330" y="279" text-anchor="middle">401 and 403 from an authorizer, 429 from a throttle, 504 on timeout:</text>
  <text class="note" x="330" y="294" text-anchor="middle">statuses your handler never writes and your caller still receives</text>
  <text class="label-mono" x="330" y="309" text-anchor="middle">@suss/contract-aws-apigateway</text>

  <line class="seam" x1="548" y1="242" x2="652" y2="242" />
  <text class="note" x="652" y="233" text-anchor="end">usable alone,</text>
  <text class="note" x="652" y="261" text-anchor="end">no template</text>
</svg>

See [`contract-sources.md`](contract-sources.md) for the doctrine behind this split and the opaque-predicate naming convention for transcribed external contracts.

## Internal: `RawCodeStructure` → `BehavioralSummary`

One level below `suss extract`: what `assembleSummary` does.

It reads the raw branches and produces one `Transition` per branch. Structured predicates pass through, and a condition it could not take apart is wrapped as `opaque`, which keeps the source text and marks the branch as one suss read but did not understand.

Each transition gets an ID minted from `(function, terminal kind, status, conditionHash)`. Hashing the condition into the ID is what makes reordering two branches a no-op and rewriting one condition a change, which is the behaviour the `--diff` above shows.

Then it looks for gaps, and there are two kinds worth telling apart. An `unhandledCase` gap means the contract and the code disagree, in either direction: a declared response the handler never produces, or a produced response the contract never declared. That is a fact about the code, and the checker reports it as an error. An `unreadOutcome` gap means a `return` matched none of the pack's terminal patterns, so suss could not tell what that path produces. That is a fact about suss, it forces confidence to `low`, and the checker reports it as info, because failing a build over what the analyzer could not read would punish working code.

With no `unreadOutcome` gap, confidence comes from the ratio of opaque predicates to structured ones. Finally it assembles the summary object, nesting any HTTP-scoped metadata under `metadata.http.*` per the [boundary-semantics](boundary-semantics.md) namespacing convention.

Each step is small, pure over `RawCodeStructure`, and independently testable, which is why the extractor test suite runs in milliseconds and takes no compiler dependency.

## Internal: cross-boundary pairing

Before `suss check --dir` runs `checkPair`, it has to work out which summaries face each other. `pairSummaries` does that in three passes.

1. Bucket each summary. `pairingKey(binding)` gives the bucket. A summary with no boundary binding at all goes to `unmatched.unpairable` with the reason `noBoundary`. A binding whose semantics declares no key goes there too, with `unnamedBoundary`, rather than being forced through a REST-style key. `BOUNDARY_ROLE[summary.kind]` then says which side it is on: provider for a handler, loader, action, middleware, resolver, worker, component or hook, and consumer for a client or a consumer. An unrecognized kind goes to `unpairable` with `unknownKind` rather than crashing, and that guard stays until the zod IR migration makes it unreachable.

2. Within a bucket, settle the rest. Sharing a key is not enough on its own: two REST sides can share a normalized path and use different methods, and two message-bus sides can share a subject and use different buses. `semanticsAgree` decides that, per semantics variant. A consumer that several services all serve produces an `ambiguousProvider` finding and no pair, because pairing it with one of them would compare a caller against a handler it may never reach.

3. Collect what is left. A key with providers and no consumers populates `unmatched.providers`, and the other way round for `unmatched.consumers`.

The result is `{ pairs, unmatched }`. `checkPair` runs on each pair, and the unmatched lists reach the CLI output, which is where the "20 provider-side boundaries have no client" line in the run above comes from.

The key function and the agreement check both come from the binding's semantics variant, imported from `@suss/ir-core`. REST buckets by path and settles the method inside the bucket, GraphQL pairs by the parent type name plus the field, and message-bus pairs by the channel's subject. See [`boundary-semantics.md`](boundary-semantics.md).
