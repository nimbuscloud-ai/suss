---
title: suss contract
description: Turn an OpenAPI document, a deploy template, a schema or another declared source into summaries that pair with extracted ones.
---

# `suss contract`

Read a declared source into summaries.

```
suss contract --from <source> <spec> [-o <output.json>]
```

`contract` writes the same summary JSON that [`extract`](/reference/cli/extract) writes, so [`check`](/reference/cli/check) pairs a declared boundary with an extracted one the same way it pairs two extracted ones.

| Flag or argument | Default | What it does |
|---|---|---|
| `--from <source>` | required | Which kind of source to read. One of the ten below. |
| `<spec>` | required | A local path or an `http(s)` URL. |
| `-o`, `--output <path>` | stdout | Write the summary JSON to a file. |

## Sources

| `--from` | What the path points at |
|---|---|
| `openapi` | An OpenAPI 3.x document, JSON or YAML. |
| `cloudformation` | A CloudFormation or SAM template, JSON or YAML: API Gateway routes, SQS event source mappings, Lambda environment. |
| `terraform` | One `.tf` file, or the directory a module lives in, since a module states its resources across several files. AWS and Google resources are both read. |
| `serverless` | A Serverless Framework service file, or the directory it is in. `${self:...}` resolves against the document; a reference a deploy supplies keeps its token. |
| `wrangler` | A Cloudflare Worker's `wrangler.toml` or `wrangler.jsonc`, or the directory the Worker lives in. |
| `appsync` | A CloudFormation template with `AWS::AppSync::*` resources. |
| `prisma` | A `schema.prisma` file. |
| `graphql` | A GraphQL SDL file. Each Query, Mutation and Subscription field becomes a resolver-kind summary. |
| `graphql-documents` | Committed `.graphql` or `.gql` operation documents, one file or a directory walked recursively. Each operation becomes a client-kind summary, and fragment spreads are inlined across the whole read set. |
| `storybook` | A CSF3 `.stories.ts` or `.stories.tsx` file, or a directory of them walked recursively. |

[Contract sources](/packs/contract-sources) says what each reader produces.

Team-authored intent docs are not a `--from` source. `suss check` reads them directly:

```bash
suss check --dir summaries/ --intent intent/
```

## Reading from a URL

Given an `http(s)` URL, suss fetches the document, writes it to a temp file, parses it the way it would parse a local file, and deletes the temp file. That covers a vendor spec hosted on GitHub or a docs site. The extension on the URL path decides the parser: `.json` gets the JSON parser, anything else, including no extension at all, gets YAML.

A summary read from a URL is labelled by the URL rather than by the temp path, so the identity survives the fetch.

## What it writes

Without `-o`, the summary JSON goes to stdout. With `-o`, the JSON goes to the file and one line goes to stderr: `Wrote 19 summaries to /path/provider.json`. A source that declares nothing suss could read writes `<spec> declares no boundaries suss could read.` instead.

## Example

```bash
$ suss contract --from openapi openapi.json -o summaries/provider.json
Wrote 19 summaries to /home/dana/petstore/summaries/provider.json
```

[Exit codes](/reference/cli/exit-codes) says what `contract` returns to the shell.
