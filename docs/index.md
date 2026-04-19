---
layout: home

hero:
  name: suss
  text: Extract every path your TypeScript code can take
  tagline: "suss reads your source and writes down what every function, component, handler, and resolver actually does — one structured summary per boundary, complete across every branch. Compare summaries against specs, tests, or each other to find where intent and implementation diverge."
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
  - title: Derivation, not specification
    details: "Specs say what should happen. Tests record what happened, once. suss gives you the third thing: what the code does, derived from the source itself, complete across every path."
    link: /contracts
    linkText: Three kinds of truth
  - title: One model across every boundary
    details: "HTTP handlers, GraphQL resolvers, React components, and client call sites all get summarised in the same structured shape. Cross-boundary comparison becomes diffing two summaries."
    link: /boundary-semantics
    linkText: Boundary semantics
  - title: Add a framework in one file
    details: "ts-rest, Express, Fastify, React, Apollo, and React Router ship in the box. Adding suss to Nest, Hono, or your internal framework is a small declarative pack — no fork of the analyser."
    link: /framework-packs
    linkText: Write a pack
  - title: Compare specs against implementations
    details: "Point suss at your OpenAPI spec and your handler code; get findings where they disagree. Same for CloudFormation vs API Gateway, Storybook stories vs React components, and more."
    link: /cross-boundary-checking
    linkText: How checking works
  - title: Pairing that speaks each protocol
    details: "REST handlers pair with REST clients by method and path. GraphQL operations pair with resolvers by type and field, walking nested selections against your schema."
    link: /boundary-semantics
    linkText: The semantics layer
  - title: Explicit about what it can't see
    details: "When the analyser can't decompose a condition, it says so — an unresolved branch is a labelled gap, not a silent drop-out. The decisions log tracks what's shipped, what's deferred, and why."
    link: /internal/status
    linkText: Status &amp; decisions
---

## Quick start

```bash
npm install --save-dev @suss/cli @suss/framework-ts-rest @suss/runtime-axios

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
GET /users/:id
  ts-rest handler | handlers.ts:24
  Contract: 200, 404, 500

    -> 404 { error }  when  !params.id
    -> 404 { error }  when  params.id && !db.findById()
    -> 404 { error }  when  params.id && db.findById() && db.findById().deletedAt
    -> 200 { id, name, email }  (default)

    !! Declared response 500 is never produced by the handler
```

That's `suss inspect` on a ts-rest handler. Everything else in the
system — checking, agreement, dedup, downstream tooling — consumes
the JSON form of the same summary.

## Where to next

- **I want to try it in 15 minutes.** → [Tutorial: Get started](/tutorial/get-started).
- **I want to add it to my project.** → [Add suss to a project](/guides/add-to-project) → [Set up CI](/guides/ci-integration).
- **I want to look up a flag or finding.** → [CLI reference](/reference/cli) · [Findings catalog](/reference/findings).
- **I want to understand the premise.** → [Motivation](/motivation) → [Three kinds of truth](/contracts).
- **I want to extract from a new framework.** → [Framework packs](/framework-packs).
- **I want the summary format.** → [Behavioral summary format](/behavioral-summary-format) → [IR reference](/ir-reference).
- **I want to know what's shipped.** → [Status & decisions](/internal/status).
