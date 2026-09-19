---
title: Fix a run that found nothing
description: What to do when extract wrote no summaries, when check compared nothing, and when a pack read your code and understood none of it.
---

# Fix a run that found nothing

A run that produces nothing tells you where it stopped. Start with the
four cases below, then read the pack health block for a pack that ran
and contributed nothing.

## When the first run turns up nothing

Every command that comes up empty says where it stopped. These four
cover most first runs.

### That tsconfig matched no source files

```
No summaries to write in 0.00s.
  That tsconfig matched no source files.
  Check its `include` and `files` patterns against where your source actually lives.

  Where it stopped:
    0  files in the tsconfig
    0  files read
```

suss took the nearest `tsconfig.json`, and that one covers no source.
Nx, project references, and solution-style configs all do this: the
root config lists `"files": []` and points at the configs that do the
work. Pass the one that covers your source:

```bash
npx suss extract -p tsconfig.app.json -f express -o summaries/code.json
```

### No file imports anything the pack looks for

```
No summaries to write in 0.02s.
  No file imports anything hono looks for.
  Either this project does not use it, or your code reaches it through a local wrapper module. suss only recognizes direct imports today.

  Where it stopped:
    26  files in the tsconfig
     0  files read
     0  files importing hono and @hono/zod-openapi
```

The tsconfig is right and the pack is wrong for this project. Re-run
`init` to see which packs match your dependencies. If the library is in
`package.json` but your code imports a wrapper module of your own
rather than the library directly, suss stops at the wrapper.

### A pack found the library and matched nothing

```
Wrote 46 summaries to summaries/code.json in 0.60s

Pack health:
  a pack dropped everything it was holding
    prisma: its import gate found the library and it matched nothing in the bodies it saw (20 unit bodies to look inside, 0 effects recognized)
```

The run succeeded and one pack contributed nothing to it. The usual
cause is a library that is installed but not yet in a usable state.
Prisma is the common one: `@prisma/client` is in `node_modules`, but
until `npx prisma generate` runs, the package exports no model types,
so every `prisma.article.findUnique` call is treated as a call on an opaque
value and the pack classifies none of them.

```bash
npx prisma generate
npx suss extract -p tsconfig.app.json -f express -f prisma -o summaries/code.json
```

Anything with a codegen step behaves the same way: run the generator
first, then extract. The pack-health block appears whenever a pack you
asked for contributes nothing, so it is the line to read before you
conclude that suss cannot see your storage layer.

### Nothing was compared

```
Nothing was compared.

  These summaries cover 20 boundaries on the provider side and none on the client side, so there was no other side to compare against.
  Extract both sides of the boundary into the same folder, then check them together:
    suss extract -p <tsconfig> -f <pack> -o summaries/<name>.json
    suss check --dir summaries/

  26 boundaries had nothing to pair with, so nothing was checked across them.
```

`check` compares two sides, so one side on its own gives it nothing to
do. Twenty Express routes with no `fetch` or axios call sites beside
them means the callers were never extracted, either because they live
in a separate repository or because the pack that reads them was left
off the command.

Extract the other side into the same folder and check them together:

```bash
npx suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json
npx suss check --dir summaries/
```

Where the other side is a schema or a spec rather than code, `contract`
produces it in the same format. A Prisma schema becomes the provider
for your query call sites, an OpenAPI document becomes the provider for
your client. An OpenAPI document beside the handlers it describes is
compared with them too, so a service with its own spec and no client
in the run still gets checked:

```bash
npx suss contract --from prisma prisma/schema.prisma -o summaries/prisma.json
npx suss check --dir summaries/
```

Where the front end really does live in another repository, extract it
there and copy its summary file in. Summaries are portable JSON, and
`check --dir` pairs whatever it reads in a folder regardless of which
run produced it.


## When a pack read your code and understood none of it


A run can finish, write summaries, exit 0, and still have a pack in it
that read your code and understood none of it. Pack health is the block
that says so. Two of its lines, from two different runs:

```
Pack health (2):
  no-output  ts-rest  3 summaries -> 0 transitions
  fn-link    redis    redis.container (2 data)
```

Every line is the same three columns: the code for what happened, the
pack it happened to, and the numbers behind it. The codes are a fixed
list, so `grep no-output` over a CI log finds every pack it happened to
with the counts on the same line.

Five of the codes are about the run in front of you and always print.
The other four are about how a pack was built and wait for `--explain`.

| Code | Prints | What it says |
|---|---|---|
| `threw` | always | A pack's hook threw on a file, and that file was skipped. |
| `no-output` | always | A pack got as far as one stage and produced nothing at the next. |
| `double-match` | always | Two patterns in one pack claimed the same unit. |
| `no-units` | always | A recognizer pack had no units to look inside, because nothing in the run discovers any. |
| `no-helper` | always | A registration helper your config asked for matched no call in the run. |
| `no-version` | `--explain` | The pack declares no version. |
| `fn-link` | `--explain` | A declared pack wrote a link as a function instead of data. |
| `ast-link` | `--explain` | A declared pack reads the syntax tree directly. |
| `no-example` | `--explain` | A declaration ships without an example. |

### `no-output`

The detail is a pair of counts with an arrow between them, and the
arrow is where the pack stopped:

```
no-output  ts-rest   3 summaries -> 0 transitions
no-output  drizzle   4 source files -> 0 units
```

Four pairs can appear, and which one you get says how far the pack got.

| Detail | Meaning |
|---|---|
| `N source files -> 0 units` | Its import gate selected files and it recognised nothing in them. |
| `N unit bodies -> 0 effects` | A recogniser pack looked inside bodies and matched no calls. |
| `N units -> 0 summaries` | It recognised units and bound none of them to a boundary. |
| `N summaries -> 0 transitions` | It wrote summaries and recorded nothing in any of them. |

The usual cause is that your code uses the library in a shape the pack
does not cover yet, or a version it predates. Run the same command with
`--explain` and read the funnel above the health block: it gives every
count for every pack, so you can see which files the gate selected and
decide whether the pack should have recognised them.

A pack whose library is not installed is left out of this check. An
empty run says the dependencies are missing on its own, and saying it
twice reads as two problems.

### `threw`

```
threw  gcs  discoverUnits on src/store.ts (+2 more): cannot read what I was handed
```

The pack's hook threw, the run carried the remaining files, and the
file that threw contributed nothing. Every count for that pack is
lower than what is in your code, so treat the numbers as a floor. This
is a bug in the pack rather than in your project.

### `no-units`

```
no-units  prisma  12 gated files, and no pack in this run discovered a unit in them. ...
```

A recognizer pack reads calls inside units another pack discovers, so
running one on its own walks nothing and writes nothing. The line says
which pack to add: the framework pack that finds this project's
handlers, or `suss init` to work it out. This is a gap in the command
line rather than in your code or in the pack.

### `double-match`

```
double-match  hono  3 units matched twice, second dropped
```

Two of the pack's own discovery patterns claimed the same unit. suss
keeps the first and drops the second, and nobody chose which of the two
was wanted, so the summary may describe the unit the wrong way. Also a
bug in the pack.

### `no-helper`

```
no-helper  express  registerCruds from crud matched no call in this run, so whatever it registers is missing. ...
```

Before extraction, suss reads every function your code hands its app to
and writes down what each one registers. This says one of those helpers
was read and then no call to it matched, so its routes are out of the
run with every other count unchanged. Nothing in your code causes that:
suss found the call site to begin with. Worth an issue with the helper
and one of its call sites.

### The four that wait for `--explain`

These are addressed to whoever wrote the pack. They say nothing about
whether your run is right.

`no-version` means a cache entry cannot tell one build of the pack from
another. `fn-link` and `ast-link` are about how much of a declared pack
is data: a link written as a function, or one that reaches into the
syntax tree, runs on the TypeScript adapter alone and cannot be read by
anything else. `no-example` means a declaration ships with nothing that
runs when it stops matching.

[Write a pack](/packs/write-a-pack) covers the declared form these
three are measured against.
