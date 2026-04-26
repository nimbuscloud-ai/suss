# Motivation

*If you're arriving cold and want the "why this layer exists at all" argument before the gap-with-other-tools story, [Why behavioral summaries](/why-behavioral-summaries) is the companion to this page.*

## The problem

Every boundary between two units of code — a function call, a component render, an HTTP handler hit, a resolver dispatch — carries behavioral assumptions the caller makes about the callee. Those assumptions are almost never recorded in a form a tool can check. The gap between "the types line up" and "the behavior lines up" is a class of divergence no existing tool catches.

A concrete example. A `getUser` handler changes from returning `404` for soft-deleted accounts to returning `200` with `status: "deleted"`. Tests pass: the response is a valid `User`, the status code is a valid HTTP code. TypeScript type-checks. The declared contract (OpenAPI, ts-rest) still says `200 | 404`, which is still true. Nothing in the implementation's shape changed. Any caller that had read `200` as "the user exists and is usable" now receives a `200` that violates that reading, and no tool in the stack can point at the divergence.

The same shape of divergence exists without a network hop. A `useUser()` hook's consumer reads `null` as "loading"; the hook's implementation adds a `null` case for deleted users. A resolver reads `context.user.email`; the middleware populating `context.user` stops setting `email` for OAuth sessions. A utility's caller assumes the return is non-empty; the utility adds a case that returns `[]`. The unit of analysis isn't the service — it's the boundary, and there's one at every call site.

## Why existing tools don't catch it

- **Type systems** describe shapes. `User` is still `User` whether the user is active, soft-deleted, or shadow-banned; `<Button variant="danger">` type-checks the same whether `danger` shows a red border, disables the button, or opens a confirm modal.
- **Structural schemas (OpenAPI, JSON Schema, Protobuf, GraphQL SDL)** describe payload structure. They can tell you the response has a `status` field that's a string; they can't tell you under what conditions the field takes the value `"deleted"`.
- **Runtime validators (Zod, Yup, io-ts)** gate the boundary on shape. A payload is valid or it isn't; "valid" is silent on which branch produced it.
- **End-to-end typed stacks (tRPC, GraphQL codegen, OpenAPI codegen)** tighten the shape on both sides of a boundary. Both sides agree on `User | null` — neither side records *when* the server returns `null`, or which component branches that `null` flows into.
- **Example-based fixtures (Pact, Spring Cloud Contract, Storybook / CSF, MSW handlers)** describe concrete cases — "when the request is X, the response is Y" for servers, "when the props are P, here is what renders" for components. The example set is always incomplete, and the fixture doesn't cross-check whether a call site ever actually produces that combination of inputs.
- **Integration, e2e, and visual-regression tests (Cypress, Playwright, Chromatic, Percy)** describe the golden path plus a handful of cases the original author thought of, and snapshot the resulting shape. They don't model the conditions under which each shape is reached, and the interesting failures are always the ones nobody wrote a test for.
- **Linters and pattern-based static analysis (ESLint, CodeQL, Semgrep)** match syntactic patterns — a forbidden call, a missing `await`, a suspect `useEffect` dependency array. They don't model what a function or component produces under what conditions.
- **Deep static analysis (Infer, symbolic execution)** proves the absence of specific bug classes — null deref, memory safety, taint — against the callee in isolation. It doesn't surface the callee's behavioral contract or compare it to what callers assume.
- **Observability (OpenTelemetry, APM, server logs, frontend error reporting like Sentry)** records what happened once. Each trace is a single execution path; the union of traces is always a subset of reachable behavior, and divergence shows up after the incident, not before.
- **Formal methods (TLA+, Alloy, Design by Contract)** can describe behavior precisely — but require hand-authored specifications that drift from the implementation the moment someone forgets to update them.

What's missing is a way to *derive* a unit's behavioral contract from its implementation — across every boundary it participates in — and compare it against what each caller assumes.

## What suss does

suss reads source code and produces a structured description of what each function actually does under what conditions. Given this handler:

```typescript
export const getUser = async ({ params }) => {
  const user = await db.findById(params.id);
  if (!user) {
    return { status: 404, body: { error: "not found" } };
  }
  if (user.deletedAt) {
    return { status: 200, body: { ...user, status: "deleted" } };
  }
  return { status: 200, body: user };
};
```

suss extracts:

- **Three transitions**, one per execution path
- **Predicates** that gate each transition (`!user`, `user.deletedAt`, default)
- **Subjects** that trace `user` back to its origin (`db.findById`) — stable across rename boundaries
- **Outputs** with status codes and body type references
- **Effects** with structured arguments — objects preserve their field shape, identifiers and nested calls preserve the composition, so `logger.error({ userId, pullRequestId }, "not found")` reads as the named fields it was, not as "something opaque"
- **Gaps** — e.g., if the ts-rest contract declares `200 | 404 | 500` but the handler never produces 500

This is enough information for a downstream tool to say: "the consumer at this call site assumes `200` means `isActive`, but the provider's `200` branch fires when `user.deletedAt` is truthy — these don't match."

The handler is one shape of code unit; the same summary shape comes out of React components (what each branch renders under what prop/state conditions), GraphQL resolvers (what each field returns when), Apollo / axios / fetch call sites (what status codes each client site expects), and function-to-function calls within a process. A summary is `(unit, boundary, transitions)`; everything else — framework, transport, semantics — is metadata the pairing layer reads.

**Closure over entry points.** Framework packs find a service's entry points (handlers, components, resolvers, consumer call sites). Every function statically reachable from there — orchestrators, helpers, internal library code — is summarised too, as a `library` unit. This means internal behaviour that no framework shape recognises (e.g. an SQS-consumer orchestrator invoked through a pattern the packs don't model) still appears in the output as long as *some* pack-recognised entry point calls into it. Unused utilities never reached from any entry point are skipped — the closure naturally filters to the code that actually matters.

## What suss produces (and what it doesn't)

suss's product is the `BehavioralSummary[]` — structured JSON describing what each code unit does under what conditions. The CLI bundles four kinds of work over those summaries:

- `suss extract` — derive summaries from TypeScript source.
- `suss contract` — produce summaries from declared contracts (OpenAPI, CloudFormation, Storybook CSF3, AppSync).
- `suss check` — pair providers with consumers (two files, or a whole directory) and report cross-boundary findings. See [cross-boundary-checking.md](cross-boundary-checking.md).
- `suss inspect` — render a summary file or directory as human-readable text, or `--diff BEFORE AFTER` to see which behavioral cases a change added, removed, or altered.

See the [CLI reference](/reference/cli) for the full flag and exit-code surface.

Deliberately out of scope for this repository:

- **Cross-service aggregation.** Ingesting summaries from many services, maintaining a cross-org view, tracking evolution over time, alerting on regressions. Each is its own operational concern; the summary format is what lets such tools exist without sharing suss's internals.
- **Continuous monitoring.** suss runs on demand (locally, in CI). It doesn't run as a daemon, poll repositories, or push findings to external systems.
- **Authorial intent.** suss derives what the code does; it doesn't invent what the code *should* do. Declared contracts (OpenAPI, ts-rest `responses`, CFN `MethodResponses`, Storybook stories) are the shape nearest to intent, and the checker compares them against derivation rather than replacing derivation with declaration.

The scope is deliberately narrow: produce clean, comparable, language-agnostic data, and provide enough built-in pairing and rendering to demonstrate the data is useful. Any further analysis layer — cross-service, continuous, organisation-scoped — consumes summaries as input. That separation matters because the value of every analysis layer scales with how many projects produce summaries, so suss's priority is that producing summaries is cheap, universal, and doesn't demand configuration.

## Relationship to prior work

suss extends Bertrand Meyer's [Design by Contract (1986)](https://en.wikipedia.org/wiki/Design_by_contract) from single-process method calls to distributed, polyglot systems. DbC had three adoption failures that suss addresses:

1. **Contracts are hand-authored.** DbC required developers to write pre/post conditions inline. suss infers them from code. The contract is always in sync with the implementation because it *is* the implementation.
2. **Contracts live inside a single process.** DbC only worked when caller and callee shared a language runtime. suss operates across service boundaries, transports, and language boundaries — because `BehavioralSummary` is a language-agnostic JSON shape.
3. **Contracts were absolute.** DbC assertions either hold or they don't. suss is explicit about uncertainty: opaque predicates, confidence levels, gaps as top-level output. A low-confidence summary is still useful.

suss also borrows from **compiler design** (AST traversal, symbol resolution, control flow analysis) but operates at a higher level of abstraction: it extracts *behavioral cases*, not execution paths. It doesn't build a complete control flow graph or perform data flow analysis. It identifies terminals, traces their gating conditions, and composes transitions.

It borrows from **formal verification** (preconditions, postconditions) but is deliberately less rigorous. Predicates can be opaque, confidence can be partial, and the system provides value with incomplete coverage. A behavioral summary isn't a proof of anything; it's a structured description that downstream tools can reason over.

It aligns with **Daniel Jackson's concept design** at the coarse level: a suss code unit is a *concept* (purpose, state, behavior), and a `BoundaryBinding` is a *sync* (the wiring between concepts). suss diverges on two axes. Jackson's concepts are designed top-down with declared purposes; suss derives them bottom-up from existing code, so purpose is implicit and the extractor reconstructs behavior. And Jackson models concepts as singular atoms; suss composes them — a summary lists every transition for a unit instead of splitting each transition into its own concept. The shared insight is the same: the interaction between units carries its own named structure, separate from the units themselves. Primary sources: Jackson, [*The Essence of Software*](https://essenceofsoftware.com/) (Princeton, 2021); Jackson, [*Concept Design Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf) (NFM 2022); Meng & Jackson, [*What You See Is What It Does*](https://arxiv.org/abs/2508.14511) (SPLASH Onward! 2025). Long-form mapping in [`internal/concept-design.md`](internal/concept-design.md).

## Design principles

1. **Inference over authoring.** Contracts are extracted from code, not written by hand. The extraction is the product.
2. **Staged degradation.** Production code is messy. When the extractor can't decompose a condition, it falls back to opaque — preserving the source text and reducing confidence, never failing or fabricating.
3. **Opacity is data, not failure.** An opaque predicate or an unresolved subject is a labeled surface in the summary, not a discarded branch. Future passes — intra-pack resolvers, cross-unit chasing, heuristics — decompose what prior passes couldn't. Reducing opacity over time is a design axis, not cleanup.
4. **Language-agnostic output.** The output shape is the same whether extracted from TypeScript, Python, or anything else. Downstream tools don't care about the source language.
5. **Boundaries are the primary concept, decomposed into three layers.** Every summary is attached to a `BoundaryBinding` with separate *transport* (where bytes move: http, in-process, graphql), *semantics* (the discriminated union that gives the boundary its pairing rule: rest, function-call, graphql-resolver, graphql-operation), and *recognition* (how the adapter found the unit). New semantics are added as variants, not rewrites of the surrounding layers.
6. **Declarative over imperative.** Framework support is data, not code. Adding Fastify should be ~100 lines of `PatternPack` configuration, not a new module.
7. **Layered coupling.** The IR has zero dependencies. The extractor depends only on the IR. The adapter depends on the extractor and the compiler API. Each layer can be replaced without touching the others.

## What suss is not

- **It's not a runtime.** Everything is static. No instrumentation, no production data, no sampling.
- **It's not a type checker.** It consumes type information (via the compiler API) but doesn't produce type errors.
- **It's not a verifier.** It doesn't prove that the code is correct. It describes what the code does and lets you compare descriptions.
- **It's not a linter.** It doesn't flag style issues. The output is structured data, not warnings.
- **It's not complete.** Some code is too dynamic to statically analyze. suss is explicit about that — opaque predicates and low confidence are normal, not failures.
