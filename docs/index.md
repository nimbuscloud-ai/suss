---
layout: home

hero:
  name: suss
  text: Static behavioral analysis for TypeScript
  tagline: "For every code unit at a boundary — HTTP handler, React component, GraphQL resolver, client call site — suss answers: under what conditions does it produce what outputs?"
  actions:
    - theme: brand
      text: Get started (15 min)
      link: /tutorial/get-started
    - theme: alt
      text: Why suss
      link: /motivation
    - theme: alt
      text: GitHub
      link: https://github.com/nimbuscloud-ai/suss

features:
  - title: Derivation, not specification
    details: "suss reads your source and produces structured behavioral summaries — what the code *does*, across every path. Specifications declare what should happen; observations record what did happen once; derivation is the missing third character."
    link: /contracts
    linkText: Three kinds of truth
  - title: Boundary-aware by construction
    details: "A `BoundaryBinding` carries transport, semantics, and recognition as three sibling layers. REST, GraphQL (resolver + operation), and in-process function calls all coexist in the IR without retrofitting."
    link: /boundary-semantics
    linkText: Boundary semantics
  - title: Extensible via declarative packs
    details: "Framework packs are data, not code. A pack describes how to recognize units in its framework (registrationCall, resolverMap, graphqlHookCall, …); the TypeScript adapter interprets them. New frameworks add one file; no fork of the analyzer."
    link: /framework-packs
    linkText: Write a pack
  - title: Cross-shape checking
    details: "Once summaries exist as a uniform shape, anything producing them pairs automatically. OpenAPI stubs cross-check handler implementations. CloudFormation / SAM templates cross-check API Gateway integrations. Storybook stubs cross-check React components."
    link: /cross-boundary-checking
    linkText: How checking works
  - title: Multi-semantics pairing
    details: "REST pairs by (method, path). GraphQL operations pair with resolvers by type and field, walking nested selections against the schema. Semantics is a discriminated union on the boundary — adding one adds a variant, not a rewrite."
    link: /boundary-semantics
    linkText: The semantics layer
  - title: Honest about limits
    details: Opaque predicates are explicit when the analyzer can't decompose them. The internal decisions log records what's shipped, what's deferred, and why. Features land with real tests; deferrals land with concrete forcing-function criteria.
    link: /internal/status
    linkText: Status & decisions
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
