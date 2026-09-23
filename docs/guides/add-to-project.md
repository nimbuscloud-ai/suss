---
title: Add suss to a project
description: Install suss in a repository you already have, run it once, and read what came back.
---

# Add suss to a project

Install suss in a repository you already have and get a first answer out of it. You do not annotate anything or start any servers. suss writes a folder of summary files and a small `suss.json` to disk, and nothing else.

```bash
npm install --save-dev @suss/cli
npx suss init
```

Everything ships inside `@suss/cli`, so there is one install, and you refer to each pack by name after that.

## What `init` finds

<!-- suss:unchecked it runs in a repository of your own, and this one checks none in -->

`init` reads your dependency list, looks for schemas and deploy templates on disk, and prints what it can read. On a small Express service with a web client in the same repository:

```
✓ Found 3 things to read in articles

  Your code
    express          express in dependencies
    fetch            TypeScript sources, and fetch reads what the language itself ships

  What your code reaches
    node             TypeScript sources, and node reads what the language itself ships
```

Then it asks five questions, one at a time:

- **Install N packages as devDependencies?** Yes by default. If npm fails it stops there, prints what npm said, and leaves you the command.
- **Read the code now and compare what it finds?** Yes by default. It runs `extract`, `contract` and `check` for you.
- **Add a `.sussignore` for findings you decide to accept?** No by default.
- **Add a GitHub Actions workflow that runs this on every pull request?** No by default.
- **Write `suss.json`, so later runs know what this project declares?** Yes by default.

`init` writes nothing to disk unless you say yes.

If the output is piped, if the run is in CI, or if you pass `--plain`, `init` prints the commands instead of asking:

```bash
npx suss init --plain
```

```
1. Install suss

   npm install --save-dev @suss/cli

2. Read each side into one folder

   suss extract -f express -f fetch -f node -o summaries/code.json

3. Compare them

   suss check --dir summaries/
```

Two more steps follow: accepting a finding, and running the same two commands in CI.

## What `init` writes

`init` writes `suss.json` at the repository root. It lists which packs this project needs and which documents it declares:

```json
{
  "version": 1,
  "read": [
    {
      "kind": "extract",
      "language": "typescript",
      "project": "tsconfig.json",
      "packs": ["express", "fetch", "node"]
    },
    {
      "kind": "contract",
      "from": "openapi",
      "file": "openapi.yaml"
    }
  ]
}
```

Commit it. It records what the project contains, which is the same for everybody working on it. With the file committed, a later run tells you when a document stops being compared, so the document does not go unpaired without anyone noticing.

`init` can also write a `.sussignore` with one example rule, as `.sussignore.json` ([Accept a finding](/guides/accept-a-finding) has the syntax) and `.github/workflows/suss.yml` ([Run suss in CI](/guides/ci-integration) has the whole thing). Both are off by default.

## Run it

With `suss.json` in place, `extract`, `inspect` and `check` need no flags. Each one prints the command it worked out before it runs it:

```bash
npx suss check
```

```
Reading what suss.json says.
  suss extract --lang typescript -p tsconfig.json -f express -f fetch -f node
  suss contract --from openapi openapi.yaml
```

If there is no `suss.json`, they pick what `init` would have picked and print that, so your first run works before you have written anything down:

```
No suss.json in articles, so this reads what `suss init` would pick. Run `suss init` to write that down.
  suss extract --lang typescript -p tsconfig.json -f express -f fetch -f node
```

## Read the first run

`inspect` describes what each unit does, with no findings to triage:

```
src/articles.ts
└─ GET /articles/{slug}  (express handler | line 14)
       if  !db.bySlug()
         -> 404 { error }
           + db.bySlug
       elif  db.bySlug().archivedAt
         -> 410 { error }
           + db.bySlug
       else
         -> 200 { id, slug, title }
           + db.bySlug

     Could not follow:
       The call to db.bySlug lands on a declaration with no body, so whatever runs there is missing from this summary
```

`check` compares the two sides of each boundary and prints what disagrees:

```
Compared 1 boundary.

────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/articles.ts::get (src/articles.ts:14)
  consumer: web/articleView.ts::loadArticle (web/articleView.ts:1)
  boundary: express (http) GET /articles/:slug
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /articles/{slug}"
      provider: { transitionId: "get:response:404:6405be7" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
2 findings: 0 error, 2 warning, 0 info
```

Errors fail the run and warnings do not, so a first pass over an old codebase does not have to be all or nothing. `--all` lists every pair suss made and every boundary it skipped, so you can tell "no findings" apart from "nothing got compared". `--at src/articles.ts:14` narrows a run to one file, line, boundary or summary.

When a run turns up nothing, every command prints where it stopped. [Fix a run that found nothing](/guides/fix-an-empty-run) goes through each case.

## Choose the packs yourself

`-f` picks a pack to read with, and you can repeat it. `-p` points at the tsconfig that covers the code you want read, which gives suss the same type resolution your compiler has, including your `paths` aliases and your `lib` set. Without it, an import that crosses a package boundary does not resolve, and most of the type information is lost.

```bash
# The service
npx suss extract -p tsconfig.json -f express -o summaries/api.json

# The web client that calls it, from its own tsconfig
npx suss extract -p apps/web/tsconfig.json -f fetch -o summaries/web.json
```

`suss contract --from` reads a document you already keep and produces summaries in the same format:

```bash
npx suss contract --from openapi openapi.yaml -o summaries/contract.json
npx suss contract --from cloudformation template.yaml -o summaries/infra.json
```

The [pack catalog](/packs/catalog) lists every `-f` name and every `--from` source with what each one reads.

A Python or Ruby project has no tsconfig, so point suss at the directory with `--dir` instead. [Read Python or Ruby](/guides/python-and-ruby) covers both.

## Where the files go

`summaries/` is derived, so leave it out of the repository and let CI regenerate it. The exception is a library that publishes its summaries for whoever consumes it, and [Publish summaries](/guides/publish-summaries) covers that.

Commit both `suss.json` and `.sussignore`. `suss.json` records what the project contains. `.sussignore` lists the findings your team decided to accept.

## Next

At a repository root with a workspace declaration, `init` asks which packages to set up. [Work across services](/guides/work-across-services) covers that, and what happens when two services serve the same path.

After the first run, [Adopt it step by step](/guides/adopting-suss) goes from reading one service to gating pull requests.
