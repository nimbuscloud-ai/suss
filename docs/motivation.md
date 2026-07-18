# Motivation

suss catches behavioral drift between what your TypeScript code says it does and what it does. The class of failures it targets is the one other tooling leaves uncovered, code that compiles, type-checks, passes its tests, and validates against the declared contract, but at runtime sends a consumer a `200` whose shape it doesn't expect (or writes to a database column the schema doesn't declare). The mechanism is static behavioral analysis: extracting what every function does on every execution path, then pairing those derivations across the boundaries where they meet.

## The problem

Every boundary between two units of code carries behavioral assumptions the caller makes about the callee. Those assumptions are almost never recorded in a form a tool can check. The gap between "the types line up" and "the behavior lines up" is a class of divergence no existing tool catches.

(*Boundary* throughout means any place two units meet across a contract; the [Glossary](/glossary) and [FAQ](/faq#what-s-a-boundary) give the general definition. The worked example below is one shape of it.)

### A worked drift example

A `getUser` handler changes from returning `404` for soft-deleted accounts to returning `200` with `status: "deleted"`. Tests pass: the response is a valid `User`, the status code is a valid HTTP code. TypeScript type-checks. The declared contract (OpenAPI, ts-rest) still says `200 | 404`, which is still true. Nothing in the implementation's shape changed. Any caller that had read `200` as "the user exists and is usable" now receives a `200` that violates that reading, and no tool in the stack can point at the divergence.

The same shape of divergence exists without a network hop. A `useUser()` hook's consumer reads `null` as "loading"; the hook adds a `null` case for deleted users. A resolver reads `context.user.email`; the middleware populating `context.user` stops setting `email` for OAuth sessions. A utility's caller assumes the return is non-empty; the utility adds a case that returns `[]`. The unit of analysis isn't the service, it's the boundary, and there's one at every call site.

## Why existing tools miss it

Each layer you already run approximates behavior from a different angle and stops short of comparing derived behavior across a boundary:

- **Type systems** describe shapes. `User` is still `User` whether the user is active, soft-deleted, or shadow-banned.
- **Structural schemas** (OpenAPI, JSON Schema, Protobuf, GraphQL SDL) describe payload structure, that the response has a `status` string field, not under what conditions it takes the value `"deleted"`.
- **Runtime validators** (Zod, Yup, io-ts) gate the boundary on shape. "Valid" is silent on which branch produced it.
- **End-to-end typed stacks** (tRPC, GraphQL codegen, OpenAPI codegen) tighten the shape on both sides. Both agree on `User | null`; neither records *when* the server returns `null`.
- **Example-based fixtures and contract tests** (Pact, Storybook / CSF, MSW) describe concrete cases. The example set is always incomplete, and the fixture doesn't cross-check whether a call site ever produces that combination.
- **Integration / e2e / visual-regression tests** (Cypress, Playwright, Chromatic) cover the golden path plus a handful of cases the author thought of. The interesting failures are the ones nobody wrote a test for.
- **Linters and pattern-based static analysis** (ESLint, CodeQL, Semgrep) match syntactic patterns. They don't model what a function produces under what conditions.
- **Deep static analysis** (Infer, symbolic execution) proves the absence of specific bug classes against a callee in isolation. It doesn't surface the callee's behavioral contract or compare it to what callers assume.
- **Observability** (OpenTelemetry, APM, Sentry) records what happened once. The union of traces is a subset of reachable behavior, and drift shows up after the incident.
- **Formal methods** (TLA+, Alloy, Design by Contract) describe behavior precisely but require hand-authored specifications that drift the moment someone forgets to update them.

What's missing is a way to *derive* a unit's behavioral contract from its implementation, across every boundary it participates in, and compare it against what each caller assumes. The per-tool "how is suss different from X" answers are in the [FAQ](/faq).

## What suss derives

suss reads source code and produces a structured description of what each function does under what conditions. Given this handler:

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

- **Three transitions**: one per execution path.
- **Predicates** that gate each transition (`!user`, `user.deletedAt`, default).
- **Subjects** that trace `user` back to its origin (`db.findById`), stable across rename boundaries.
- **Outputs** with status codes and body type references.
- **Effects** with structured arguments, objects preserve their field shape, so `logger.error({ userId, pullRequestId }, "not found")` reads as the named fields it was, not as something opaque.
- **Gaps**: e.g. if the ts-rest contract declares `200 | 404 | 500` but the handler never produces 500.

That's enough for a downstream tool to say: "the consumer at this call site assumes `200` means `isActive`, but the provider's `200` branch fires when `user.deletedAt` is truthy, these don't match."

The handler is one shape of code unit; the same summary shape comes out of React components (what each branch renders under what prop/state conditions), GraphQL resolvers, client call sites (what status codes each site expects), and function-to-function calls within a process. A summary is `(unit, boundary, transitions)`; everything else, framework, transport, semantics, is metadata the pairing layer reads. Terms used here, transition, predicate, subject, effect, gap, have canonical definitions in the [Glossary](/glossary).

**Closure over entry points.** Framework packs find a service's entry points (handlers, components, resolvers, call sites). Every function statically reachable from there, orchestrators, helpers, internal library code, is summarised too, as a `library` unit. Internal behavior that no framework shape recognises still appears as long as *some* pack-recognised entry point calls into it. Unused utilities never reached from any entry point are skipped; the closure filters to the code that matters.

## Why this is the next layer

Every codebase has a question at its heart: *what does this code do under what conditions?* Every nontrivial task, debugging, reviewing, extending, onboarding, integrating, ends up answering some version of it. Over time, parts of that question got cheaper to answer:

- Compilation removed "do the shapes line up" from human attention.
- Unit tests made "does this specific case work" machine-answerable.
- CI removed "did anyone run the tests."
- Types pushed shape-checking into the code itself.
- Static analysis made classes of bugs visible without executing anything.

Each step moved a question from *needs a human to read and think* into *derivable from the code*. Each was strange until it was normal, and then its absence was the new strangeness. The conditional structure of what code produces, which cases, under what predicates, with what effects, is still reconstructed by hand every time. Nobody writes it down at scale because hand-authoring it is intractable; every review reconstructs it, every onboarding rebuilds it, every AI-agent interaction pays for the reconstruction in tokens. suss derives it once, and the summary stays in sync with the source by construction.

Having the layer in place enables:

- **Behavioral diffs on pull requests**: not *forty lines changed*, but *one 404 case removed, one throw path added, one condition inverted*.
- **Cross-boundary checking**: does the caller at this site handle every status the provider produces? Machine-answerable before anything runs.
- **Contract consistency**: the spec says X, the code does Y; the disagreement becomes a finding rather than a runtime surprise.
- **Publishing**: ship summaries with a package so downstream teams verify against actual behavior, not the README.
- **Cross-codebase reasoning for AI agents**: a twenty-service monorepo's behavior fits in a few hundred KB of summaries; its source doesn't fit in a context window. Summaries are the compact, verifiable index; source is the fallback. The same substrate verifies an agent's claims: if it asserts "X returns 404 only when the user is missing" and the summary says otherwise, the disagreement is observable.

None of the existing layers go away, each approximates derived behavior from a different angle, and keeping them separate is the point. Different shapes of truth, compared against each other, catch different failures. [Contracts](/contracts) is the taxonomy that grounds this.

## What suss produces (and what it doesn't)

suss's product is the `BehavioralSummary[]`, structured JSON describing what each code unit does under what conditions. The CLI bundles four kinds of work over those summaries:

- `suss extract`: derive summaries from TypeScript source.
- `suss contract`: produce summaries from declared contracts (OpenAPI, CloudFormation, AppSync, GraphQL SDL, Prisma schema, Storybook CSF3).
- `suss check`: pair providers with consumers (two files, or a whole directory) and report cross-boundary findings. See [`cross-boundary-checking.md`](cross-boundary-checking.md).
- `suss inspect`: render a summary file or directory as text, or `--diff BEFORE AFTER` to see which behavioral cases a change added, removed, or altered.

See the [CLI reference](/reference/cli) for the full flag and exit-code surface.

Deliberately out of scope for this repository:

- **Cross-service aggregation.** Ingesting summaries from many services, maintaining a cross-org view, tracking evolution over time, alerting on regressions. The summary format is what lets such tools exist without sharing suss's internals.
- **Continuous monitoring.** suss runs on demand (locally, in CI). It doesn't run as a daemon or push findings to external systems.
- **Authorial intent, mostly.** suss derives what the code does; it doesn't invent what the code *should* do. Team-authored intent docs are the one exception: they're a separate artifact stream compared against derivation rather than replacing it. See the [intent section of Contracts](/contracts#intent).

The scope is narrow on purpose: produce clean, comparable, language-agnostic data, and provide enough built-in pairing and rendering to demonstrate the data is useful. Any further analysis layer, cross-service, continuous, organisation-scoped, consumes summaries as input. The value of every such layer scales with how many projects produce summaries, so suss's priority is that producing summaries is cheap, universal, and configuration-free.

## Relationship to prior work

suss extends Bertrand Meyer's [Design by Contract (1986)](https://en.wikipedia.org/wiki/Design_by_contract) from single-process method calls to distributed, polyglot systems. DbC had three adoption failures that suss addresses:

1. **Contracts are hand-authored.** DbC required developers to write pre/post conditions inline. suss infers them from code. The contract is always in sync with the implementation because it *is* the implementation.
2. **Contracts live inside a single process.** DbC only worked when caller and callee shared a language runtime. suss operates across service, transport, and language boundaries, because `BehavioralSummary` is a language-agnostic JSON shape.
3. **Contracts were absolute.** DbC assertions either hold or they don't. suss is explicit about uncertainty: opaque predicates, confidence levels, gaps as top-level output. A low-confidence summary is still useful.

suss borrows from **compiler design** (AST traversal, symbol resolution, control flow analysis) but operates at a higher level: it extracts *behavioral cases*, not execution paths. It doesn't build a complete control flow graph or perform data flow analysis. It identifies terminals, traces their gating conditions, and composes transitions.

It borrows from **formal verification** (preconditions, postconditions) but is deliberately less rigorous. Predicates can be opaque, confidence can be partial, and the system provides value with incomplete coverage. A behavioral summary isn't a proof; it's a structured description downstream tools reason over.

It aligns with **Daniel Jackson's concept design** at the coarse level: a suss code unit is a *concept* (purpose, state, behavior), and a `BoundaryBinding` is a *sync* (the wiring between concepts). suss diverges on two axes. Jackson's concepts are designed top-down with declared purposes; suss derives them bottom-up from existing code, so purpose is implicit and the extractor reconstructs behavior. And Jackson models concepts as singular atoms; suss composes them, a summary lists every transition for a unit instead of splitting each into its own concept. The shared insight: the interaction between units carries its own named structure, separate from the units themselves. Primary sources: Jackson, [*The Essence of Software*](https://essenceofsoftware.com/) (Princeton, 2021); Jackson, [*Concept Design Moves*](https://people.csail.mit.edu/dnj/publications/nfm-design-moves-22.pdf) (NFM 2022); Meng & Jackson, [*What You See Is What It Does*](https://arxiv.org/abs/2508.14511) (SPLASH Onward! 2025).

## Design principles

1. **Inference over authoring.** Contracts are extracted from code, not written by hand. The extraction is the product.
2. **Staged degradation.** Production code is messy. When the extractor can't decompose a condition, it falls back to opaque, preserving the source text and reducing confidence, never failing or fabricating.
3. **Opacity is data, not failure.** An opaque predicate or unresolved subject is a labeled surface in the summary, not a discarded branch. Later passes decompose what earlier ones couldn't. Reducing opacity over time is a design axis, not cleanup.
4. **Language-agnostic output.** The output shape is the same whether extracted from TypeScript, Python, or anything else. Downstream tools don't care about the source language.
5. **Boundaries are the primary concept, decomposed into three layers.** Every summary is attached to a `BoundaryBinding` with separate *transport*, *semantics*, and *recognition*. New semantics are added as variants, not rewrites of the surrounding layers.
6. **Declarative over imperative.** Framework support is data, not code. Adding a framework should be ~100 lines of `PatternPack` configuration, not a new module.
7. **Layered coupling.** The IR has zero dependencies. The extractor depends only on the IR. The adapter depends on the extractor and the compiler API. Each layer can be replaced without touching the others.

## What suss is not

- **Not a runtime.** Everything is static. No instrumentation, no production data, no sampling.
- **Not a type checker.** It consumes type information (via the compiler API) but doesn't produce type errors.
- **Not a verifier.** It doesn't prove the code is correct. It describes what the code does and lets you compare descriptions.
- **Not a linter.** It doesn't flag style issues. The output is structured data, not warnings.
- **Not a within-unit correctness tool.** suss finds divergence *between* units, not wrongness *within* one. A handler whose logic is internally consistent but semantically wrong (returns `200` when it should `404`, on every path) produces a summary the consumer agrees with, there's nothing to diff. Team-authored intent is how authored intent becomes a comparable artifact alongside derivation; see the [intent section of Contracts](/contracts#intent).
- **Not complete.** Some code is too dynamic to statically analyze. suss is explicit about that, opaque predicates and low confidence are normal, not failures.

## Where this goes

Coverage today is schema-shaped: status codes, response bodies, call signatures, conditional rendering, resolver arg shapes, storage access, message-bus producers. Near-term work deepens subject tracing and closes gaps where summaries fall back to opaque. Further out, the same boundary gets checked against more shapes of truth at once, a spec, a test, a snapshot, an observed trace, and the derived behavior of the code, compared pairwise. Team-authored intent is the first of those additional shapes to ship. The pattern at every step is the one unit tests established: turn something that required human reading into something a tool can derive, compare, and act on.
