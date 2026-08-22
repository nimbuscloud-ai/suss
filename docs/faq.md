# FAQ

You have a stack that already type-checks, lints, tests and traces. Most of what people ask about suss comes down to where it fits next to those, and what it tells you that they do not.

## What is suss, in one sentence?

Static analysis that works out every path through every function in your code, then pairs those descriptions across boundaries, HTTP, GraphQL, queues, storage, in-process calls, and reports where the two sides disagree.

## What does it look like when it finds something?

An Express route grew a branch for admins. The caller was written before that branch existed:

```ts
// src/routes.ts
if (user.role === "admin") {
  res.json({ ...user, admin: true });
  return;
}

res.json(user);
```

```bash
suss extract -f express -f axios -o summaries/all.json
suss check --dir summaries/
```

```
[WARNING] unhandledProviderCase
  Provider returns status 200 in 2 different situations, and the consumer treats them all the same
  provider: src/routes.ts::get (src/routes.ts:5)
  consumer: src/userCard.ts::getUser (src/userCard.ts:5)
  boundary: express (http) GET /users/:id
```

Both files typecheck, both sides pass their tests, and the two 200s mean different things. [Cross-boundary checking](/cross-boundary-checking) walks that run through in full.

## How is this different from a linter?

A linter matches syntactic patterns: a forbidden call, a missing `await`, an unused variable. It never models what a function produces, so it cannot compare what one function sends with what another expects. A suss finding points at a specific path on one side that disagrees with a specific path on the other, and gives you both file-and-line pairs, as the output above does.

## How is this different from TypeScript?

TypeScript checks the structure of the data. `User` is still `User` whether the user is active, soft-deleted or shadow-banned, and `Response<200, User>` type-checks the same whichever branch of the handler produced it.

Here is a handler where the type is constant and the behavior is not:

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
```

Both 200 branches satisfy the same declared type. One of them sends `total: 0` and `state: "void"`. suss models which branch produced what and under what condition, which is a fact about values rather than about types.

## How is this different from OpenAPI, ts-rest or tRPC?

Those are specifications: somebody wrote down what the API should accept and return. suss is derivation: an extracted description of what the implementation does. They complement each other, and `suss check` pairs them and reports the drift. In the run above, the router declares 500 and no branch produces one:

```
[ERROR] providerContractViolation
  Declared response 500 is never produced by the handler
```

If you have an OpenAPI document, run `suss contract --from openapi` and check it against your handlers' summaries. [Pair against OpenAPI](/guides/pair-against-openapi) walks that through.

## How is this different from tests?

Tests record what happened on the inputs the author thought of. suss records what happens on every reachable path whether or not anyone wrote a test for it. Tests verify behavior with concrete data; suss enumerates the structure of behavior and finds the cases the test set never reaches.

## How is this different from observability?

Observability records what happened at runtime, once. The union of your traces is always a subset of reachable behavior, and you learn about drift after the incident. suss derives the structure of behavior statically, so a case that can fire in production but has not yet still appears in the output.

## What does "behavioral drift" mean?

Two pieces of code, or one piece of code and one declared contract, that used to agree about what crosses a boundary and now do not. The agreement was about behavior rather than types, and the types may not have changed at all.

- A handler used to return `404` for soft-deleted users and now returns `200 { status: "deleted" }`. The caller still takes `200` to mean the user exists and is usable.
- A Prisma write used to set `email` and the schema dropped the column. The type-checker does not catch it because the field is still in the input type. Only the database rejects it, at runtime.
- A queue producer used to send `{ userId: string }` and the consumer parses `userId` as a number. Both compile, both run, until the wrong value gets stored.

## Does it require annotations or changes to my code?

No. suss reads your source as it is today: no decorators, no JSDoc tags, no comments to add, no rewrites. It wants your `tsconfig.json`, so that type resolution matches what your compiler sees, and the packs for your stack.

## What languages does it support?

TypeScript and JavaScript through `@suss/adapter-typescript`, which uses ts-morph. Python through `@suss/adapter-python` and Ruby through `@suss/adapter-ruby`, both of which parse with tree-sitter compiled to WASM, so neither needs an installed interpreter. `suss extract --lang python` and `--lang ruby` reach them, and a directory with a `pyproject.toml` or a `Gemfile.lock` in it is recognized without the flag.

Python reads FastAPI and flask-restx routes and SQLAlchemy queries. Ruby reads graphql-ruby's class-based `field` DSL and ActiveRecord queries. Over this repository's own `fixtures/python-webapp`:

```
myapp/fastapi_app.py
├─ GET /items/{item_id}  (fastapi handler | line 26 | confidence: low)
│      -> 200 TodoResponse
│
└─ POST /items  (fastapi handler | line 31 | confidence: low)
       -> 201 TodoResponse
```

The IR (`@suss/behavioral-ir`) and the checker (`@suss/checker`) know nothing about any of this. They consume `BehavioralSummary[]` JSON, so a Python service and a TypeScript client compare against each other in one `check` run. See [Read a Python or Ruby project](/guides/python-and-ruby) for what each adapter reads and where it stops.

## What is a "boundary"?

Any place where two units of code meet across a contract: an HTTP request going from a client to a handler, a function exported from one module and called from another, a SQL query running against a database schema, a message put on a queue and read by a consumer, a React parent rendering a child with props. The contract can be implicit, a function signature, or explicit, an OpenAPI document or a Prisma schema.

Every boundary has a *provider* side, which produces the output, and a *consumer* side, which acts on it, even when both live in the same process. `suss check --all` prints which summaries it paired at each one:

```
Compared 4 boundaries:
  postgresql:Article
    src/prisma/schema.prisma::Article <-> @api/source::src/app/routes/article/article.service.ts::getArticles
    src/prisma/schema.prisma::Article <-> @api/source::src/app/routes/article/article.service.ts::getFeed
    src/prisma/schema.prisma::Article <-> @api/source::src/app/routes/article/article.service.ts::createArticle
```

There the provider is a Prisma model and the consumers are the queries against it.

## What boundaries are modelled?

suss reads HTTP through Express, Hono, Fastify, NestJS REST, Next.js route handlers, ts-rest, AWS Lambda and Cloudflare Workers, and it reads the calling side through `fetch` and axios. It reads GraphQL through Apollo Server, NestJS GraphQL, AppSync and graphql-ruby, with Apollo Client on the calling side. On the front end it reads React components, event handlers and `useEffect` bodies, plus React Router loaders and actions. For storage it reads Prisma, Drizzle, Mongoose, DynamoDB, S3, GCS, Redis, SQLAlchemy and ActiveRecord. For the message bus it reads SQS and EventBridge producers, and takes the consumer side from CloudFormation event-source mappings. It reads runtime configuration from `process.env` and from the `Environment` blocks that supply it.

The contract readers turn a declared artifact into the same summaries: OpenAPI 3.x, CloudFormation and SAM, Serverless Framework, AppSync, Terraform, wrangler, GraphQL SDL and operation documents, Storybook CSF3, and Prisma schemas. A new boundary is an additive pack. See [Packs](/packs) for the model and [Packages](/reference/packages) for the current list.

## Does it work in monorepos?

Yes. Run `suss extract` once per package with that package's `tsconfig.json`, then `suss check --dir` pairs across the resulting files. The contract commands, `suss contract --from openapi` and the rest, are independent of the source repo, so a spec that lives elsewhere still pairs.

## Does it produce false positives?

Sometimes, and it says out loud where it is unsure. Three things show up in the output:

- **Opaque predicates.** When a branch condition cannot be resolved statically, the predicate is labeled `opaque` with the source text kept. A downstream tool decides whether to count an opaque branch as covered.
- **Unresolved subjects.** When a value's origin cannot be traced, the subject is labeled `unresolved` instead of being dropped.
- **Confidence.** Every summary includes a `confidence` block recording how well the extractor did.

Alongside those, a run says how much of the code it could not follow:

```
suss met a call it could not follow in 19 units, of 50, so those are described in part. `suss inspect` says which calls.
```

Findings are graded `error | warning | info`, and `--fail-on` sets the CI gate. A false positive in the strict sense, a finding about something the code does not do, does happen. The usual cause is a pack that does not know about a wrapper or a recognition pattern, and adding the pattern to the pack is the fix.

## What is the difference between `suss extract` and `suss contract`?

`extract` reads source and derives summaries from the implementation. `contract` reads a declared artifact, an OpenAPI document, a CloudFormation template, a Serverless service file, a Prisma schema, a GraphQL SDL or operation document, a Storybook CSF3 file, and emits summaries in the same form. Both feed `suss check`, which pairs them.

Sometimes `contract` tells you something no handler does. Running it over a SAM template:

```
cloudformation:fixtures/aws-lambda/template.yaml:ListWidgetsFunction:List
└─ GET /widgets  (apigateway handler | line 0)
     Contract:
       if  aws:apigateway:status-504
         -> 504  !! undeclared
       elif  aws:apigateway:status-502
         -> 502  !! undeclared
```

API Gateway produces those two itself, on an integration timeout and an integration failure. No Lambda writes them and every caller can receive them.

## Can library authors publish suss summaries with their package?

Yes. The [behavioral summary format](/behavioral-summary-format) is versioned and documented, and the `packageExports` discovery variant produces one provider summary per public export, resolved through your `package.json` entry points, so you never list the exports by hand. Run `suss extract` at publish time, ship the JSON in `dist/`, and consumers pair against it without needing your source. On the consumer side the `packageImport` variant finds every call site of an imported binding, and the two sides pair by `fn:<package>::<exportPath>`.

## Is the format stable?

The IR (`@suss/behavioral-ir`) and its JSON Schema are versioned. A breaking change gets a major version bump and a migration note. The CLI surface and the `inspect` output are still settling, so a tool built on the JSON is on firmer ground than one parsing the rendered text.

## Does suss replace OpenAPI, Storybook or Prisma schemas?

No, it reads them. Each of those is a specification or an observation, and suss is derivation. The interesting comparisons run across those kinds: does the derivation match the specification, and does the specification declare cases the derivation never reaches? [Three kinds of truth](/contracts#three-kinds-of-truth) is the taxonomy underneath that.

## What is out of scope?

- Cross-service aggregation, dashboards and historical drift tracking. Those consume summaries rather than producing them.
- Continuous monitoring. suss runs on demand, locally or in CI, and never as a daemon.
- Authorial intent, mostly. suss derives what the code does rather than what it should do. Declared contracts express some intent and the checker compares them against derivation, and team-authored [intent docs](/contracts#intent) are their own stream.
- Runtime instrumentation. Nothing suss reads comes from your running system: no agents, no sampling, no production data. `suss corroborate --experimental` does run handlers, locally, against inputs it generates, and it records what it saw beside the derived claim rather than in place of it.

## How do I add a new framework?

Write a `PatternPack`: declarative configuration that says how the framework registers handlers, where a status code attaches to a response, and what counts as an effect. Most packs are 100 to 300 lines of data and none of them fork the analyzer. See [Write a pack](/guides/writing-a-pack).
