---
title: suss init
description: Work out which packs a project needs, install them, and write suss.json so later commands need no flags.
---

# `suss init`

Work out which packs this project needs, then offer to set them up.

```
suss init [<directory>] [--plain]
```

| Argument or flag | Default | What it does |
|---|---|---|
| `<directory>` | the current directory | Where to look. |
| `--plain` | off | Print the commands instead of asking. Piped output and CI print either way. |

## What it reads

`package.json` for dependencies, and the directory for schemas and deploy templates. At a monorepo root it also reads the workspace declaration, from `package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json` or `turbo.json`, and asks which packages to set up.

## What it writes

Interactively it asks four things: whether to install the packs, whether to write what it found to `suss.json`, whether to run the first extract and check, and whether to write a `.sussignore` and a CI workflow. Installing defaults to yes and writing files defaults to no, so nothing reaches disk unless you accept it.

`suss.json` is what [`extract`](/reference/cli/extract) reads when it is given no `-f`, and what [`inspect`](/reference/cli/inspect), [`check`](/reference/cli/check) and the MCP server read when they are given nothing. Without the file, those commands pick the same packs `init` would and say so on stderr.

## Example

```bash
$ suss init --plain
```

```
✓ Found 4 things to read in /home/dana/petstore

  Your code
    axios            axios in dependencies
    fetch            TypeScript sources, and fetch reads what the language itself ships

  What your code reaches
    node             TypeScript sources, and node reads what the language itself ships

  Declared contracts
    openapi          an OpenAPI document at openapi.json

1. Install suss

   npm install --save-dev @suss/cli

2. Read each side into one folder

   suss extract -f axios -f fetch -f node -o summaries/code.json
   suss contract --from openapi openapi.json -o summaries/openapi.json

3. Compare them

   suss check --dir summaries/
```

The plain run continues with a `.sussignore` sketch and a note on running it in CI.

## Exit code

`0`, always. Declining every question, cancelling, and a failed install all end the same way; a failed install prints what npm said and leaves you the command to retry. [Exit codes](/reference/cli/exit-codes) has the rest.
