---
layout: home
title: suss, a behavioral analysis tool for TypeScript, Python and Ruby
description: suss reads your code and writes down what it does on every path, then checks that against the clients, specs and infrastructure on the other side. Deterministic, no model in it.

hero:
  name: suss
  text: Code is written faster than anyone can read it. suss tells you what it does.
  tagline: "It reads your code and checks what it does at every boundary, a route, a table or a queue, against the clients, specs and infrastructure on the other side. Deterministic, no model in it. TypeScript, Python and Ruby."
  actions:
    - theme: brand
      text: Quickstart
      link: /start/quickstart
    - theme: alt
      text: Read a pull request
      link: /start/read-a-pull-request
    - theme: alt
      text: GitHub
      link: https://github.com/nimbuscloud-ai/suss
---

## What a change did

`suss inspect --diff` reads the summaries from before a change and the
ones from after, and prints the boundaries whose behavior moved:

```
1 boundary changed: 1 outcome.

~ serves GET /orders/{reference}  src/api.ts::get  (1 outcome)
  outcomes
    ~ responds 200 { reference, total, -placedAt }  otherwise

Changes by file

src/api.ts
  ~ get
```

`placedAt` came off the success body. In the text diff that is one
changed line among however many the pull request has, and a reviewer
going through a thousand of them has to spot it. The description above
did not come from whoever wrote the change; suss worked it out from the
source. Your code never runs, no model is involved, and the same source
gives the same answer every time.

## Three ways to start

- **Run it now.** [Quickstart](/start/quickstart) is `init`, `extract`
  and `inspect` on a project you already have. Nothing to triage; the
  output is a description of the service.
- **Put it on pull requests.** [Read a pull request](/start/read-a-pull-request)
  sets up the GitHub Action that posts the diff above as a comment and
  edits it on every push.
- **Give it to your agent.** [Give your agent suss](/start/give-your-agent-suss)
  is the MCP server, so a coding agent asks what a route returns or what
  writes a table before it edits either one.

## What it reads

suss reads a project through a pack per library: one for the web
framework, one for the ORM. `suss init` works out which packs it needs,
and the [pack catalog](/packs/catalog) lists them. Every pack ships
inside `@suss/cli`, so there is one install.

TypeScript is the furthest along. Python and Ruby read routes and fewer
ORMs, and [Read Python or Ruby](/guides/python-and-ruby) says where each
one stops. Both sides of a boundary have to be in one repository for
suss to compare them, so a front end in a second repository is a second
run for now. [Compatibility](/reference/compatibility) has the rest of
the limits.

## Where to go next

[Four ideas](/start/four-ideas) is the vocabulary the rest of the
documentation uses: boundary, summary, check, pack.

- **Adopting it one step at a time:** [Adopt it step by step](/guides/adopting-suss), then [Run suss in CI](/guides/ci-integration).
- **Comparing the code against a spec you published:** [Check against OpenAPI](/guides/check-against-openapi).
- **Looking something up:** [CLI reference](/reference/cli/) · [Findings catalog](/reference/findings) · [Glossary](/reference/glossary) · [FAQ](/reference/faq).
- **Deciding whether to use it:** [The problem](/why/the-problem) and [Compared to other tools](/why/compared).
- **Your framework is missing:** [Write a pack](/packs/write-a-pack).
- **Consuming the output:** [Summary format](/reference/summary-format), then [IR types](/reference/ir).
