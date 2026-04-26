---
layout: home

hero:
  name: suss
  text: Behavioral correctness for TypeScript
  tagline: "Catch the drift between what your code says it does and what it does. suss derives every execution path, pairs the derivations across boundaries, and surfaces bugs that compile, type-check, and pass the tests."
  actions:
    - theme: brand
      text: Get started
      link: /tutorial/get-started
    - theme: alt
      text: Why suss
      link: /motivation
    - theme: alt
      text: GitHub
      link: https://github.com/nimbuscloud-ai/suss

features:
  - title: Drift other tools miss
    details: "Code compiles, tests pass, types line up — and the consumer still reads a 200 the provider stopped producing. suss compares behavioural derivations directly, not just the shapes around them."
    link: /motivation
    linkText: Why behavioral summaries
  - title: One model across every boundary
    details: "HTTP handlers, GraphQL resolvers, React components, queue producers, storage calls, and client call sites all produce the same summary shape. Cross-boundary checking is diffing two summaries."
    link: /boundary-semantics
    linkText: Boundary semantics
  - title: Add a framework in one file
    details: "ts-rest, Express, Fastify, NestJS, React, React Router, Apollo Server, Prisma, AWS SQS, and process.env ship in the box. New frameworks are a small declarative pack — no fork of the analyser."
    link: /framework-packs
    linkText: Write a pack
  - title: Compare against declared contracts
    details: "OpenAPI against handlers, CloudFormation against API Gateway, Storybook against components, Prisma schema against query call sites, provider against consumer. The contract reader and the source extractor produce the same shape."
    link: /cross-boundary-checking
    linkText: How checking works
  - title: Runs on the code you already have
    details: "No annotations, no decorators, no rewrites. Point suss at your tsconfig and get summaries from the source as it stands today."
    link: /guides/add-to-project
    linkText: Add to a project
  - title: Explicit about what it can't analyse
    details: "When a condition is too dynamic for static analysis, the branch is labelled unresolved rather than silently dropped. Coverage stops are visible in the output."
    link: /motivation#what-suss-is-not
    linkText: What suss is not
---

## Quick start

```bash
npm install --save-dev @suss/cli @suss/framework-ts-rest @suss/client-axios

# Extract summaries from source
suss extract -p tsconfig.json -f ts-rest -o summaries/provider.json
suss extract -p apps/web/tsconfig.json -f axios -o summaries/consumer.json

# Pair providers against consumers
suss check summaries/provider.json summaries/consumer.json

# Human-readable view of a summary file
suss inspect summaries/provider.json
```

## What a summary looks like

```
src/handlers.ts
└─ GET /users/:id  (ts-rest handler | line 24)
     Contract: 200, 404, 500
       if  !params.id
         -> 404 { error }
       elif  !db.findById()
         -> 404 { error }
       elif  db.findById().deletedAt
         -> 404 { error }
       else
         -> 200 { id, name, email }
           + logger.info
           + auditLog →

     !! Declared response 500 is never produced by the handler

1 summaries inspected.
```

`suss inspect` rendering one summary. The header line names the endpoint, recognition pack, kind, and source line. The decision tree shows every execution path as a branch with its own output shape. The `+` lines under an output are the side-effects on that path; the `→` marker points to other summaries nearby. The `!!` annotation is a gap — the contract declared a 500 the handler can't produce.

The same data as JSON is what `@suss/checker` and downstream tools consume. `inspect` is a renderer over it.

## Reading order

The site's navigation is grouped Diátaxis-style — tutorial, how-to guides, reference, conceptual. A few common entry points:

- **First time on the site:** [Get started](/tutorial/get-started) walks the smallest end-to-end example, then [Motivation](/motivation) explains why this layer exists.
- **Adding suss to an existing project:** [Add suss to a project](/guides/add-to-project) → [Set up CI](/guides/ci-integration).
- **Looking up a flag or finding:** [CLI reference](/reference/cli) · [Findings catalog](/reference/findings) · [FAQ](/faq).
- **Writing or modifying a pack:** [Framework packs](/framework-packs).
- **Consuming the summary format:** [Behavioral summary format](/behavioral-summary-format) → [IR reference](/ir-reference).
- **Tracking what's shipped:** [Status & decisions](/internal/status).
