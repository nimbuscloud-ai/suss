---
title: suss extract
description: Read TypeScript, Python or Ruby source into behavioral summaries, with every flag and every built-in pack name.
---

# `suss extract`

`suss extract` reads your TypeScript, Python or Ruby source and writes a behavioral summary for every code unit it finds. It is the first command you run on a project, and every other command works from the JSON it produces.

```
suss extract [-p <tsconfig> | --dir <directory>] [--lang typescript|python|ruby]
             [-f <pack>[=<config.json>] ...] [-o <output.json>]
             [--files <f1> <f2> ...] [--gaps strict|permissive|silent]
             [--explain] [--timing] [--datalog-profile] [--no-cache]
             [--allow-empty] [--fail-on-pack-error]
```

| Flag | Default | What it does |
|---|---|---|
| `-f`, `--framework <name>` | the packs in `suss.json`, or what `init` would pick | Which pack to read with. Repeatable. See [Pack names](#pack-names) and [Configuring a pack](#configuring-a-pack). |
| `-p`, `--project <path>` | the nearest `tsconfig.json` or `jsconfig.json` above the working directory | The tsconfig covering the code to read, so suss resolves types the way your compiler does. |
| `--dir <path>` | the working directory | Read this directory, for a project with no tsconfig. |
| `--lang <name>` | worked out from what the directory contains, the packs you asked for, and the nearest tsconfig | `typescript`, `python` or `ruby`. When suss cannot work the language out for itself, it stops and asks you to pass this flag. |
| `-o`, `--output <path>` | stdout | Write the summary JSON to a file. Parent directories are created. |
| `--files <f1> <f2> ...` | every file the tsconfig or directory covers | Read only these files, resolved against the working directory. Bare arguments with no flag in front of them mean the same thing when `--files` is absent. |
| `--gaps <mode>` | `permissive` | `permissive` records in the summary the returns and declared statuses a pack could not account for. `strict` records the same and then exits non-zero. `silent` skips gap detection. |
| `--explain` | off | Print where the summaries came from, file by file and pack by pack. A run that found nothing prints it either way. |
| `--timing` | off | Print how long each phase took, to stderr. |
| `--datalog-profile` | off | Print what the Datalog evaluator spent its time on, rule by rule, with how many rows its joins read. Use it when `--timing` shows the rules phase is the slow one. |
| `--no-cache` | off | Skip the on-disk cache for this run. |
| `--allow-empty` | off | Exit `0` even when the run produced nothing. Without it that run fails, because a silent zero looks the same in CI as a passing check. |
| `--fail-on-pack-error` | off | Exit non-zero when a pack throws while it reads. By default the run reports the throw and keeps going with the other packs. |

`--fail-on-empty` is gone. A run that finds nothing now fails by default, and passing the old flag stops the run and points you at `--allow-empty`.

## What it writes

Without `-o`, the summary JSON goes to stdout and nothing else does, so `suss extract ... | jq` works. With `-o`, the JSON goes to the file and one acknowledgement line goes to stderr.

With `-o`, a run that could not read part of the project also writes a note beside the summaries, at `summaries.incomplete.json` next to `summaries.json`. It has one key per reason: `filesWithUnreadableExports` for re-export chains suss could not follow in a TypeScript run, and `submodulesNotCheckedOut` for a submodule with nothing in it, which any language can hit. A run with nothing to report deletes a note an earlier run left, so a stale file never fails a job that has since been fixed.

## Example

```bash
$ suss extract --dir fixtures/express -f express -o summaries/api.json
Wrote 4 summaries to /home/dana/shop/summaries/api.json in 0.61s
```

## Pack names

`-f` takes these 44 names out of the box. Every one of them ships inside the CLI, so there is nothing else to install. The [pack catalog](/packs/catalog) describes what each one reads.

**Frameworks.** These discover the units a run is about: a route, a resolver, a component, a deployed function.

`apollo`, `aws-lambda`, `cloudflare-workers`, `express`, `fastapi`, `fastify`, `flask-restx`, `graphql-ruby`, `hono`, `nestjs-graphql`, `nestjs-microservices`, `nestjs-rest`, `nextjs`, `package-exports`, `rails`, `react`, `react-query`, `react-router`, `ts-rest`

**Clients.** These discover the calls your code makes out.

`aiohttp`, `apollo-client`, `axios`, `faraday`, `fetch`, `httpx`, `net-http`, `requests`

**What your code reaches.** These do not discover units. They read the calls inside a unit another pack found, so run one alongside a framework or client pack or it comes back empty.

`activerecord`, `aws-dynamodb`, `aws-eventbridge`, `aws-s3`, `aws-secrets-manager`, `aws-sns`, `aws-sqs`, `aws-ssm`, `drizzle`, `gcs`, `mongoose`, `node`, `prisma`, `redis`, `sqlalchemy`, `sqlmodel`, `zustand`

Twelve of them read something other than TypeScript, and a run reads one language at a time. `fastapi`, `flask-restx`, `sqlalchemy`, `sqlmodel`, `requests`, `httpx` and `aiohttp` read Python; `rails`, `graphql-ruby`, `activerecord`, `faraday` and `net-http` read Ruby. Naming one in a TypeScript run stops the run and prints the command to run it separately. See [Read Python or Ruby](/guides/python-and-ruby).

A name that is not on the list gets treated as a module to import, and that is how you run a pack of your own. A name starting with `@` or containing a `/` is imported exactly as written, so `-f @acme/suss-pack` works. Any other name is tried as `@suss/packs/<name>`, then `@suss/framework-<name>`, then `@suss/<name>`. If none of the three import, the run stops and prints the built-in list.

## Configuring a pack

Write `-f <pack>=<config.json>` and the file's contents go to the pack as its options. The CLI parses the file against the pack's own schema before the pack runs, so a key the pack never declared stops the run instead of being quietly ignored. The error gives the key you wrote and the keys that pack does take.

A pack config describes your own project: which database is behind a connection, or which directory your schema lives in. A fact about a package you depend on goes in a [dependency stub](/guides/teach-a-dependency) instead, and every pack in the run reads it from there.

Most packs have nothing to configure. `aws-dynamodb` takes `requiresImport`, the modules whose presence, directly or through a file the project imports, makes a file one the pack should read. `react-router` takes `errorHelpers`, the project's own helpers that turn an error into a response.

Five option names describe a dependency rather than your own project, so they belong in a stub and a config file may not set them. Setting one stops the run and tells you which stub kind takes it over:

| Pack | Option | Stub kind |
|---|---|---|
| `nestjs-rest`, `nestjs-graphql`, `nestjs-microservices` | `classDecorators` | `composes-decorator` |
| `aws-sqs`, `aws-eventbridge` | `producers` | `performs-call` |
| `axios` | `factories` | `performs-call` |
| `fastapi`, `flask-restx` | `wrapperModules` | `re-exports` |
| `graphql-ruby`, `rails` | `baseClassNames` | `extends-base` |

Three more described the project's own code, and suss reads those off the code itself now: `registrationHelpers` on `express`, `fastify` and `hono`, `requestFunctions` on `aws-dynamodb`, and `subjectFactories` on `aws-lambda`. A config that still sets one keeps running. suss drops the key and warns you what replaced it.

[Exit codes](/reference/cli/exit-codes) lists what `extract` returns to the shell.
