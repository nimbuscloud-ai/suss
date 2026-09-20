---
layout: home
title: suss, a behavioral analysis tool for TypeScript, Python and Ruby
description: suss reads your code and writes down what it does on every path, then checks that against the clients, specs and infrastructure on the other side. It works on TypeScript, Python and Ruby, and no model is involved.

hero:
  name: suss
  text: Code is written faster than anyone can read it. suss tells you what it does.
  tagline: "It reads your TypeScript, Python or Ruby and checks what the code does at every boundary, such as a route or a table, against the clients, specs and infrastructure on the other side. No model is involved, so the same code gives you the same answer every time."
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
changed line among all the others, and the reviewer has to notice it.
Nobody wrote the description above by hand. suss worked it out from the
source, without running your code and without a model, so the same
source gives you the same answer every time.

## Goals

suss should be deterministic, complete, fast and incremental.

Deterministic means no model is involved, so the same source gives the same summaries and every finding has a file and a line you can go and look at. Complete means a summary lists what a unit does on every path it can take, including the branch nobody wrote a test for.

Fast means reading a project takes seconds and a run is never the slow part of a pull request. A large project that takes minutes today is a bug. Incremental means a project is read once, and after that a run reads the files that changed and whatever depends on them, both in the CLI and in the [GitHub Action](/guides/ci-integration#caching-and-the-push-trigger).

[Compared to other tools](/why/compared) has the numbers for the cases where grep or a model does as well.

## Three ways to start

- **Run it now.** [Quickstart](/start/quickstart) walks you through
  `init`, `extract` and `inspect` on a project you already have. There is
  nothing to triage at the end of it. What you get is a description of
  your service.
- **Put it on pull requests.** [Read a pull request](/start/read-a-pull-request)
  sets up the GitHub Action that posts the diff above as a comment and
  edits it on every push.
- **Give it to your agent.** [Give your agent suss](/start/give-your-agent-suss)
  sets up the MCP server, so your coding agent can ask what a route
  returns or what writes a table before it edits either one.

## What it reads

suss reads a project through one pack per library, so you get a pack for
your web framework and another for your ORM. `suss init` works out which
packs you need, and the [pack catalog](/packs/catalog) lists them. Every
pack ships inside `@suss/cli`, so there is one install.

TypeScript is the furthest along. In Python and Ruby, suss reads routes
and a smaller set of ORMs, and where each language stops is covered in
[Read Python or Ruby](/guides/python-and-ruby). Both sides of a boundary
have to be in one repository for suss to compare them, so a front end in
a second repository is a second run for now.
[Compatibility](/reference/compatibility) has the rest of the limits.

## Where to go next

[Four ideas](/start/four-ideas) explains the four words the rest of the
documentation leans on: boundary, summary, check and pack.

- **Adopting it one step at a time:** [Adopt it step by step](/guides/adopting-suss), then [Run suss in CI](/guides/ci-integration).
- **Comparing the code against a spec you published:** [Check against OpenAPI](/guides/check-against-openapi).
- **Looking something up:** [CLI reference](/reference/cli/) · [Findings catalog](/reference/findings) · [Glossary](/reference/glossary) · [FAQ](/reference/faq).
- **Deciding whether to use it:** [The problem](/why/the-problem) and [Compared to other tools](/why/compared).
- **Your framework is missing:** [Write a pack](/packs/write-a-pack).
- **Consuming the output:** [Summary format](/reference/summary-format), then [IR types](/reference/ir).
