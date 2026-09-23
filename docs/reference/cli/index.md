---
title: suss CLI reference
description: Every suss command, the top-level flags, the environment variables it reads, and where each command writes.
---

# CLI reference

Everything ships in one package:

```bash
npm install --save-dev @suss/cli
```

```
suss init [<directory>] [--plain]
suss extract [-p <tsconfig> | --dir <directory>] [--lang typescript|python|ruby] [-f <pack>[=<config.json>] ...] [-o <output.json>] [--files <f1> <f2> ...] [--gaps strict|permissive|silent]
suss inspect [<summaries.json> | --dir <directory>]
suss inspect --diff <before.json> <after.json>
suss inspect --flow "<METHOD> <url>" [<summaries.json> | --dir <directory>] [--entry <name>] [--scope <document>] [--json]
suss check [--dir <directory>] [--intent <intent-dir>] [--all] [--json] [-o <output>]
suss check <provider.json> <consumer.json> [--all] [--json] [-o <output>]
suss check [--dir <directory>] --at <file[:line] | boundary | summary-id> [--json]
suss ask "<question>" [--dir <directory> | <summaries.json>] [--all] [--json]
suss contract --from <source> <spec> [-o <output.json>]
suss corroborate --experimental [-p <tsconfig> | --dir <directory>] [-f <pack> ...] [-o <output.json>]
suss infer stub <package> [-p <tsconfig> | --dir <directory>] [-o <file | ->]
suss infer intent --from <summaries.json | directory> [-o <directory> | --into <directory>]
suss infer prd --from <intent-directory> [-o <directory> | --into <directory>]
suss --version
```

In a synopsis, `<...>` marks a required value and `[...]` an optional one.

## Commands

| Command | Reads | Writes |
|---|---|---|
| [`init`](/reference/cli/init) | `package.json`, schemas and deploy templates on disk | The commands to run, and `suss.json` if you accept it |
| [`extract`](/reference/cli/extract) | TypeScript, Python or Ruby source, through the packs you name | Summary JSON |
| [`contract`](/reference/cli/contract) | One of ten declared sources: an OpenAPI document, a deploy template, a database schema, and so on | Summary JSON, the same structure `extract` writes |
| [`check`](/reference/cli/check) | Summary files, and optionally a folder of intent docs | Findings, as text or JSON |
| [`inspect`](/reference/cli/inspect) | A summary file, a folder of them, or two of them | Text for a person, or JSON under `--diff` and `--flow` |
| [`ask`](/reference/cli/ask) | Summary files, and the source for a why question | One answer, as text or JSON |
| [`corroborate`](/reference/cli/corroborate) | Source, through the express or fastify packs | Summaries annotated with what running the code showed |
| [`infer`](/reference/cli/infer) | Observed calls, summaries, or curated intent docs | A YAML draft for you to finish |

`extract`, `inspect` and `check` run with no arguments at all. Each one reads `suss.json`, or picks the packs `init` would pick when there is no file, and prints the commands it ran to stderr.

The summary JSON is the artifact every other command works from. `inspect` renders it and `check` compares two of them, so anything either one reports is also there in the JSON for you to read yourself. Two commands compute an answer that isn't in any file. [`inspect --flow`](/reference/cli/inspect#suss-inspect-flow) walks the routing a set of summaries declares, and [`ask`](/reference/cli/ask) takes a question about one boundary and works out the answer from the summaries.

## Top-level flags

| Flag | What it does |
|---|---|
| `-h`, `--help` | Print the usage above and exit `0`. Running `suss` with no command, or any command with `--help`, prints the same thing. |
| `-v`, `--version` | Print the installed version and exit `0`. |

## Environment variables

An interactive run ends with one line on stderr when a newer suss is on the registry. You never get that line when the output is piped, and two variables turn it off everywhere.

| Variable | Effect |
|---|---|
| `NO_COLOR` | Set it to anything and output is plain text with no ANSI colour. |
| `TERM=dumb` | The same. Colour is also off whenever stdout is not a TTY, so a piped or redirected run is plain without you asking. |
| `CI` | Set it to anything and the update notice is off. `suss init` detects CI separately and prints its commands rather than prompting, the same as `--plain`. |
| `SUSS_NO_UPDATE_NOTICE` | Set it to anything and the update notice is off. |

## Where output goes

| Stream | What arrives there |
|---|---|
| stdout | Summary JSON from `extract` and `contract`, the report from `inspect`, `check` and `ask`, and the JSON those write under `--json` |
| stderr | "Wrote N summaries to PATH", extraction warnings, the commands a no-argument run chose, error messages |

A run without `-o` puts nothing but JSON on stdout, so `suss extract ... | jq` works. `-o PATH` moves that JSON into the file; `extract` and `contract` then write one acknowledgement line to stderr.

[Exit codes](/reference/cli/exit-codes) lists what every command returns to the shell.
