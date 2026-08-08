# Contributing to suss

Thanks for your interest in contributing. This document covers the practical bits — for design conventions, see [`docs/internal/style.md`](docs/internal/style.md).

## Getting set up

```sh
git clone https://github.com/nimbuscloud-ai/suss.git
cd suss
npm install
npm run build
npm test
```

Requires Node.js ≥ 22.

## Before you open a PR

Run locally:

```sh
npm run lint       # biome
npm run typecheck  # tsc --noEmit across packages
npm test           # vitest across packages
npm run dogfood    # run suss over its own 44 packages
```

CI runs the same checks on every PR — they must pass before merge.

`npm run dogfood` is the widest check here: it runs discovery, extraction, resolution and the checker over all 44 packages rather than a fixture. It fails when an export a package declares produces no summary, and it writes the per-package counts to `scripts/dogfood-baseline.json`, which is committed. CI then runs `npm run check:dogfood`, which fails when a count came out below the committed one. Each package gets three counts: `exports` for the summaries describing its declared public surface, `internal` for the ones behind that surface, and `consumers` for its calls into other packages.

So if your change deletes exports, moves them between packages, inlines a private helper, or narrows a recognizer that was over-firing, run `npm run dogfood` and commit the refreshed baseline. The drop shows up in your pull request diff, which is where a reviewer agrees it was meant. Counts going up need no refresh. `docs/internal/dogfooding.md` has the full table of what fails and what to do.

Line coverage works the same way. Each package under the coverage gate commits a `coverage/coverage-summary.json`, and CI runs `npm run check:coverage`, which fails when a package's line coverage came out below the figure your commit carries. So if your change lowers coverage on purpose, run `npm run test:badges` and commit the refreshed summaries and badges, and the drop shows up in your diff. Coverage holding or going up needs no refresh.

Timing a change is `npm run bench`, which runs `suss extract` over the five public corpora under `dogfood-targets/` and reports wall clock, the datalog share, and the spread across repeats. `npm run bench -- --against <commit>` compares two builds, alternating between them so a busy stretch cannot land on one side. It refuses to report at all when the machine is busy, because load moves these numbers by more than most changes do. Five targets at three repeats takes about five minutes, and `--subset` takes about a minute and a half over saleor-dashboard, saleor-storefront and directus/api. Nothing in CI enforces a budget yet.

Neither check reads `main`. Both compare a fresh run against the tree it ran on, so a merge landing on `main` while your branch is open cannot fail your build on a package you never opened. Your branch also never needs to touch `scripts/dogfood-baseline.json`, a `coverage-summary.json`, or a badge unless it is lowering a number. `.github/workflows/regenerate.yml` reruns the dogfood pass and the test suite on `main` after every merge and commits whatever moved, so those three files catch up with the source on their own instead of every open branch racing to regenerate the same ones.

A pre-commit hook (husky + lint-staged) runs `biome check --write` on staged files. A pre-push hook typechecks, runs the full test suite with coverage, rebuilds the badges, and runs the same `check:coverage` gate CI does, so a coverage drop is caught before the push instead of in CI. Don't bypass either with `--no-verify` unless you've coordinated with a maintainer.

## Landing a branch that has gone stale

Every merge into `main` runs the regenerate workflow, which refreshes
the dogfood baseline, the coverage summaries and the badges. So a branch
that was verified yesterday can conflict on those files today with
nothing wrong in it. `npm run land` does that round for you:

```bash
node scripts/land.mjs 123           # the pull request number
node scripts/land.mjs 123 --dry-run
```

Through npm it is `npm run land`, with npm's argument separator before
the number.

It rebases the branch onto `origin/main` in a temporary worktree, never
in the checkout you ran it from. A conflict inside the generated files
is resolved by taking main's side, and the generators rerun so the
branch's own numbers land back in them, gated by `typecheck`,
`check:dogfood` and `check:coverage`. A conflict anywhere else aborts
the rebase and exits non-zero, because that is a change someone has to
read. The push is `--force-with-lease` against the head the run started
from, and nothing here merges the pull request.

## Scope of a PR

Keep PRs focused on a single intent. If you find yourself writing "and also" in the description, split it.

- **Bug fix:** the fix + a regression test. Avoid opportunistic cleanup.
- **Feature:** the feature + tests + doc updates. New exported APIs need at least a one-line doc.
- **Refactor:** no behavior change. Tests should be untouched or only renamed.
- **Docs / chore:** standalone, no code changes.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/). See [`docs/internal/style.md#commits`](docs/internal/style.md#commits) for the full rules. In short:

```
<type>(<scope>): <short summary>

<optional body — explain why, not what>
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`.
Scopes: `ir`, `extractor`, `adapter`, `cli`, `checker`, `express`, `react-router`, `ts-rest`, or omit for cross-cutting changes.

## Writing tests

- Vitest, test files next to source (`foo.ts` → `foo.test.ts`).
- Describe behavior, not implementation: `it("rejects missing id")` beats `it("extractId works")`.
- Prefer hand-crafted fixtures over file-based ones when they fit on one screen.
- See [`docs/internal/style.md#tests`](docs/internal/style.md#tests).

## Naming

Name a thing for the job it does, and let a package's directory spell out the name it publishes: `@suss/framework-hono` lives in `packages/framework/hono`. [`docs/internal/style.md#naming`](docs/internal/style.md#naming) covers package, directory, function, Datalog-relation, and concept names.

## Adding a new framework pack

Framework packs are declarative pattern configurations. See [`docs/packs.md`](docs/packs.md) for the full guide. The existing packs under `packages/framework/` and `packages/client/` are the best reference.

A pack may hardcode an identifier only when the library that pack is about defines it. Anything a specific codebase names goes in per-project configuration, because other users get false matches on it, and coverage measured against the codebase the name came from is inflated when discovery finds those units by name rather than by pattern. Declare every identifier the pack names in its `vocabulary.json`; `npm run check:vocabulary` fails otherwise. [`docs/internal/style.md#identifiers-a-pack-names`](docs/internal/style.md#identifiers-a-pack-names) has the detail.

## Reporting bugs and proposing features

Open an issue using the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). For a bug, include a minimal repro (tsconfig + a handful of TS files is usually enough). For a feature, describe the real problem first — "what I'm trying to do" — before jumping to a proposed API.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to uphold it.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
