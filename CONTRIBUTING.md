# Contributing to suss

Thanks for your interest in contributing. This document covers the practical bits — for design conventions, see [`docs/style.md`](docs/style.md).

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
```

CI runs the same checks on every PR — they must pass before merge.

A pre-commit hook (husky + lint-staged) runs `biome check --write` on staged files. A pre-push hook runs the full test suite with coverage. Don't bypass either with `--no-verify` unless you've coordinated with a maintainer.

## Scope of a PR

Keep PRs focused on a single intent. If you find yourself writing "and also" in the description, split it.

- **Bug fix:** the fix + a regression test. Avoid opportunistic cleanup.
- **Feature:** the feature + tests + doc updates. New exported APIs need at least a one-line doc.
- **Refactor:** no behavior change. Tests should be untouched or only renamed.
- **Docs / chore:** standalone, no code changes.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/). See [`docs/style.md#commits`](docs/style.md#commits) for the full rules. In short:

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
- See [`docs/style.md#tests`](docs/style.md#tests).

## Adding a new framework pack

Framework packs are declarative pattern configurations. See [`docs/framework-packs.md`](docs/framework-packs.md) for the full guide. The existing packs under `packages/framework/` and `packages/runtime/` are the best reference.

## Reporting bugs and proposing features

Open an issue using the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). For a bug, include a minimal repro (tsconfig + a handful of TS files is usually enough). For a feature, describe the real problem first — "what I'm trying to do" — before jumping to a proposed API.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to uphold it.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
