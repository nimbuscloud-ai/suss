---
title: suss map
description: Write one HTML page that shows a project's routes, GraphQL fields, tables and env vars, what each route reaches, and where suss could not follow the code. The page opens from disk.
---

# `suss map`

`suss map` reads your project, checks it, and writes one HTML page that shows what the code serves and what it touches. Run it first on a project you have not read with suss before.

<a href="/examples/lobsters.html" target="_blank">See an example</a>: lobsters at a pinned commit, with every link going to that commit on GitHub. There is also <a href="/examples/full-stack-fastapi-template.html" target="_blank">the FastAPI template</a>.

```
suss map [<directory>] [--dir <summaries>] [-o <page.html>] [--links editor|github] [--cache-dir <path>] [--jobs <n>] [--read-timeout <minutes>] [--read-memory <MB>]
```

```
$ suss map
suss map wrote .suss/map.html
  Routes        200 · 83 write a table
  Tables        30
  Env vars      17
  Checked       1 pair · 1 finding
  Not followed  143 calls in 90 functions · 200 routes affected
```

| Flag or argument | Default | What it does |
|---|---|---|
| `<directory>` | the working directory | The project to read. |
| `--dir <path>` | none | Map summaries already in this folder, instead of reading the project. The summaries can come from several repositories. |
| `-o`, `--out <path>` | `.suss/map.html` | Where to write the page. |
| `--links <target>` | `editor` | `editor` links each line to the file on disk, in VS Code, Cursor or the browser, which the page lets you pick. `github` links to the file on GitHub at the commit that was read, and leaves this machine's folders out of the page. Use `github` for a page you publish. |
| `--cache-dir <path>` | `.suss` in the project | Where the page, the summaries and the extraction cache go. See [Where suss writes](/reference/cli/#where-suss-writes). |
| `--jobs <n>` | up to 4 | How many reads run at once. |
| `--read-timeout <minutes>` | `20` | How long one read may run before it is stopped. `0` turns the limit off. |
| `--read-memory <MB>` | the heap one `suss` run gets, at most 8192 | The heap one read may grow to. |

`suss map` reads the project the way a bare [`suss check`](/reference/cli/check) does: the reads `suss.json` lists, or the ones [`suss init`](/reference/cli/init) would pick when there is no file, each in its own process with a line on stderr as it starts and ends. A read that fails or runs past its limit is left out and the page shows what the other reads found. See [Reading every read of a project](/reference/cli/check#reading-every-read-of-a-project). It keeps the summaries in `.suss/summaries`, so you can ask about anything on the page:

```bash
suss ask "what does app/controllers/comments_controller.rb::CommentsController.create reach" --dir .suss/summaries
```

## What the page shows

The page opens from disk and loads nothing from the network. Its styles, script and data are inside the file.

- **Tiles** count the routes and GraphQL fields the code serves, the tables, the env vars, the pairs `check` compared, and the calls suss could not follow. Each count opens the list filtered to it.
- **Worth knowing** lists up to five cards. Each card kind has a fixed rule over the facts below, and the rule shows on hover.
- **Browse** lists every route, field, GraphQL type, page, table and env var, with filters. Clicking one opens it: a route's statuses and the conditions on each, the tables and variables it reaches, its callers, and the calls on the way suss could not follow.
- **Coverage** lists each read and what it found, each spec and how much of it the code serves, what `check` compared, and the calls suss could not follow most often.

Press `/` or Cmd-K to jump to anything by name.

Every number on the page is one another command also gives:

| On the page | The same from |
|---|---|
| A route's statuses and conditions | `suss inspect <file>` |
| The tables and variables a route reaches | `suss ask "what does <unit> reach"` |
| The places that write a table | `suss ask "what writes <table>"` |
| Callers and findings | `suss check --dir <summaries> --json` |

A link to a read or a write goes to the line of the call. When a summary has no line for a call, the link goes to the start of the function that makes it, and says "in" that function.

## The cards

| Card | When it appears |
|---|---|
| Finding | `check` reported it between an entry point and code in this repo that calls it, with both sides read from source. |
| Most tables written | The entry point whose reach writes the most tables, when it writes three or more. |
| GET routes that write | GET routes whose reach writes a table. |
| Fields with no caller here | Query and Mutation fields `check` paired with no operation in this repo, when at least one other field has one. |
| Most-written table | The table the most entry points write, when five or more do, with each place that writes it. |
| Shared early return | An outcome with a status of 300 or more that a middleware or filter adds to three or more entry points. |
| Not read | Entry points whose own summary records an outcome suss did not read, when that is half of them or more. It always comes last. |

## Summaries from several repositories

Each summary records the git repository it was extracted in, its remote, and the commit. When a `--dir` folder has summaries from more than one repository, two routes with the same path and file in different repositories stay apart, a filter picks a repository, callers say which one they are in, and links go to each repository's own commit on GitHub. With one repository, the page looks the same as before.

## Exit codes

| Code | What happened |
|---|---|
| `0` | The page was written, whether or not anything paired. |
| `1` | No pack matched the project, so there was nothing to map, or a flag was wrong. |

## Rebuilding the examples

The examples come from public apps at the commits `tools/first-run/repos.json` pins. Rebuild them with each release:

```bash
npm run build
node scripts/buildMapExamples.mjs
```

The script clones each app at its pin, runs `suss init --write` and `suss map --links github`, and writes the pages to `docs/public/examples`.
