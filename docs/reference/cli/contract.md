---
title: suss contract
description: Turn an OpenAPI document, a CloudFormation template, a Prisma schema or another declared source into summaries that pair with extracted ones.
---

# `suss contract`

Generate summaries from a declared contract instead of from code.

**What it does.** It reads a specification (OpenAPI, CloudFormation,
Storybook stories, AppSync schema) and emits the same
`BehavioralSummary` structure that `extract` produces. The point is not
to render the spec as JSON. The point is to produce a summary with
declared behavior, so the cross-boundary checker can pair it with an
extracted summary the same way it would pair two extracted
summaries.

Use cases:
- A third-party API ships an OpenAPI spec. You want to verify your
  client handles every status the spec declares.
- Your CloudFormation template declares an API Gateway route. You
  want to check that the Lambda handler implements every method the
  template registers.
- A Storybook story declares the props it passes to a component.
  You want to check that the component handles every prop variant
  the stories cover.

```
suss contract --from SOURCE SPEC [-o OUTPUT]
```

`SPEC` is either a local file path or an `http(s)` URL. Given a URL,
suss fetches the document, writes it to a temp file, and parses it
the same way as a local spec. That helps with vendor specs hosted on
GitHub or a docs site, e.g.
`https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml`.
The extension on the fetched file decides which parser suss uses
(`.json` → JSON, anything else including no extension → YAML).

| Flag | Description |
|---|---|
| `--from SOURCE` | Contract source kind. See [contract sources](/reference/cli/contract#contract-sources) below. |
| `-o`, `--output PATH` | Write JSON to file. Default: stdout. |

## Contract sources

| Source | Package | Input |
|---|---|---|
| `openapi` | `@suss/contract-openapi` | OpenAPI 3.x JSON or YAML |
| `cloudformation` | `@suss/contract-cloudformation` | CFN / SAM template (JSON or YAML) with API Gateway REST / HTTP API resources |
| `serverless` | `@suss/contract-serverless` | A Serverless Framework service file. The path points at the file or at the directory containing it. The reader restates the service in SAM's forms and hands them to the CloudFormation reader, so a route, a queue consumer or an environment contract comes out the same whichever manifest declared it. `${self:...}` resolves against the document; a reference that a deploy supplies keeps its token. |
| `storybook` | `@suss/contract-storybook` | CSF3 `.stories.ts` / `.stories.tsx` file or directory of stories |
| `appsync` | `@suss/contract-appsync` | CFN template with `AWS::AppSync::*` resources |
| `prisma` | `@suss/contract-prisma` | `schema.prisma` file (Postgres / MySQL / SQLite datasources) |
| `graphql` | `@suss/contract-graphql` | Plain GraphQL SDL file. Each Query / Mutation / Subscription field becomes a resolver-kind summary. |
| `graphql-documents` | `@suss/contract-graphql` | Committed `.graphql` / `.gql` operation documents, a single file or a directory walked recursively. Each query / mutation / subscription becomes a client-kind summary, so a repo that keeps its operations in files pairs against its resolvers without suss having to trace any call site. Fragment spreads are inlined across the whole read set. |

Team-authored intent specs are not a `--from` source. They are their own
artifact stream, read directly by `suss check`:

```bash
suss check --dir summaries/ --intent intent/
```

[Contract sources](/packs/contract-sources) describes what each reader
takes and what it produces. [Exit codes](/reference/cli/exit-codes#suss-contract)
says what `contract` returns to the shell.

