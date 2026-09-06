---
layout: home

hero:
  name: suss
  text: Code is written faster than anyone can read it. suss tells you what it does.
  tagline: "It reads your code and writes down what each endpoint does on every path. Read that on a pull request instead of the diff, hand it to your agent before it edits, or check it against the spec you published. Deterministic, no model in it, TypeScript, Python and Ruby."
  actions:
    - theme: brand
      text: Run it on one service
      link: /guides/adopting-suss
    - theme: alt
      text: Walk an example first
      link: /tutorial/get-started
    - theme: alt
      text: GitHub
      link: https://github.com/nimbuscloud-ai/suss

features:
  - title: What did this pull request do
    details: "Run inspect --diff on the base and the head. It reports which endpoints changed behavior and how, whichever lines the diff touched. A field that left one response branch is one line here and one line in a thousand there."
    link: /guides/ci-integration
    linkText: Put it on pull requests
  - title: Let the agent ask first
    details: "Over MCP the agent can ask what a route reaches, what writes a table and what calls a function, and get file and line for each, from the working tree as it is now. It asks before it changes something instead of grepping and guessing."
    link: /guides/adopting-suss#question-it
    linkText: Set up the MCP server
  - title: Did I break a caller
    details: "You changed what a handler returns. suss compares it against every caller it can see and reports the ones that read a field you stopped sending, or never handle a status you started returning."
    link: /cross-boundary-checking
    linkText: How checking works
  - title: Does the code match the spec
    details: "Point suss at an OpenAPI document, a GraphQL schema, a Prisma schema or a CloudFormation template. It compares the code against what you published and reports where they drifted apart."
    link: /guides/pair-against-openapi
    linkText: Pair against OpenAPI
  - title: Reads what you already wrote
    details: "Thirty-eight packs cover Express, Hono, NestJS, Fastify, Next.js, FastAPI, Rails, Apollo, Prisma, Drizzle, DynamoDB, S3, SQS and more. Point it at a tsconfig or a directory and it works out the rest."
    link: /reference/packages
    linkText: Packs by stack
  - title: Says when it cannot tell
    details: "A call suss could not follow shows up as a gap in the output rather than as silence, so an empty answer never looks like nothing being wrong."
    link: /faq
    linkText: FAQ
---

## Two commands on one service

```bash
npx @suss/cli extract -f express -f prisma -o summaries/api.json
npx @suss/cli inspect summaries/api.json
```

`extract` writes down what each unit does, and `-f` says which packs to read with. `inspect` prints it. There is nothing to triage yet; the output is a description of the service.

## What it prints

Running those on [gothinkster/node-express-realworld-example-app](https://github.com/gothinkster/node-express-realworld-example-app), an Express and Prisma app of about fifty units. It needs `-p tsconfig.app.json` on the extract as well, because its root tsconfig lists no files of its own.

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

postgresql:Article is provided by src/prisma/schema.prisma::Article.

suss could not follow next, so a writer could be hiding behind it.
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

The same questions are available to a coding agent as MCP tools, from a config block in the host:

```json
{
  "mcpServers": {
    "suss": { "command": "npx", "args": ["-y", "@suss/mcp", "/path/to/project"] }
  }
}
```

Compare the code against a schema it already keeps, and findings appear:

```
$ suss check --dir summaries/
Compared 4 boundaries.

  20 provider-side boundaries have no client to compare against.
  5 boundaries had nothing to pair with, so nothing was checked across them.
  Run the same command with --all to list them.

3 findings: 0 error, 3 warning, 0 info
```

One of the three warnings:

```
[WARNING] boundaryFieldUnused
  Comment declares "articleId" and code here writes to it, but no query reads it. suss counts a column as read only when a query selects it, so before you treat the write as pointless, look for code that takes "articleId" off a record it already fetched.
  provider: src/prisma/schema.prisma::Comment (src/prisma/schema.prisma:1)
  consumer: src/prisma/schema.prisma::Comment (src/prisma/schema.prisma:1)
  boundary: prisma (postgresql)
```

## What a change did

`inspect --diff` takes the summary file from before a change and the one from after, and reports what moved:

```
handler:GET /users/{id}
  hono handler
  3 changes
    + 200 { id, status }  when  findUser() && findUser().deletedAt
    - 410 { error }  when  findUser() && findUser().deletedAt
    ~ 200 { id, name, email }  (default)
      -> 200 { id, name }  (default)
```

A deleted account used to get a `410` and now gets a `200` with `status: "deleted"`, and `email` left the response. The response is still a valid `User`, the OpenAPI document still says `200 | 404 | 410`, TypeScript is happy, and every caller that read a `200` as a usable account is now wrong. Types describe structure, and tests cover the cases somebody thought of. suss works out what each path produces and compares that against what the other side does with it, which is where this kind of bug lives. [Motivation](/motivation) goes through the comparison with the tools you already run.

## What you need to know

Four words are the whole tool. A **boundary** is where two units of code meet: an endpoint and its caller, a query and a table, a resolver and a schema. A **summary** is what suss worked out about one unit. A **check** compares the summaries on either side of a boundary. A **pack** teaches suss a library, and one ships for most of the stack already.

- **Adopting it one step at a time:** [Adopting suss](/guides/adopting-suss), then [Set up CI](/guides/ci-integration).
- **Seeing it work end to end first:** [Get started](/tutorial/get-started) builds a small example.
- **Looking something up:** [CLI reference](/reference/cli) · [Findings catalog](/reference/findings) · [Glossary](/glossary) · [FAQ](/faq).
- **Python or Ruby:** [Read a Python or Ruby project](/guides/python-and-ruby).
- **Your framework is missing:** [Write a pack](/guides/writing-a-pack).
- **Consuming the output:** [Summary format](/behavioral-summary-format), then [IR reference](/ir-reference).
