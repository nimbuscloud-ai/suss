# Motivation

## The problem

Modern software systems fail at boundaries. Not because individual components are buggy — each handler passes its tests, each service type-checks cleanly — but because the *behavioral* assumptions between components are invisible.

A concrete example. A user endpoint starts returning `200` with `status: "deleted"` for soft-deleted accounts, where it previously returned `404`. The handler's tests pass: the response is a valid `User`, the status code is a valid HTTP code. TypeScript is happy. The contract (OpenAPI, ts-rest, whatever) still declares `200 | 404`, which is still true.

Three services downstream break the next day. Each one had independently assumed that `GET /users/:id` returning `200` meant "the user exists and is usable". None of those assumptions were written down anywhere machine-checkable. The handler's *structure* didn't change; its *behavior* did.

This class of failure is where production incidents live, and no existing tool catches it.

## Why existing tools don't catch it

- **Type systems** describe shapes, not behavior. `User` is still `User` whether the user is active, soft-deleted, or shadow-banned.
- **OpenAPI / JSON Schema** describe structure. They can tell you the response has a `status` field that's a string; they can't tell you under what conditions the field takes the value `"deleted"`.
- **Contract testing (Pact, Spring Cloud Contract)** describes concrete examples. It tells you "when the request is X, the response is Y", but the example set is always incomplete, and consumers have to know in advance which cases to test.
- **Integration tests** describe the golden path plus a handful of error cases the original author thought of. The interesting failures are always the cases nobody thought of.

What's missing is a way to *extract* the behavioral contract from the implementation — not author it by hand, not approximate it with tests — and compare the provider's actual behavior to the consumer's actual assumptions.

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
- **Gaps** — e.g., if the ts-rest contract declares `200 | 404 | 500` but the handler never produces 500

This is enough information for a downstream tool to say: "the consumer at this call site assumes `200` means `isActive`, but the provider's `200` branch fires when `user.deletedAt` is truthy — these don't match."

## What suss produces (and what it doesn't)

suss is an extraction tool. Its output is `BehavioralSummary[]` — structured JSON describing a codebase's behavior. The tool itself doesn't check, compare, aggregate, alert, or track changes over time. Those are separate concerns that take summaries as input.

Natural consumers of summaries:

- **Pairwise checkers** — compare a provider's summary against a consumer's summary and flag mismatches. `suss check` covers this locally; see [cross-boundary-checking.md](cross-boundary-checking.md).
- **Diff tools** — given two summaries of the same code unit across commits, surface which behavioral cases a change added, removed, or altered.
- **Aggregators** — ingest summaries from many services, maintain a cross-service view, track evolution over time, alert on regressions. Out of scope for this repository.

The extraction tool is deliberately scoped small: produce clean, comparable, language-agnostic data and stop there. Any analysis layer — local pairwise, organizational, continuous — consumes summaries as input. That separation matters because the value of every analysis layer scales with how many projects produce summaries, so the priority for suss is that producing summaries is cheap, universal, and doesn't demand configuration.

## Relationship to prior work

suss extends Bertrand Meyer's [Design by Contract (1986)](https://en.wikipedia.org/wiki/Design_by_contract) from single-process method calls to distributed, polyglot systems. DbC had three adoption failures that suss addresses:

1. **Contracts are hand-authored.** DbC required developers to write pre/post conditions inline. suss infers them from code. The contract is always in sync with the implementation because it *is* the implementation.
2. **Contracts live inside a single process.** DbC only worked when caller and callee shared a language runtime. suss operates across service boundaries, transports, and language boundaries — because `BehavioralSummary` is a language-agnostic JSON shape.
3. **Contracts were absolute.** DbC assertions either hold or they don't. suss is explicit about uncertainty: opaque predicates, confidence levels, first-class gaps. A low-confidence summary is still useful.

suss also borrows from **compiler design** (AST traversal, symbol resolution, control flow analysis) but operates at a higher level of abstraction: it extracts *behavioral cases*, not execution paths. It doesn't build a complete control flow graph or perform data flow analysis. It identifies terminals, traces their gating conditions, and composes transitions.

It borrows from **formal verification** (preconditions, postconditions) but is deliberately less rigorous. Predicates can be opaque, confidence can be partial, and the system provides value with incomplete coverage. A behavioral summary isn't a proof of anything; it's a structured description that downstream tools can reason over.

## Design principles

1. **Inference over authoring.** Contracts are extracted from code, not written by hand. The extraction is the product.
2. **Graceful degradation.** Real code is messy. When the extractor can't decompose a condition, it falls back to opaque — preserving the source text and reducing confidence, never failing or lying.
3. **Language-agnostic output.** The output shape is the same whether extracted from TypeScript, Python, or anything else. Downstream tools don't care about the source language.
4. **Boundaries are first-class.** The whole point is cross-boundary checking. Every summary either is bound to a boundary or knows it's not.
5. **Declarative over imperative.** Framework support is data, not code. Adding Fastify should be ~100 lines of `PatternPack` configuration, not a new module.
6. **Layered coupling.** The IR has zero dependencies. The extractor depends only on the IR. The adapter depends on the extractor and the compiler API. Each layer can be replaced without touching the others.

## What suss is not

- **It's not a runtime.** Everything is static. No instrumentation, no production data, no sampling.
- **It's not a type checker.** It consumes type information (via the compiler API) but doesn't produce type errors.
- **It's not a verifier.** It doesn't prove that the code is correct. It describes what the code does and lets you compare descriptions.
- **It's not a linter.** It doesn't flag style issues. The output is structured data, not warnings.
- **It's not complete.** Some code is too dynamic to statically analyze. suss is honest about that — opaque predicates and low confidence are normal, not failures.
