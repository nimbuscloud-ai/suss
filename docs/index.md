---
layout: home

hero:
  name: suss
  text: Find out what your code does to the code around it
  tagline: "Change an endpoint and see which callers break. Ask which code writes a table. Check your handlers against the spec you published. suss reads the source you already have, no annotations and nothing to run."
  actions:
    - theme: brand
      text: Run it on your project
      link: /guides/add-to-project
    - theme: alt
      text: Walk an example first
      link: /tutorial/get-started
    - theme: alt
      text: GitHub
      link: https://github.com/nimbuscloud-ai/suss

features:
  - title: Did I break a caller
    details: "You changed what a handler returns. suss compares it against every caller it can see and reports the ones that read a field you stopped sending, or never handle a status you started returning."
    link: /cross-boundary-checking
    linkText: How checking works
  - title: Who touches this table
    details: "Ask which code writes a table, which units call a function, or what an endpoint reaches, and get the file and line for each. Useful before a migration, and useful when the answer is nobody."
    link: /reference/cli#ask
    linkText: Ask a question
  - title: Does the code match the spec
    details: "Point suss at an OpenAPI document, a GraphQL schema, a Prisma schema, or a CloudFormation template. It compares the code against what you published and reports where they drifted apart."
    link: /guides/pair-against-openapi
    linkText: Pair against OpenAPI
  - title: Catch it in CI
    details: "A check exits non-zero on an error, so a pull request that breaks a caller fails before it merges. Warnings stay warnings until you decide otherwise."
    link: /guides/ci-integration
    linkText: Set up CI
  - title: Reads what you already wrote
    details: "Twenty-two packs cover Express, Hono, NestJS, Fastify, Next.js, Apollo, Prisma, Drizzle, Redis, DynamoDB, S3, SQS and more, in TypeScript, Python and Ruby. Point it at a tsconfig and it works out the rest."
    link: /reference/packages
    linkText: Packs by stack
  - title: Says when it cannot tell
    details: "A call suss could not follow shows up as a gap in the output rather than as silence, so an empty answer never reads as nothing being wrong."
    link: /faq
    linkText: FAQ
---

## Three commands on your own project

```bash
npx @suss/cli init          # works out which packs your project needs
npx @suss/cli extract -f express -f prisma -o summaries/api.json
npx @suss/cli check --dir summaries/
```

`init` reads your dependencies and sets up the packs for your stack. `extract` writes down what each unit does, and `-f` says which packs to read with, the ones `init` picked. `check` compares the pieces that meet and reports where they disagree.

## What it tells you

Running those on [gothinkster/node-express-realworld-example-app](https://github.com/gothinkster/node-express-realworld-example-app), an Express and Prisma app of about fifty units. It needs `-p tsconfig.app.json` on the extract as well, because its root tsconfig lists no files of its own:

```
$ suss check --dir summaries/
Compared 4 boundaries.

  20 provider-side boundaries have no client to compare against.
  5 boundaries had nothing to pair with, so nothing was checked across them.
  Run the same command with --all to list them.

19 findings: 0 error, 3 warning, 16 info
```

`--all` prints them. One of the three warnings:

```
[WARNING] boundaryFieldUnused
  Comment declares "articleId" and code here writes it, but no query asks for it back. A field the code takes off a record a query returned never counts as a read here, so look for one before treating the write as pointless.
  provider: src/prisma/schema.prisma::Comment (src/prisma/schema.prisma:1)
  consumer: src/prisma/schema.prisma::Comment (src/prisma/schema.prisma:1)
  boundary: prisma (postgresql)
```

Ask about a table before you change it:

```
$ suss ask 'what writes postgresql:Article' --dir summaries/
6 units write postgresql:Article:
  createArticle (src/app/routes/article/article.service.ts:162) through prisma.article.create
  updateArticle (src/app/routes/article/article.service.ts:289) through prisma.article.update
  deleteArticle (src/app/routes/article/article.service.ts:385) through prisma.article.delete
  favoriteArticle (src/app/routes/article/article.service.ts:562) through prisma.article.update
  unfavoriteArticle (src/app/routes/article/article.service.ts:608) through prisma.article.update
  disconnectArticlesTags (src/app/routes/article/article.service.ts:276) through prisma.article.update
```

Ask what an endpoint reaches, and why:

```
$ suss ask 'what does GET /articles/:slug reach' --dir summaries/
GET /articles/:slug, 1 summary, reaches 1 boundary:
  reads postgresql:Article  through prisma.article.findUnique, by calling getArticle

$ suss ask 'why does GET /articles/:slug reach postgresql:Article' --dir summaries/
get reaches postgresql:Article:
  get -> getArticle -> prisma.article.findUnique
  get (article.controller.ts:90) calls getArticle, and that call runs getArticle (article.service.ts:241)
  getArticle reads postgresql:Article through prisma.article.findUnique (article.service.ts:241)
```

Every question also takes a symbol form for typing quickly: `w<- postgresql:Article`, `getArticle ->`, `<- src/orderStore.ts`.

## The bug this exists for

A handler used to return `404` for a deleted account and now returns `200` with `status: "deleted"`. The response is a valid `User`, the status is a valid status, the OpenAPI document still says `200 | 404`, and TypeScript is happy. Every caller that read a `200` as "this account is usable" is now wrong, and nothing in your pipeline says so.

Types describe structure, and `User` is still `User`. Tests cover the cases somebody thought of. suss works out what each path actually produces and compares that against what the other side does with it, which is where this class of bug lives. [Motivation](/motivation) goes through the comparison with the tools you already run.

## What you need to know

Four words carry the whole tool. A **boundary** is where two units of code meet: an endpoint and its caller, a query and a table, a resolver and a schema. A **summary** is what suss worked out about one unit. A **check** compares the summaries on either side of a boundary. A **pack** teaches suss a library, and one ships for most of the stack already.

- **Adding it to a project you work on:** [Add suss to a project](/guides/add-to-project), then [Set up CI](/guides/ci-integration).
- **Seeing it work end to end first:** [Get started](/tutorial/get-started) builds a small example.
- **Looking something up:** [CLI reference](/reference/cli) · [Findings catalog](/reference/findings) · [Glossary](/glossary) · [FAQ](/faq).
- **Python or Ruby:** [Read a Python or Ruby project](/guides/python-and-ruby).
- **Your framework is missing:** [Write a pack](/guides/writing-a-pack).
- **Consuming the output:** [Summary format](/behavioral-summary-format), then [IR reference](/ir-reference).
