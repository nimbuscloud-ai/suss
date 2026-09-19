---
title: suss init
description: Work out which packs a project needs, install them, and write suss.json so later commands need no flags.
---

# `suss init`

Work out which packs this project needs, then offer to install them.

**What it does.** It reads `package.json`, looks for schemas and deploy
templates on disk, and maps what it finds to packs. Then it asks whether
to install them, whether to write what it found to `suss.json`, whether
to run the first extract and check, and whether to write a `.sussignore`
and a CI workflow. Installing defaults to yes; writing files defaults
to no. Nothing reaches disk unless you accept it.

`suss.json` is what `extract` reads when it is given no `-f`, and what
`inspect`, `check` and the MCP server read when they are given nothing.
Without the file, those commands pick the same packs `init` would and
say so, so `init` is the way to make the choice stick.

At a monorepo root it reads the workspace declaration from
`package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json`, or
`turbo.json`, and asks which packages to set up.

```
suss init [DIRECTORY] [--plain]
```

| Flag | Description |
|---|---|
| `DIRECTORY` | Where to look. Default: the current directory. |
| `--plain` | Print the commands instead of asking. Piped or in CI, it prints either way. |

`init` always exits `0`. [Exit codes](/reference/cli/exit-codes#suss-init) says what that covers.

