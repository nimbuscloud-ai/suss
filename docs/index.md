---
layout: home

hero:
  name: suss
  text: A machine-readable summary of what your code actually does
  tagline: "suss derives it from your source, path by path, with no annotations to write. Diff behavior on a pull request, check a caller against its handler, or catch the bugs that compile and pass the tests."
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
    details: "Code compiles, tests pass, types line up, and the consumer still receives a 200 the provider stopped producing. suss compares what the two sides actually do, at the branch level."
    link: /motivation
    linkText: Why suss
  - title: One model across every boundary
    details: "HTTP handlers, GraphQL resolvers, React components, queue producers, storage calls, and client call sites all produce summaries in the same form. Cross-boundary checking means diffing two summaries."
    link: /glossary
    linkText: Glossary
  - title: Add a framework in one file
    details: "Twenty-two packs ship, for HTTP handlers, GraphQL resolvers, React components, queue consumers, database calls and client call sites. Adding a framework means writing a small pack, not forking the analyzer."
    link: /guides/writing-a-pack
    linkText: Write a pack
  - title: Compare against declared contracts
    details: "Check your handlers against an OpenAPI spec, your resolvers against a GraphQL schema, your components against Storybook. A contract and your source come out in the same form, so comparing them is one step."
    link: /cross-boundary-checking
    linkText: How checking works
  - title: Runs on the code you already have
    details: "Point suss at your tsconfig and get summaries from the source as it stands. No annotations or decorators to add."
    link: /guides/add-to-project
    linkText: Add to a project
  - title: More than TypeScript
    details: "TypeScript and JavaScript through the CLI. Python routes (flask-restx, FastAPI) and graphql-ruby fields through their own adapters. suss treats CloudFormation, SAM and serverless.yml as declared contracts, so the deployment and the code it deploys compare directly."
    link: /guides/python-and-ruby
    linkText: Python and Ruby
  - title: Explicit about what it can't analyze
    details: "When a condition is too dynamic for static analysis, the branch is labeled unresolved rather than silently dropped. Coverage stops are visible in the output."
    link: /motivation#what-suss-is-not
    linkText: What suss is not
---

## Quick start

```bash
npm install --save-dev @suss/cli @suss/framework-hono @suss/client-web

# Read each side of the boundary
suss extract -f hono -o summaries/api.json
suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json

# Compare them
suss check --dir summaries/

# Read a summary file back
suss inspect summaries/api.json
```

## What a summary looks like

```
src/api.ts
├─ GET /users/:id  (hono handler | line 11)
│      if  !findUser()
│        -> 404 { error }
│      elif  findUser().deletedAt
│        -> 410 { error }
│      else
│        -> 200 { id, name }
│
├─ POST /users  (hono handler | line 25)
│      if  !c.req.json().name
│        -> 400 "name is required"
│      else
│        -> 201 { id, name }
│
└─ GET /legacy/:id  (hono handler | line 35)
       -> 302

3 summaries.
```

`suss inspect` rendering three summaries from one file. Each header gives the endpoint, the pack that recognized it, and the source line. Under it, you get every path the code can take, with the status and the body structure that path produces. Where a handler has side effects, they appear as `+` lines, and a `!!` line marks a gap between what a declared contract promises and what the code does.

`@suss/checker` and downstream tools consume the same data as JSON. `inspect` is a renderer over it.

## Reading order

Everything here is built from four concepts: a **boundary** is where two units of code meet; a **summary** is what suss derives about a unit's behavior; a **check** pairs summaries and reports findings where they disagree; a **pack** teaches suss a framework. Beyond derivation, team-authored intent docs can declare what a boundary *should* do and be checked the same way (see [Contracts](/contracts)).

The navigation splits conceptual material into **Understanding suss** (for users) and **Internals** (for contributors). Common entry points:

- **First time on the site:** [Get started](/tutorial/get-started) walks the smallest end-to-end example, then [Motivation](/motivation) explains why this layer exists.
- **Adding suss to an existing project:** [Add suss to a project](/guides/add-to-project), then [Set up CI](/guides/ci-integration).
- **Looking up a flag, finding, or term:** [CLI reference](/reference/cli) · [Findings catalog](/reference/findings) · [Glossary](/glossary) · [FAQ](/faq).
- **Working in Python or Ruby:** [Read a Python or Ruby project](/guides/python-and-ruby).
- **Choosing packs for your stack:** [Packages & packs](/reference/packages).
- **Writing or modifying a pack:** [Write a pack](/guides/writing-a-pack).
- **Consuming the summary format:** [Behavioral summary format](/behavioral-summary-format), then [IR reference](/ir-reference).
