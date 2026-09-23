# Contributing to suss

For design conventions, see [`design/docs-internal/style.md`](./design/docs-internal/style.md).

## Getting set up

You need Node.js 22 or newer.

```sh
git clone https://github.com/nimbuscloud-ai/suss.git
cd suss
npm install
npm run build
npm test
```

## Before you open a PR

```sh
npm run lint
npm run typecheck
npm test
npm run dogfood    # run suss over every package in this repo
```

`npm run dogfood` is the widest check here. It runs discovery, extraction, resolution and the checker over every package in this repo, and it fails when a package declares an export that doesn't produce a summary. It writes the per-package counts to `scripts/dogfood-baseline.json`, which is committed. CI runs `npm run check:dogfood`, which fails when a count comes out below the committed one. Each package gets three counts: `exports` for the summaries that describe its declared public surface, `internal` for the ones behind that surface, and `consumers` for its calls into other packages.

So if your change deletes exports, moves them between packages, inlines a private helper, or narrows a recognizer that was firing too often, run `npm run dogfood` and commit the refreshed baseline. The drop then appears in your pull request diff, where a reviewer can see it and agree you meant it. When a count goes up, you do not need to refresh anything. `design/docs-internal/dogfooding.md` has the full table of what fails and what to do about it.

Line coverage works the same way. Each package under the coverage gate commits a `coverage/coverage-summary.json`, and `npm run check:coverage` fails when a package comes out below the committed number. Lowering coverage on purpose means running `npm run test:badges` and committing the refreshed summaries and badges, so the drop appears in your diff.

Neither check reads `main`. Both compare a fresh run against the tree they ran on, so a merge landing on `main` while your branch is open cannot fail your build on a package you never opened. Your branch also never needs to touch `scripts/dogfood-baseline.json`, a `coverage-summary.json`, or a badge unless it is lowering a number. Once a night, `.github/workflows/regenerate.yml` reruns the dogfood pass and the test suite on `main` and commits whatever moved, so those three files catch up with the source on their own. Start it from the Actions tab when a branch needs the fresh numbers sooner.

Open a pull request as a draft while it is still being reviewed or rebased. CI and the behavior diff do not run on a draft; marking it ready starts the first run. A push whose tree already passed, such as a reword or a squash of the same commits, does not run the jobs again.

The pre-push hook typechecks, runs the full test suite with coverage, rebuilds the badges, and runs the same `check:coverage` gate CI does. Don't bypass it unless you've coordinated with a maintainer.

Keep a pull request to a single intent. If you find yourself writing "and also" in the description, split it in two.

## Timing a change

`npm run bench` runs `suss extract` over the five public corpora under `dogfood-targets/` and reports wall clock, how much of that time was datalog, and the spread across repeats. `npm run bench -- --against <commit>` compares two builds, alternating between them so a busy stretch cannot fall entirely on one side. When the machine is busy it reports nothing at all, because load moves these numbers by more than most changes do. Five targets at three repeats takes about five minutes; `--subset` takes about a minute and a half over saleor-dashboard, saleor-storefront and directus/api. Nothing in CI enforces a time budget yet.

## Landing a branch that has gone stale

The nightly regenerate workflow refreshes the dogfood baseline, the coverage summaries and the badges on `main`. So a branch that passed its checks yesterday can conflict on those files today, even though nothing is wrong with it. `npm run land` rebases the branch and regenerates those files for you:

```bash
node scripts/land.mjs 123           # the pull request number
node scripts/land.mjs 123 --dry-run
```

It rebases the branch onto `origin/main` in a temporary worktree, never in the checkout you ran it from. When a conflict lands inside the generated files, it takes main's side, then reruns the generators so the branch's own numbers go back in. It only finishes if `typecheck`, `check:dogfood` and `check:coverage` all pass. A conflict anywhere else aborts the rebase and exits non-zero, because a person has to read that change. It pushes with `--force-with-lease` against the head the run started from, and nothing here merges the pull request.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), with a scope for the affected package: `ir`, `extractor`, `adapter`, `cli`, `checker`, `express`, `react-router`, `ts-rest`, and so on. Omit the scope for changes that cut across the repo. [`design/docs-internal/style.md#commits`](./design/docs-internal/style.md#commits) has the rest.

## Naming

Name a thing for the job it does, and put a package in a directory that matches the name it publishes under: `@suss/framework-hono` lives in `packages/framework/hono`. [`design/docs-internal/style.md#naming`](./design/docs-internal/style.md#naming) covers package, directory, function, Datalog-relation, and concept names.

## Tests

Tests use Vitest, with each test file next to its source (`foo.ts` and `foo.test.ts`). A test that parses fixture source gets its ts-morph project from `@suss/test-project`, so every test parses the same language the adapter parses. See [`design/docs-internal/style.md#tests`](./design/docs-internal/style.md#tests).

## Reading a value

To find out what a value is, ask the evaluator or the resolution store. Do not read the syntax at that position yourself. In the TypeScript adapter that means `discovery/resolveValue.ts`, the `ResolutionStore` in `facts/store.ts`, `resolve/functionBehind.ts`, `walk/unwrap.ts` and `discovery/importScan.ts`. In the Python and Ruby adapters it means `values/evaluator.ts`, `facts/resolve.ts` and the literal readers in `ast.ts`. A pack calls what its adapter exports.

A reader you write next to the call site handles only the spellings you had in front of you. It gives up on a template, or on a constant from another file. So when the evaluator or the store cannot read a spelling, add the case to them and do not read the syntax yourself. `npm run check:readers` fails when it finds code that looks like a second reader, and the files that already fail are listed in `EXEMPT` in [`scripts/checkReaders.mjs`](scripts/checkReaders.mjs). [`design/docs-internal/style.md#reading-a-value`](./design/docs-internal/style.md#reading-a-value) has the entry points and two before-and-after examples.

## Adding a new framework pack

You write a framework pack as configuration: a set of patterns you declare. See [`docs/packs/what-a-pack-is.md`](./docs/packs/what-a-pack-is.md) for the full guide, and copy from the packs that already exist under `packages/framework/` and `packages/client/`.

A pack may hardcode an identifier only when the library that pack is about defines it. An identifier that comes from one particular codebase belongs in per-project configuration instead. Ship it as a default and two things go wrong: everyone else gets false matches on that name, and your coverage against the codebase that name came from is overstated, because discovery matched those units on the hardcoded name instead of on the pattern you wrote. List every identifier your pack hardcodes in its `vocabulary.json`, or `npm run check:vocabulary` will fail. [`design/docs-internal/style.md#identifiers-a-pack-names`](./design/docs-internal/style.md#identifiers-a-pack-names) has the detail.

## Adding a metadata field

A field on a metadata namespace needs a writer and a reader before it does anything. Both halves are usually written weeks apart, and the test on each side passes whether or not the other side exists, so `npm run check:metadata-wiring` compares the two lists instead. A field with a writer and no reader, or a reader and no writer, fails the build. If the consumer has not been written yet, add the field to `EXEMPT` in [`scripts/checkMetadataWiring.mjs`](scripts/checkMetadataWiring.mjs) with the reason and the issue that tracks it. [`design/docs-internal/style.md#both-sides-of-a-metadata-field`](./design/docs-internal/style.md#both-sides-of-a-metadata-field) has the detail.

## Documentation that shows a command and its output

`npm run check:examples` runs the commands the pages show and compares what comes back to what the page shows. It exists because a page can promise a finding count the tool has since stopped producing, and nobody notices until a reader follows the tutorial and gets a different answer.

A command needs a project to run in, and not every page builds one, so a page opts in with HTML comments the rendered site drops:

```
<!-- suss:example -->                       run everything below this in an
                                            empty temporary directory
<!-- suss:example fixtures=aws-lambda -->   the same, with fixtures/aws-lambda
                                            copied in at that path, for a page
                                            whose commands name a fixture
<!-- suss:file src/client.ts -->            write the next code fence there
<!-- suss:excerpt -->                       the next output fence shows part of
                                            the output, so look for those lines
                                            inside it
<!-- suss:unchecked <reason> -->            everything below this goes
                                            unchecked, and here is why
```

Inside a run, a code fence introduced by a paragraph that starts with a backticked path and ends with a colon is written to that path. Both tutorials already write their fences that way. Use `suss:file` when the prose around a fence doesn't spell out where it goes.

Only suss commands run. `npm install express` and `mkdir` are left where they are, because extraction reads import specifiers rather than resolved packages and these projects need no `node_modules`. Where a bash fence has several commands in it, the output below it is compared against the last one, and timings and absolute paths are normalised out first.

At the end, the check lists every output block it did not run, with the reason. Add a page to that list whenever you need to. An unchecked page on that list is better than a number that nothing verifies.

## Reporting bugs

Open an issue using the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). For a bug, a tsconfig plus a handful of TS files is usually enough to reproduce it.

## Code of conduct and license

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Contributions are licensed under [Apache 2.0](LICENSE).
