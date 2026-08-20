# @suss/cli

Command-line interface for suss. It wraps the extraction pipeline, the human-readable inspector, and the cross-boundary checker.

## What this package is

`@suss/cli` is the user-facing entry point. It imports the language adapter and the pattern packs dynamically, so that starting the CLI doesn't pay the ts-morph cost unless extraction actually runs.

### Commands

```sh
# Extract behavioral summaries from a TypeScript project
suss extract -p tsconfig.json -f ts-rest [-f express] [-o summaries.json]

# Render a single summaries file as human-readable text
suss inspect summaries.json

# Show what changed between two summary files
suss inspect --diff before.json after.json

# Overview of every provider/consumer pair in a directory of summaries
suss inspect --dir summaries/

# Who serves this request, hop by hop, from the balancer to the handler
suss inspect --flow "GET https://shop.example.com/api/orders/123" --dir summaries/

# Pairwise check: compare one provider against one consumer
suss check provider.json consumer.json [--json] [-o findings.json]

# Directory check: auto-pair providers with consumers by (method, path)
suss check --dir summaries/ [--json] [-o findings.json] [--fail-on warning]

# The part of that report about one file, line, boundary, or summary
suss check --dir summaries/ --at src/editions/dao.ts:43
suss check --dir summaries/ --at 'dynamodb:editions#by-publication'

# One question about one boundary, from summaries already on disk
suss ask 'what can I project from dynamodb:editions#by-publication' --dir summaries/
suss ask 'what reads dynamodb:editions' --dir summaries/
suss ask 'why does getOrder reach dynamodb:orders' --dir summaries/

# Generate summaries from a declared contract (no source extraction)
suss contract --from openapi spec.yaml [-o provider.json]
suss contract --from openapi https://example.com/openapi.yaml [-o provider.json]
suss contract --from cloudformation template.yaml [-o provider.json]
suss contract --from intent intents/ [-o intent.json]
```

### Options

**`extract`**
- `-p, --project`: path to `tsconfig.json` (required)
- `-f, --framework`: pattern pack name (repeatable)
- `-o, --output`: write JSON to file instead of stdout
- `--files`: limit extraction to specific source files
- `--gaps`: gap handling: `strict` (default), `permissive`, or `silent`

**`check`**
- `--dir`: directory of summary JSON files; auto-pairs by `(method, normalizedPath)`
- `--at`: report on one file, `file:line`, boundary, or summary id instead of the whole folder. Needs `--dir`, and exits non-zero when it matches nothing
- `--all`: write out every finding and every list, instead of the collapsed report
- `--json`: emit findings as JSON
- `-o, --output`: write findings to file instead of stdout
- `--fail-on`: exit-code threshold: `error` (default), `warning`, `info`, or `none`

### What `check` prints by default

A run prints the errors in full and counts everything else: the findings below error severity, grouped by kind, and the boundaries that went unpaired. `--all` writes all of it out.

Two measurements decided this. The unpaired lists are the bulk of a report on any repository of a realistic size. Over five public repositories and suss's own packages they ran between 66% and 99% of the lines, and not one of those lines is a finding. Warnings and infos also outnumber errors by a wide margin on a first run, so printing them in full puts the thing that fails the build off the top of the screen.

The flag changes what is printed and nothing else. `--json` always includes every finding and every list, so a CI job that parses the JSON sees no difference. The exit code still comes from `--fail-on`, which defaults to `error`. `--at` prints in full whether or not `--all` is passed, because a reader who has narrowed the run to one file or one boundary has already said what they want to see.

**`ask`**
- Positional argument: the question, one of `what can I project from <boundary>`, `what reads <boundary>`, `what writes <boundary>`, `what does <unit> reach`, `why does <unit> reach <boundary>`, `why does <name> at <file>:<line> resolve to <target>`
- `--dir`: directory of summary JSON files, or pass one summaries file instead
- `--project`: where the source is, for a why question (default: the working directory)
- `--json`: emit the answer as JSON
- `-o, --output`: write the answer to file instead of stdout

**`stub`**
- `--from`: stub source kind: `openapi` or `cloudformation`
- `-o, --output`: write JSON to file instead of stdout
- Positional argument: path to the spec file

### Built-in framework resolution

Pass `-f <name>` to select a pattern pack. Built-in names: `ts-rest`, `react-router`, `express`, `fastify`, `fetch`, `axios`. A custom pack is resolved by dynamically importing `@suss/framework-<name>`.

### Exit codes

`suss check` exits non-zero when the findings meet the `--fail-on` threshold (by default, any finding of error severity). That is what you use to gate CI.

### Reading a project's declared dependencies

`suss init` suggests packs based on the libraries a project declares. For `package.json` that is a single `JSON.parse`. Python and Ruby are harder, so each reader returns two things: the library names it managed to read, and the files or lines it could not read, along with why. If suss cannot read a manifest it cannot suggest packs for that project, and it needs to say so, because coming back with no suggestions looks exactly the same as finding nothing to suggest.

| Manifest | What it takes to read |
| --- | --- |
| `requirements.txt` / `.in` / `-dev` / `-test` | There is a whole grammar here: extras, version specifiers, environment markers, URL installs, `\` line continuations, and `-r` / `-c` includes that point at more files. The parser rejects the entire file if one line falls outside that grammar, so when a file will not parse as a whole we fall back to reading it line by line. A pip setting like `--index-url` does not declare a library and is not hiding one, so we skip it without comment; anything else we cannot parse gets reported. An editable install points at a directory, and that directory's own manifest is what declares the libraries, so there is no name to read off the line itself. |
| `pyproject.toml` | Three different spellings of the same list, depending on which tool wrote the file: the standard `project.dependencies`, plus Poetry's two tables. Dependencies marked dynamic get computed at build time, so we report them as unread. Poetry puts the Python interpreter itself in the same table as the libraries. |
| `setup.cfg` | Usually `install_requires` written out as requirement lines. setuptools also lets it point somewhere else, either at a file (`file: requirements.txt`) or at an attribute on the package (`attr: mypkg.__requires__`), and in that case the list is no more available to us than a computed one would be. |
| `setup.py` | This is a program, not data. If the file spells out a list literally, that is as good as a manifest; anything else only exists once Python has run. A single non-string element in the list means what we can see is not the whole list. |
| `Pipfile` | TOML. We read both the `packages` and `dev-packages` tables, each keyed by library name. |
| `Gemfile.lock` | A Gemfile is Ruby, and its gem list can come out of a loop or a call into another file, so we read the lock file that bundler writes instead. Only the `DEPENDENCIES` section counts. The `GEM` section below it lists everything those gems pulled in transitively, and suggesting a pack for a library the project never asked for would be a worse answer than suggesting none. If there is no lock file, we say so. |

We normalize Python names per PEP 503, which is what makes `Flask-RESTX`, `flask_restx`, and `flask.restx` one library instead of three.

### Nested repositories and submodules

When a service keeps its shared framework in a git submodule, it imports code that is on disk but belongs to a different repository. Both halves of a run have to deal with that. Extraction cares because the decorator a pack matches on is usually defined inside the submodule, so if an import into it does not resolve, every route in the service goes unrecognized. Discovery cares because a nested repository otherwise looks like somebody else's project, and walking into it looks like a mistake.

`.gitmodules` is what tells the two apart. The enclosing repository lists each submodule by path, so if a nested `.git` appears in that list it is part of this project and we add it as an extraction root. If it does not appear, it is a separate project that happens to sit inside the tree, and we drop its files from the walk. Extracting them would report another project's boundaries as though they were this one's.

A submodule nobody checked out is an empty directory. Imports into it resolve to nothing, and the summaries that depended on them quietly never get produced, so a run prints a warning on stderr, continues anyway, and records the problem in the incompleteness note it writes next to the summaries.

## Where it fits in suss

This package depends on everything: `@suss/behavioral-ir`, `@suss/extractor`, `@suss/adapter-typescript`, `@suss/checker`, and all the framework and runtime packs. It is the only package that ties the full stack together.

## Coverage

![coverage](../../.github/badges/coverage-cli.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../LICENSE).

---

For the summary format the CLI reads and writes, see [`docs/behavioral-summary-format.md`](../../docs/behavioral-summary-format.md).
