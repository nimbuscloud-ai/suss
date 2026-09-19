---
title: Work across services
description: Extract several services into one folder, pair a handler in one against a client in another, and handle two services that serve the same path.
---

# Work across services

Run one `extract` per service, each into its own file in the same
directory, and one `check --dir` over the directory.

```bash
npx suss extract -p services/auth/tsconfig.json -f hono -o summaries/auth.json
npx suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json
npx suss check --dir summaries/
```

Pairing is by boundary, so a handler in one file and a client in
another compare against each other whichever service produced them.

The team that owns a service owns its extract command, and the
pipeline runs all of them. There is no order to worry about; `check`
reads whatever is in the directory.

## Set them all up at once

At a repo root, `init` reads the workspace declaration, from
`package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json`, or
`turbo.json`, and then asks which packages to set up:

```
◆  Which should suss set up?
│  ◼ @acme/auth        aws-lambda, cloudformation
│  ◼ @acme/web         react, apollo-client
│  ◻ @acme/tooling     node
```

It writes one `suss.json` for the lot.

## Two services that serve the same path

suss identifies an HTTP boundary by its method and path, and nothing
else. Two services that both expose `GET /users` count as one boundary,
so a client of either pairs against both:

```
Providers with no client to compare against:
  GET /users
    get, get      <- two unrelated services, one entry
```

Check one service at a time until this is fixed:

```bash
suss extract -p services/auth/tsconfig.json -f hono -o auth/api.json
suss check --dir auth/
```

## A spec that lives somewhere else

The contract commands, `suss contract --from openapi` and the rest, are
independent of the source repo, so a spec that lives elsewhere still
pairs. Where a front end really does live in another repository,
extract it there and copy its summary file in. Summaries are portable
JSON, and `check --dir` pairs whatever it reads in a folder regardless
of which run produced it.
