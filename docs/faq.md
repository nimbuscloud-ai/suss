# FAQ

Common questions about what suss is, what it does, and how it relates to tooling you already use.

## What is suss, in one sentence?

Static analysis that derives every execution path through every function in a TypeScript codebase, then pairs those derivations across boundaries (HTTP, GraphQL, queues, storage, in-process calls) to surface drift between what code says and what it does.

## How is this different from a linter?

Linters match syntactic patterns — a forbidden call, a missing `await`, an unused variable. They don't model what a function does, so they can't compare what one function produces with what another expects. suss derives behaviour and compares; the findings name a specific path on one side that disagrees with a specific path on the other side, not a syntactic shape that's globally suspect.

## How is this different from TypeScript?

TypeScript checks shapes. `User` is still `User` whether the user is active, soft-deleted, or shadow-banned; `Response<200, User>` type-checks the same regardless of which branch of the handler produced it. suss models *which branch produced what* and *under what conditions* — information that's invisible to the type system because it's about values, not types.

## How is this different from OpenAPI / ts-rest / tRPC?

Those are specifications: a hand-authored description of what the API should accept and return. suss is derivation: an extracted description of what the implementation actually does. The two are complementary — `suss check` pairs them and reports drift between the spec and the code. If you have an OpenAPI spec, run `suss contract --from openapi` and check it against your handlers' summaries.

## How is this different from tests?

Tests record what happened on the inputs the test author thought of. suss records what happens on every reachable path, regardless of whether anyone wrote a test for it. The two complement: tests verify behaviour with concrete data; suss enumerates the structure of behaviour and finds gaps the test set never reaches.

## How is this different from observability?

Observability records what happened at runtime, once. The union of traces is always a subset of reachable behaviour, and you find out about drift after the incident. suss derives the structure of behaviour statically, so cases that *can* fire in production but haven't yet still appear in the output.

## What does "behavioral drift" mean?

Two pieces of code (or one piece of code and one declared contract) that previously agreed on what flows across a boundary now disagree. The agreement was in behaviour, not in types — the types may not have changed at all. Examples:

- A handler used to return `404` for soft-deleted users and now returns `200 { status: "deleted" }`. Caller still reads `200` as "user exists and is usable."
- A Prisma write used to set `email`; the schema removed `email`. Type-checker doesn't catch it because the field is still in the input type — only the runtime database rejects it.
- A queue producer used to send `{ userId: string }`; the consumer parses `userId` as a number. Both compile, both run, until the wrong value gets stored.

## Does it require annotations or changes to my code?

No. suss reads source as it stands today. No decorators, no JSDoc tags, no comments to add, no rewrites. It needs your `tsconfig.json` (so type resolution matches what your compiler sees) and the right framework packs.

## What languages does it support?

TypeScript today, via ts-morph. The IR (`@suss/behavioral-ir`) and checker (`@suss/checker`) are language-agnostic — they consume `BehavioralSummary[]` JSON. Adapters for other languages are possible without changing the IR or the checker; none ship today.

## What's a "boundary"?

Any place two units of code meet across a contract — an HTTP request flowing from a client to a handler, a function exported from one module and called from another, a SQL query running against a database schema, a message put on a queue and read by a consumer, a React parent rendering a child with props. The contract may be implicit (a function signature) or explicit (an OpenAPI spec, a Prisma schema). Every boundary has a *provider* side (produces output) and a *consumer* side (acts on it), even when both live in the same process. suss derives summaries on both sides and pairs them.

## What boundaries are modelled?

HTTP (ts-rest, Express, Fastify, NestJS REST), GraphQL (Apollo Server, NestJS GraphQL, AppSync), React (components, event handlers, `useEffect`), React Router (loaders / actions), storage (Prisma reads / writes / selectors), message bus (AWS SQS producers, CloudFormation event-source mappings on the consumer side), runtime config (`process.env` plus CloudFormation `Environment` blocks for resolution), and contract sources (OpenAPI 3.x, AWS API Gateway, CloudFormation / SAM, AppSync, Storybook CSF3, Prisma schema). New boundaries are additive packs — see [framework packs](/framework-packs).

## Does it work in monorepos?

Yes — typically one `suss extract` invocation per package using that package's `tsconfig.json`. `suss check --dir` then pairs across the resulting summary files. The contract-extraction commands (`suss contract --from openapi`, etc.) are independent of the source repo.

## Does it produce false positives?

It produces three kinds of "I'm not sure" output explicitly:

- **Opaque predicates** — when a branch condition can't be statically resolved, the predicate is labelled `opaque` with the source text preserved. Downstream tools can decide whether to count opaque branches as covered.
- **Unresolved subjects** — when a value's origin can't be traced, the subject is labelled `unresolved` rather than dropped.
- **Confidence levels** — every summary carries a `confidence` block recording the analyser's certainty.

Findings are graded `error | warning | info` and you control the CI gate with `--fail-on`. False positives in the strict sense (a finding the code does not actually have) do happen; the typical cause is a pack that doesn't know about a wrapper or a recognition pattern. Adding the pattern to the pack is the fix.

## What's the difference between `suss extract` and `suss contract`?

`extract` runs over TypeScript source and derives summaries from the implementation. `contract` runs over a declared artifact — OpenAPI spec, CloudFormation template, Prisma schema, Storybook CSF3 file — and emits summaries in the same shape. Both feed `suss check`, which pairs them.

## Can library authors publish suss summaries with their package?

Yes — the [behavioral summary format](/behavioral-summary-format) is versioned and documented. The intended workflow is to run `suss extract` against the library at publish time, ship the resulting JSON in `dist/`, and let consumers pair their code against those summaries without needing the library's source. Tooling for this is on the roadmap; nothing prevents doing it manually today.

## Is the format stable?

The IR (`@suss/behavioral-ir`) and the JSON Schema are versioned. Breaking changes get a major version bump and a migration note. The CLI surface and inspect output format are still firming up; consumers building on the JSON are on more stable ground than consumers parsing the inspect output.

## Does suss replace OpenAPI / Storybook / Prisma schemas?

No — it consumes them. Each of those is a *specification* (or *observation*); suss is *derivation*. The interesting comparisons are cross-character: does the derivation match the specification? Does the specification declare cases the derivation never reaches? See [Three kinds of truth](/contracts) for the taxonomy that grounds this.

## What's "out of scope"?

- Cross-service aggregation, dashboards, and historical drift tracking — operational concerns that consume summaries rather than produce them.
- Continuous monitoring — suss runs on demand (locally, in CI), not as a daemon.
- Authorial intent — suss derives what the code does, not what it should do. Declared contracts (OpenAPI, ts-rest `responses`, Prisma schema) carry intent, and the checker compares them against derivation.
- Runtime instrumentation — everything is static. No agents, no sampling, no production data.

## How do I add a new framework?

Write a `PatternPack` — declarative configuration that tells suss how the framework registers handlers, where status codes attach to responses, what counts as an effect. Most packs are 100–300 lines of data, no fork of the analyser. See [framework packs](/framework-packs).
