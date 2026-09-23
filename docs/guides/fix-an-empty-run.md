---
title: Fix a run that found nothing
description: What each empty-run message means when extract wrote no summaries, when check compared nothing, and when a pack read your code and recognized none of it.
---

# Fix a run that found nothing

Read the message first. A command that comes up empty prints the stage where it stopped, and that stage is where the fix goes.

Run the command again with `--explain` to see the count at every stage, pack by pack:

```bash
npx suss extract -p tsconfig.json -f hono --explain
```

## That tsconfig matched no source files

```
No summaries to write in 0.00s.
  That tsconfig matched no source files.
  Check its `include` and `files` patterns against where your source actually lives.

  Where it stopped:
    0  files in the tsconfig
    0  files read
    0  files importing hono and @hono/zod-openapi
    0  boundaries recognized by hono
    0  summaries from hono
    0  of those, summaries saying what hono does
```

suss took the nearest `tsconfig.json`, and that one covers no source. In an Nx or Angular layout the root config is often `"files": []`, with the app's own config next to it. Pass the one that covers your source:

```bash
npx suss extract -p tsconfig.app.json -f express -o summaries/code.json
```

suss follows a solution-style root on its own. That is a root with `"files": []` and a `references` array, and suss reads every file the referenced configs list. This message comes from a root that has neither files nor references.

## A package the pack needs is not installed

```
No summaries to write in 0.43s.
  1 file imports @hono/zod-openapi, but that package is not installed here.
  suss cannot see what a call does without the package behind it.
  Install this project's dependencies, then run the command again.
```

Several packs resolve symbols through the library's own types, so they need the package on disk. Install the project's dependencies and run it again. Packs that read a file instead of a symbol work without an install, including the AWS pack reading your SAM template.

## No file imports anything the pack looks for

```
No summaries to write in 0.02s.
  No file imports anything hono looks for.

  Where it stopped:
    1  files in the tsconfig
    0  files read
    0  files importing hono and @hono/zod-openapi
```

The tsconfig is right and the pack is wrong for this project. Re-run `init` to see which packs match your dependencies:

```bash
npx suss init --plain
```

suss reads through a module of your own that wraps the framework. That module imports the framework itself, so it counts in the line above. suss follows the app object through it, so a route written inside `registerHealth(app)` still comes out as a route. When the framework import is inside a package suss cannot read at all, write a [dependency stub](/guides/teach-a-dependency) for that package.

## A pack read your code and recognized none of it

A run can write summaries, exit 0, and still have a pack in it that read your code and matched nothing. The pack health block reports that:

```
Wrote 1 summary to summaries/code.json in 0.57s

Pack health (1):
  no-output  prisma  1 unit bodies -> 0 effects
```

Each line has three columns: a code for what happened, the pack, and the counts. The codes are a fixed list, so `grep no-output` over a CI log finds every one with its counts on the same line.

The `prisma` pack matches a call by the type of the thing it is called on, so it classifies `db.user.findUnique(...)` only when `db` resolves to the generated `PrismaClient` with a `user` model on it. Two things break that resolution and give you this line:

- **The `@prisma/client` your code imports has no model types in it.** `npx prisma generate` has not run, so the package is still the stub a fresh install ships, where `PrismaClient` is `any`. Generate, then extract again:

  ```bash
  npx prisma generate
  npx suss extract -p tsconfig.json -f hono -f prisma -o summaries/code.json
  ```

- **A cast on the receiver.** `(db as any).user.findUnique(...)` is a call on an opaque value, so the pack has nothing to match even with the client generated.

Check separately for a client generated somewhere else, because that goes wrong more quietly. The pack treats a type as Prisma's when the file declaring it is under `@prisma/client/` or `.prisma/client/`, and it only looks at files that import `@prisma/client` in the first place. A generator block with an `output` of its own, imported by relative path, satisfies neither of those. In that case there is no health line at all. The run succeeds, and the calls come back as plain calls with no table under them.

```
       -> 200 { id, email }
           + c.req.param
           + db.user.findUnique
```

When the pack does match, it adds `+ reads postgresql:User` under that call, so that is the line to look for.

The other line you will often see comes from running a recognizer pack on its own:

```
Pack health (1):
  no-units  prisma  1 gated files, and no pack in this run discovered a unit in them. prisma reads calls inside units another pack finds, so add the pack that finds this project's handlers (-f express, -f fastify, ...), or run suss init to work out which.
```

A recognizer pack labels the calls inside boundaries that some other pack discovers, so on its own it has nothing to look at. Add the framework pack for this project.

### Every health code

Six codes describe the run in front of you and always print. The other four are for whoever wrote the pack, and they print only with `--explain`.

| Code | Prints | What it means |
|---|---|---|
| `threw` | always | A pack's hook threw on a file, and suss skipped that file. Every count for the pack is a lower bound. |
| `no-output` | always | A pack got as far as one stage and produced nothing at the next. |
| `double-match` | always | Two of a pack's own patterns claimed the same unit. suss kept the first. |
| `no-files` | always | The pack's library is installed and no file in the run imports it, through the project's own modules included. |
| `no-units` | always | A recognizer pack had nothing to look inside, because no pack in the run discovers units. |
| `no-helper` | always | A registration helper the pack read matched no call in the run, so whatever it registers is missing. |
| `no-version` | `--explain` | The pack declares no version, so a cache entry cannot tell two builds of it apart. |
| `fn-link` | `--explain` | A declared pack wrote a link as a function instead of data, so only the TypeScript adapter can run it. |
| `ast-link` | `--explain` | A declared pack reaches into the syntax tree, with the same consequence. |
| `no-example` | `--explain` | A declaration ships with nothing that runs when it stops matching. |

`no-output` prints a pair of counts with an arrow, and the arrow shows where the pack stopped:

| Detail | Meaning |
|---|---|
| `N source files -> 0 units` | Its import gate selected files and it recognized nothing in them. |
| `N unit bodies -> 0 effects` | A recognizer pack looked inside bodies and matched no calls. |
| `N units -> 0 summaries` | It recognized units and bound none of them to a boundary. |
| `N summaries -> 0 transitions` | It wrote summaries and recorded nothing in any of them. |

Usually a `no-output` means your code uses the library in a way the pack does not cover, or in a version the pack predates. `threw`, `double-match` and `no-helper` point at bugs in the pack. Open an issue with the code that triggered them.

suss leaves a pack whose library is not installed out of this block. The empty run already says the dependencies are missing, and a second message would look like a second problem.

## Nothing was compared

```
Nothing was compared.

  These summaries cover 1 boundary on the provider side and none on the client side, so there was no other side to compare against.
  Extract both sides of the boundary into the same folder, then check them together:
    suss extract -p <tsconfig> -f <pack> -o summaries/<name>.json
    suss check --dir summaries/

error: nothingPaired
  Read 1 summary and paired nothing. No boundary in this run had both a provider and a consumer, so nothing was compared.
  Check that both sides of at least one boundary are in the directory. A provider extracted from code needs its consumer extracted too, or its contract read with `suss contract`. `suss inspect --dir` over the same files lists the boundaries each side claims, and two spellings of one boundary is the usual cause.
```

`check` compares two sides, so one side on its own gives it nothing to do. If you have Express routes and no `fetch` or axios call site next to them, the callers were never extracted. Either they live in another repository, or the pack that reads them was left off the command.

Extract the other side into the same folder:

```bash
npx suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json
npx suss check --dir summaries/
```

When the other side is a schema or a spec instead of code, `contract` reads it and writes the same format. A Prisma schema becomes the provider for your query call sites, and an OpenAPI document becomes the provider for your client:

```bash
npx suss contract --from prisma prisma/schema.prisma -o summaries/prisma.json
npx suss check --dir summaries/
```

When the other side is in another repository, extract it there and copy its summary file in. [Work across services](/guides/work-across-services) shows how.

## See also

- [Read Python or Ruby](/guides/python-and-ruby), where the empty-run messages point at a directory instead of a tsconfig
- [Write a pack](/packs/write-a-pack), for the declared form the last four health codes are measured against
