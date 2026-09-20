---
title: suss contract
description: Turn an OpenAPI document, a deploy template, a schema or another declared source into summaries that pair with extracted ones.
---

# `suss contract`

`suss contract` reads a contract somebody already wrote down, such as an OpenAPI document or a CloudFormation template, and turns it into summaries. Run it on the declared side of a boundary so `check` has something to compare your code against.

```
suss contract --from <source> <spec> [-o <output.json>]
```

`contract` writes the same summary JSON that [`extract`](/reference/cli/extract) writes, so [`check`](/reference/cli/check) pairs a declared boundary with an extracted one the same way it pairs two extracted ones.

| Flag or argument | Default | What it does |
|---|---|---|
| `--from <source>` | required | Which kind of source to read. One of the sources below. |
| `<spec>` | required | A local path or an `http(s)` URL. |
| `--code-scope <instance>=<dir>` | none | Where a deployable unit's code is. Repeatable. Terraform only. |
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

[Contract sources](/packs/contract-sources) describes what each reader produces.

Team-authored intent docs are not a `--from` source. `suss check` reads them directly:

```bash
suss check --dir summaries/ --intent intent/
```

## Saying where a unit's code is

A Terraform configuration says which handler a function runs, and it never says which directory a container's image was built from, because the build happens outside the configuration. So `check` reports a container deployable as `runtimeScopeUnknown` and pairs no code against it.

`--code-scope` tells it where, one unit at a time:

```bash
suss contract --from terraform infra/ \
  --code-scope api/web=services/api \
  --code-scope worker=services/worker -o infra.json
```

The name on the left is the unit's instance name, the same one on the summary: `confirm` for a Lambda resource labelled `confirm`, `api/web` for the `web` container of a task definition labelled `api`, and `module.orders.writer` for a resource read through a `module` block. The path on the right is the directory the unit's code is in.

Pointing two units at one directory makes that directory decide nothing. A file in it that states no unit of its own is contested between them, so it pairs with neither, and `check` says why. Give each unit the narrowest directory that contains only its code.

## Reading from a URL

Given an `http(s)` URL, suss fetches the document, writes it to a temp file, parses it the way it would parse a local file, and deletes the temp file. That covers a vendor spec hosted on GitHub or a docs site. The extension on the URL path decides the parser: `.json` gets the JSON parser, anything else, including no extension at all, gets YAML.

A summary read from a URL is labelled with that URL, so it still points at where the document came from.

## What it writes

Without `-o`, the summary JSON goes to stdout. With `-o`, the JSON goes to the file and one line goes to stderr: `Wrote 19 summaries to /path/provider.json`. A source that declares nothing suss could read writes `<spec> declares no boundaries suss could read.` instead.

## Example

```bash
$ suss contract --from openapi openapi.json -o summaries/provider.json
Wrote 19 summaries to /home/dana/petstore/summaries/provider.json
```

[Exit codes](/reference/cli/exit-codes) lists what `contract` returns to the shell.
