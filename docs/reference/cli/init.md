---
title: suss init
description: Work out which packs a project needs, install them, and write suss.json so later commands need no flags.
---

# `suss init`

`suss init` looks at a project, works out which packs it needs, and offers to install them and write the configuration. Run it once when you add suss to a repository, so the later commands need no flags.

```
suss init [<directory>] [--plain | --write [--overwrite]]
```

| Argument or flag | Default | What it does |
|---|---|---|
| `<directory>` | the current directory | Where to look. |
| `--plain` | off | Print the commands instead of asking. Piped output and CI print either way. |
| `--write` | off | Print the commands, then write `suss.json` and each pack's config file without asking. A coding agent has no terminal to answer the questions in, so this is how it finishes setting a project up. When a `suss.json` is already there, `init` leaves it alone and says so. |
| `--overwrite` | off | With `--write`, replace a `suss.json` that is already there with what `init` found. `init` refuses it without `--write`. |

## What it reads

It reads `package.json`, the Python manifests and the Gemfile for dependencies, and the directory for schemas and deploy templates. An OpenAPI document is found by its name, `openapi.yaml` or `swagger.json`, or by the version line at its top. At a monorepo root it also reads the workspace declaration, from `package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json` or `turbo.json`, and asks which packages to set up.

Every folder below the root with its own `package.json`, `pyproject.toml` or `Gemfile` is a project of its own, whether or not a workspace file lists it, so a server folder and a client folder side by side each get their commands. A folder below the root is shown when a pack matched there, or when its own manifest could not be read and it has source of its own. A Gemfile that only drives a mobile build, for example, does not get a section.

fetch and Net::HTTP come with the language, so no manifest lists them. Their packs alone set a project up only once a file in the project's own source calls the library, and the report says which file. For TypeScript and JavaScript, the project's own source is what its tsconfig includes, or `src/` when there is no tsconfig. In every language, files under a scripts, tools, config or test directory don't count, and neither do `*.config.*` files or tests.

When the project depends on a framework suss knows and has no pack for, such as Django, tRPC or Grape, the report says so, including when other packs matched.

The commands for a project in a folder below the root name that folder with `--dir` and start every path from the root, so you can paste them where you ran `init`. Each writes its own file in one `summaries/` folder, and a folder with more than one language gets `--lang` on every extract.

## What it writes

Interactively it asks four things: whether to install the packs, whether to write what it found to `suss.json`, whether to run the first extract and check, and whether to write a `.sussignore` and a CI workflow. Nothing reaches disk unless you accept it.

With `--write` it asks nothing. It prints the same commands `--plain` prints, then writes `suss.json` for every project it found packs for, the same selection the interactive form starts with. It leaves the install, the `.sussignore` and the CI workflow to the interactive form.

Either way, writing `suss.json` also writes the config file for each pack that takes one, such as `suss.graphql-ruby.json`, and `suss.json` lists the pack with its file, as in `graphql-ruby=suss.graphql-ruby.json`. The file gets the values a project the library's own generator made has, or the values the project already states elsewhere: the activerecord pack reads which database is behind the connection from the `adapter` lines in `config/database.yml`. A config file that is already there is kept as it is. When a pack needs a value that `init` can't work out, it leaves that pack out of `suss.json` and says what to write, because listing it would stop the whole extract for its language.

`suss.json` is what [`extract`](/reference/cli/extract) reads when it is given no `-f`, and what [`inspect`](/reference/cli/inspect), [`check`](/reference/cli/check) and the MCP server read when they are given nothing. Without the file, those commands pick the same packs `init` would have picked, and print their choice on stderr.

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

`0`, including a `--write` run that left an existing `suss.json` alone. A flag `init` does not take, or `--overwrite` without `--write`, exits `1`. Declining every question, cancelling, and a failed install all end the same way; a failed install prints what npm said and leaves you the command to retry. [Exit codes](/reference/cli/exit-codes) has the rest.
