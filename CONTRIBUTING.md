# Contributing to suss

For design conventions, see [`docs/internal/style.md`](docs/internal/style.md).

## Getting set up

Node.js 22 or newer.

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
npm run dogfood    # run suss over its own 58 packages
```

`npm run dogfood` is the widest check here. It runs discovery, extraction, resolution and the checker over all 58 packages rather than over a fixture, and it fails when a package declares an export that produces no summary. It writes the per-package counts to `scripts/dogfood-baseline.json`, which is committed, and CI runs `npm run check:dogfood` to fail when a count comes out below the committed one. Each package gets three counts: `exports` for the summaries that describe its declared public surface, `internal` for the ones behind that surface, and `consumers` for its calls into other packages.

So if your change deletes exports, moves them between packages, inlines a private helper, or narrows a recognizer that was firing too often, run `npm run dogfood` and commit the refreshed baseline. The drop then appears in your pull request diff, where a reviewer can see it and agree you meant it. Counts going up need no refresh. `docs/internal/dogfooding.md` has the full table of what fails and what to do about it.

Line coverage works the same way. Each package under the coverage gate commits a `coverage/coverage-summary.json`, and `npm run check:coverage` fails when a package comes out below the number your commit records. Lowering coverage on purpose means running `npm run test:badges` and committing the refreshed summaries and badges, so the drop appears in your diff.

Neither check reads `main`. Both compare a fresh run against the tree they ran on, so a merge landing on `main` while your branch is open cannot fail your build on a package you never opened. Your branch also never needs to touch `scripts/dogfood-baseline.json`, a `coverage-summary.json`, or a badge unless it is lowering a number. After every merge, `.github/workflows/regenerate.yml` reruns the dogfood pass and the test suite on `main` and commits whatever moved, so those three files catch up with the source on their own.

The pre-push hook typechecks, runs the full test suite with coverage, rebuilds the badges, and runs the same `check:coverage` gate CI does. Don't bypass it unless you've coordinated with a maintainer.

Keep a pull request to a single intent. If you find yourself writing "and also" in the description, split it in two.

## Timing a change

`npm run bench` runs `suss extract` over the five public corpora under `dogfood-targets/` and reports wall clock, how much of that time was datalog, and the spread across repeats. `npm run bench -- --against <commit>` compares two builds, alternating between them so a busy stretch cannot fall entirely on one side. It refuses to report anything at all when the machine is busy, because load moves these numbers by more than most changes do. Five targets at three repeats takes about five minutes; `--subset` takes about a minute and a half over saleor-dashboard, saleor-storefront and directus/api. Nothing in CI enforces a time budget yet.

## Landing a branch that has gone stale

Every merge into `main` runs the regenerate workflow, which refreshes the dogfood baseline, the coverage summaries and the badges. So a branch that was verified yesterday can conflict on those files today even though there is nothing wrong with it. `npm run land` does that round for you:

```bash
node scripts/land.mjs 123           # the pull request number
node scripts/land.mjs 123 --dry-run
```

It rebases the branch onto `origin/main` in a temporary worktree, never in the checkout you ran it from. When a conflict lands inside the generated files, it takes main's side, then reruns the generators so the branch's own numbers go back in. It only finishes if `typecheck`, `check:dogfood` and `check:coverage` all pass. A conflict anywhere else aborts the rebase and exits non-zero, because that is a change someone has to read. It pushes with `--force-with-lease` against the head the run started from, and nothing here merges the pull request.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), with a scope for the affected package: `ir`, `extractor`, `adapter`, `cli`, `checker`, `express`, `react-router`, `ts-rest`, and so on. Omit the scope for changes that cut across the repo. [`docs/internal/style.md#commits`](docs/internal/style.md#commits) has the rest.

## Naming

Name a thing for the job it does, and let a package's directory spell out the name it publishes: `@suss/framework-hono` lives in `packages/framework/hono`. [`docs/internal/style.md#naming`](docs/internal/style.md#naming) covers package, directory, function, Datalog-relation, and concept names.

## Tests

Vitest, with each test file next to its source (`foo.ts` and `foo.test.ts`). A test that parses fixture source takes its ts-morph project from `@suss/test-project`, so every test reads the same language the adapter reads. See [`docs/internal/style.md#tests`](docs/internal/style.md#tests).

## Adding a new framework pack

A framework pack is a set of patterns you declare in configuration rather than write as code. See [`docs/packs.md`](docs/packs.md) for the full guide, and copy from the packs that already exist under `packages/framework/` and `packages/client/`.

A pack may hardcode an identifier only when the library that pack is about defines it. An identifier that comes from one particular codebase belongs in per-project configuration instead. If you ship it as a default, other users get false matches on it, and coverage measured against the codebase the name came from looks better than it is, because discovery found those units by name rather than by pattern. List every identifier your pack hardcodes in its `vocabulary.json`, or `npm run check:vocabulary` will fail. [`docs/internal/style.md#identifiers-a-pack-names`](docs/internal/style.md#identifiers-a-pack-names) has the detail.

## Adding a metadata field

A field on a metadata namespace needs a writer and a reader before it does anything. Both halves are usually written weeks apart, and the test on each side passes whether or not the other side exists, so `npm run check:metadata-wiring` compares the two lists instead. A field with a writer and no reader, or a reader and no writer, fails the build. If the consumer is genuinely still to come, add the field to `EXEMPT` in [`scripts/checkMetadataWiring.mjs`](scripts/checkMetadataWiring.mjs) with the reason and the issue that tracks it. [`docs/internal/style.md#both-sides-of-a-metadata-field`](docs/internal/style.md#both-sides-of-a-metadata-field) has the detail.

## Reporting bugs

Open an issue using the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). For a bug, a tsconfig plus a handful of TS files is usually enough to reproduce it.

## Code of conduct and license

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Contributions are licensed under [Apache 2.0](LICENSE).
