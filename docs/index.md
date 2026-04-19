---
layout: home

hero:
  name: suss
  text: Extract every execution path your TypeScript code takes
  tagline: "Structured summaries you can compare against specs, tests, or other implementations."
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
    details: "Specs declare what should happen. Tests record what happened, once. suss derives the third thing: what the code actually does, on every path."
    link: /contracts
    linkText: Three kinds of truth
  - title: One model across every boundary
    details: "HTTP handlers, GraphQL resolvers, React components, and client call sites all produce the same structured summary. Comparing across boundaries reduces to diffing two summaries."
    link: /boundary-semantics
    linkText: Boundary semantics
  - title: Add a framework in one file
    details: "ts-rest, Express, Fastify, React, Apollo, and React Router ship in the box. New frameworks are a small declarative pack — no fork of the analyser."
    link: /framework-packs
    linkText: Write a pack
  - title: Find where artifacts disagree
    details: "Point suss at two artifacts and it reports where they diverge. OpenAPI against handlers, CloudFormation against API Gateway, Storybook against components, provider against consumer."
    link: /cross-boundary-checking
    linkText: How checking works
  - title: Runs on the code you already have
    details: "No annotations, no decorators, no rewrites. Point suss at your tsconfig and get summaries from the source as it stands today."
    link: /guides/add-to-project
    linkText: Add to a project
  - title: Explicit about what it can't analyse
    details: "When a condition is too dynamic for static analysis, the branch is labelled unresolved rather than silently dropped. You see exactly where coverage stops."
    link: /motivation#what-suss-is-not
    linkText: What suss is not
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

    if  !params.id
      -> 404 { error }
    elif  !db.findById()
      -> 404 { error }
    elif  db.findById().deletedAt
      -> 404 { error }
    else
      -> 200 { id, name, email }

    !! Declared response 500 is never produced by the handler
```

That's `suss inspect` on a ts-rest handler. Every path through the
function appears as a branch with its own output shape; everything
else in the system (checking, agreement, dedup, downstream tooling)
consumes the JSON form of the same summary.

## Where to next

- **I want to try it in 15 minutes.** → [Tutorial: Get started](/tutorial/get-started).
- **I want to add it to my project.** → [Add suss to a project](/guides/add-to-project) → [Set up CI](/guides/ci-integration).
- **I want to look up a flag or finding.** → [CLI reference](/reference/cli) · [Findings catalog](/reference/findings).
- **I want to understand the premise.** → [Motivation](/motivation) → [Three kinds of truth](/contracts).
- **I want to extract from a new framework.** → [Framework packs](/framework-packs).
- **I want the summary format.** → [Behavioral summary format](/behavioral-summary-format) → [IR reference](/ir-reference).
- **I want to know what's shipped.** → [Status & decisions](/internal/status).
