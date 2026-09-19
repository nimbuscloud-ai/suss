---
title: The problem
description: Why a change can pass review, the type checker and the tests, and still break somebody else's code.
---

# The problem

## The change that breaks somebody else

Somebody makes `getUser` return `200` with `status: "deleted"` where it used to return `404`. It is a reasonable change. The response is a valid `User`, `200` is a valid status, the OpenAPI document still says `200 | 404`, and TypeScript is happy on both sides. Tests pass.

Every caller that read a `200` as "this account is usable" is now wrong. Nothing in the pipeline says so, and the first sign of it is in production.

The same thing happens without a network hop:

- A `useUser()` hook returns `null` for a deleted user, and its caller reads `null` as "still loading".
- The middleware behind `context.user` stops setting `email` for OAuth sessions, and a resolver still reads it.
- A helper starts returning `[]`, and its caller assumed non-empty.

Every one of these is two pieces of code that agree on types and disagree about behavior. There is one of those pairs at every call site, and nobody writes down what either side assumes.

## What suss does about it

suss reads each function and works out what it produces on each path it can take: which branches, under what conditions, with what effects. Then it compares that against what the code on the other side of the boundary does with it. A caller that never handles a status the handler returns is a finding. A query that reads a column the schema does not declare is a finding.

Nothing runs, nothing is instrumented, and nothing has to be annotated. The comparison happens over the source you already have.

Every layer below suss describes something true about the code, and none of them compares what one side does against what the other side expects. [Compared to other tools](/why/compared) goes through them one at a time.

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
- **Effects** with structured arguments, objects keep their fields, so `logger.error({ userId, pullRequestId }, "not found")` comes through as the named fields it had, not as something opaque.
- **Gaps**: e.g. if the ts-rest contract declares `200 | 404 | 500` but the handler never produces 500.

That's enough for a downstream tool to say: "the consumer at this call site assumes `200` means `isActive`, but the provider's `200` branch fires when `user.deletedAt` is truthy, these don't match."

The handler is one kind of code unit; the same kind of summary comes out of React components (what each branch renders under what prop/state conditions), GraphQL resolvers, client call sites (what status codes each site expects), and function-to-function calls within a process. A summary is `(unit, boundary, transitions)`; everything else, framework, transport, semantics, is metadata the pairing layer reads. Terms used here, transition, predicate, subject, effect, gap, have canonical definitions in the [Glossary](/reference/glossary).

**Closure over entry points.** Framework packs find a service's entry points (handlers, components, resolvers, call sites). Every function statically reachable from there, orchestrators, helpers, internal library code, is summarised too, as a `library` unit. Internal behavior that no framework pattern recognises still appears, as long as *some* pack-recognised entry point calls into it. Unused utilities never reached from any entry point are skipped; the closure filters down to the code that matters.

## Why this is the next layer

Every codebase has one central question: *what does this code do under what conditions?* Every nontrivial task, debugging, reviewing, extending, onboarding, integrating, ends up answering some version of it. Over time, parts of that question got cheaper to answer:

- Compilation removed "do the shapes line up" from human attention.
- Unit tests made "does this specific case work" machine-answerable.
- CI removed "did anyone run the tests."
- Types pushed structural checking into the code itself.
- Static analysis made classes of bugs visible without executing anything.

Each step moved a question from *needs a human to read and think* into *derivable from the code*. Each was strange until it was normal, and then its absence was the new strangeness. People still work out by hand, every time, the conditional structure of what code produces: which cases, under what predicates, with what effects. Nobody writes it down at scale because hand-authoring it is intractable; every review works it out again, every onboarding rebuilds it, every AI-agent interaction pays for that rebuilding in tokens. suss derives it once, and the summary stays in sync with the source by construction.

Having the layer in place enables:

- **Behavioral diffs on pull requests**: not *forty lines changed*, but *one 404 case removed, one throw path added, one condition inverted*.
- **Cross-boundary checking**: does the caller at this site handle every status the provider produces? A machine can answer that before anything runs.
- **Contract consistency**: the spec says X, the code does Y; the disagreement becomes a finding rather than a runtime surprise.
- **Publishing**: ship summaries with a package so downstream teams verify against actual behavior, not the README.
- **Cross-codebase reasoning for AI agents**: a twenty-service monorepo's behavior fits in a few hundred KB of summaries; its source doesn't fit in a context window. Summaries are the compact, verifiable index; source is the fallback. The same substrate verifies an agent's claims: if it asserts "X returns 404 only when the user is missing" and the summary says otherwise, the disagreement is observable.

None of the existing layers go away, each approximates derived behavior from a different angle, and keeping them separate is the point. Different kinds of truth, compared against each other, catch different failures. The taxonomy behind this is in [Kinds of contract](/why/kinds-of-contract).

## What suss produces (and what it doesn't)

suss's product is the `BehavioralSummary[]`, structured JSON describing what each code unit does under what conditions. The CLI bundles four kinds of work over those summaries:

- `suss extract`: derive summaries from source. TypeScript and JavaScript by default; Python and Ruby through adapters of their own, which the same command reaches with `--lang`. See [Read Python or Ruby](/guides/python-and-ruby).
- `suss contract`: produce summaries from declared contracts (OpenAPI, CloudFormation and SAM, Serverless Framework service files, AppSync, GraphQL SDL, committed `.graphql` operation documents, Prisma schema, Storybook CSF3).
- `suss check`: pair providers with consumers (two files, or a whole directory) and report cross-boundary findings. See [Cross-boundary checking](/why/cross-boundary-checking).
- `suss inspect`: render a summary file or directory as text, or `--diff BEFORE AFTER` to see which behavioral cases a change added, removed, or altered.

See the [CLI reference](/reference/cli/) for the full flag and exit-code surface.

Deliberately out of scope for this repository:

- **Cross-service aggregation.** Ingesting summaries from many services, maintaining a cross-org view, tracking evolution over time, alerting on regressions. The summary format is what lets such tools exist without sharing suss's internals.
- **Continuous monitoring.** suss runs on demand (locally, in CI). It doesn't run as a daemon or push findings to external systems.
- **Authorial intent, mostly.** suss derives what the code does; it doesn't invent what the code *should* do. Team-authored intent docs are the one exception: they're a separate artifact stream compared against derivation rather than replacing it. See the [intent section of Contracts](/guides/check-against-intent).

The scope is narrow on purpose: produce comparable, language-agnostic data, and provide enough built-in pairing and rendering to demonstrate the data is useful. Any further analysis layer, cross-service, continuous, organisation-scoped, consumes summaries as input. The value of every such layer scales with how many projects produce summaries, so suss's priority is that producing summaries is cheap, universal, and configuration-free.

## What suss is not

- **Not a runtime.** Everything is static. No instrumentation, no production data, no sampling.
- **Not a type checker.** It consumes type information (via the compiler API) but doesn't produce type errors.
- **Not a verifier.** It doesn't prove the code is correct. It describes what the code does and lets you compare descriptions.
- **Not a linter.** It doesn't flag style issues. The output is structured data, not warnings.
- **Not a within-unit correctness tool.** suss finds divergence *between* units, not wrongness *within* one. A handler whose logic is internally consistent but semantically wrong (returns `200` when it should `404`, on every path) produces a summary the consumer agrees with, there's nothing to diff. Team-authored intent is how a team's stated intent becomes an artifact you can compare against derivation; see the [intent section of Contracts](/guides/check-against-intent).
- **Not complete.** Some code is too dynamic to statically analyze. suss is explicit about that, opaque predicates and low confidence are normal, not failures.

## Where this goes

Coverage today is schema-shaped: status codes, response bodies, call signatures, conditional rendering, resolver argument structures, storage access, message-bus producers. Near-term work deepens subject tracing and closes gaps where summaries fall back to opaque. Further out, the same boundary gets checked against more kinds of truth at once, a spec, a test, a snapshot, an observed trace, and the derived behavior of the code, compared pairwise. Team-authored intent is the first of those additional kinds to ship. The pattern at every step is the one unit tests established: turn something that required human reading into something a tool can derive, compare, and act on.
