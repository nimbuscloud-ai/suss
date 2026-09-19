---
title: Fix a run that found nothing
description: What each empty-run message means when extract wrote no summaries, when check compared nothing, and when a pack read your code and recognized none of it.
---

# Fix a run that found nothing

Read the message. Every command that comes up empty says which stage it stopped at, and the stage is the fix.

Run the command again with `--explain` for the full funnel, pack by pack:

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

suss took the nearest `tsconfig.json` and that one covers no source. In an Nx or Angular layout the root config is often `"files": []` with the app's own config beside it. Pass the one that covers your source:

```bash
npx suss extract -p tsconfig.app.json -f express -o summaries/code.json
```

A solution-style root, `"files": []` with a `references` array, is followed on its own: suss reads the union of what the referenced configs list. It is the root with neither files nor references that produces this.

## A package the pack needs is not installed

```
No summaries to write in 0.43s.
  1 file imports @hono/zod-openapi, but that package is not installed here.
  suss cannot see what a call does without the package behind it.
  Install this project's dependencies, then run the command again.
```

Several packs resolve symbols through the library's own types, so they need the package on disk. Install the project's dependencies and run it again. Packs that read a file rather than a symbol, the AWS pack reading your SAM template among them, work without an install.

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

suss reads a module of your own in front of the framework. The module imports the framework itself, so it is counted in the line above, and suss follows the app through it: a route written inside `registerHealth(app)` comes out as a route. Where the framework import lives in a package suss cannot read at all, a [dependency stub](/guides/teach-a-dependency) bridges it.

## A pack read your code and recognized none of it

A run can write summaries, exit 0, and still have a pack in it that read your code and matched nothing. The pack health block says so:

```
Wrote 1 summary to summaries/code.json in 0.57s

Pack health (1):
  no-output  prisma  1 unit bodies -> 0 effects
```

Every line is three columns: what happened, the pack it happened to, and the numbers behind it. The codes are a fixed list, so `grep no-output` over a CI log finds every one with its counts on the same line.

The `prisma` pack matches a call by the type of the thing it is called on, so it classifies `db.user.findUnique(...)` only when `db` resolves to the generated `PrismaClient` with a `user` model on it. Two things break that resolution and give you this line:

- **The `@prisma/client` your code imports has no model types in it.** `npx prisma generate` has not run, so the package is still the stub a fresh install ships, where `PrismaClient` is `any`. Generate, then extract again:

  ```bash
  npx prisma generate
  npx suss extract -p tsconfig.json -f hono -f prisma -o summaries/code.json
  ```

- **A cast on the receiver.** `(db as any).user.findUnique(...)` is a call on an opaque value, so the pack has nothing to match even with the client generated.

Check separately for a client generated somewhere else, which goes wrong more quietly. The pack takes a type as Prisma's when the file declaring it is under `@prisma/client/` or `.prisma/client/`, and it only looks at files that import `@prisma/client` in the first place. A generator block with an `output` of its own, imported by relative path, satisfies neither. There is no health line at all in that case: the run succeeds and the calls come back as plain calls with no table under them.

```
       -> 200 { id, email }
           + c.req.param
           + db.user.findUnique
```

`+ reads postgresql:User` under that call is what the pack adds when it does match, so its absence is the thing to look for.

The other frequent line is a recognizer pack asked for on its own:

```
Pack health (1):
  no-units  prisma  1 gated files, and no pack in this run discovered a unit in them. prisma reads calls inside units another pack finds, so add the pack that finds this project's handlers (-f express, -f fastify, ...), or run suss init to work out which.
```

A recognizer pack labels the calls inside boundaries some other pack discovers, so running it alone walks nothing. Add the framework pack for this project.

### Every health code

Five codes are about the run in front of you and always print. Four more are addressed to whoever wrote the pack and wait for `--explain`.

| Code | Prints | What it says |
|---|---|---|
| `threw` | always | A pack's hook threw on a file, and that file was skipped. Every count for the pack is a floor. |
| `no-output` | always | A pack got as far as one stage and produced nothing at the next. |
| `double-match` | always | Two of a pack's own patterns claimed the same unit. suss kept the first. |
| `no-units` | always | A recognizer pack had nothing to look inside, because no pack in the run discovers units. |
| `no-helper` | always | A registration helper the pack read matched no call in the run, so whatever it registers is missing. |
| `no-version` | `--explain` | The pack declares no version, so a cache entry cannot tell two builds of it apart. |
| `fn-link` | `--explain` | A declared pack wrote a link as a function instead of data, so only the TypeScript adapter can run it. |
| `ast-link` | `--explain` | A declared pack reaches into the syntax tree, with the same consequence. |
| `no-example` | `--explain` | A declaration ships with nothing that runs when it stops matching. |

`no-output` prints a pair of counts with an arrow, and the arrow says where the pack stopped:

| Detail | Meaning |
|---|---|
| `N source files -> 0 units` | Its import gate selected files and it recognized nothing in them. |
| `N unit bodies -> 0 effects` | A recognizer pack looked inside bodies and matched no calls. |
| `N units -> 0 summaries` | It recognized units and bound none of them to a boundary. |
| `N summaries -> 0 transitions` | It wrote summaries and recorded nothing in any of them. |

The usual cause of a `no-output` is that your code uses the library in a shape the pack does not cover, or a version it predates. `threw`, `double-match` and `no-helper` are bugs in the pack rather than in your project, and are worth an issue with the code that triggered them.

A pack whose library is not installed is left out of this block, because the empty run already says the dependencies are missing and saying it twice reads as two problems.

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

`check` compares two sides, so one side on its own gives it nothing to do. Twenty Express routes with no `fetch` or axios call site beside them means the callers were never extracted, either because they live in another repository or because the pack that reads them was left off the command.

Extract the other side into the same folder:

```bash
npx suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json
npx suss check --dir summaries/
```

Where the other side is a schema or a spec rather than code, `contract` reads it into the same format. A Prisma schema becomes the provider for your query call sites; an OpenAPI document becomes the provider for your client:

```bash
npx suss contract --from prisma prisma/schema.prisma -o summaries/prisma.json
npx suss check --dir summaries/
```

Where the other side is in another repository, extract it there and copy its summary file in. [Work across services](/guides/work-across-services) covers that.

## See also

- [Read Python or Ruby](/guides/python-and-ruby), where the empty-run messages name a directory rather than a tsconfig
- [Write a pack](/packs/write-a-pack), for the declared form the last four health codes are measured against
