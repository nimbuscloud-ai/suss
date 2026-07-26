# Releasing

All 34 packages share one version. A release is that number bumped
once in the root `package.json`, copied out to every package by
[`scripts/preparePublish.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/preparePublish.mjs),
and published by
[`scripts/release.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/release.mjs).
The Release workflow drives both.

Most of this page is about npm credentials, because that is the part
that lives outside the repository and cannot be fixed by a commit.

## Running a release

Actions → Release → Run workflow. Pick `patch`, `minor` or `major`, or
type an exact version to override the choice. `dry-run` lists what
would publish and publishes nothing.

The workflow dispatches from a branch and pushes the version bump
commit and its tag back to that same branch, so run it from `main`
unless you mean otherwise.

Start with a dry run. It reports which credential it found before it
lists anything, so a rehearsal that says "would publish 34 packages" is
one that would really have published them.

## How npm authenticates the publish

Two ways, tried in that order.

**Trusted publishing.** npm takes the workflow's OIDC token, hands it
to the registry, and gets back a short-lived credential. Nothing is
stored and nothing expires in someone's password manager. This is the
one to use.

**An automation token,** in the `NPM_TOKEN` repository secret. The
Publish step reads it as `NODE_AUTH_TOKEN`, which `actions/setup-node`
has already written into the `.npmrc` it points npm at. This is the
fallback for packages not yet converted.

If neither is in place the release stops before it writes anything and
names which one is missing. Both being absent is what produced
`ENEEDAUTH` on all 34 packages in the 0.0.2 run — npm having no
credential at all, rather than one being refused.

## Setting up trusted publishing

The exchange happens **once per package**, against a trusted publisher
each package names for itself, at
`POST /-/npm/v1/oidc/token/exchange/package/<name>`. A package that has
not been set up gets nothing back, npm falls through to the token, and
that package alone fails. There is no organization-wide setting and no
bulk UI, so this is 34 passes.

On npmjs.com, for each package: **Packages → the package → Settings →
Trusted Publisher → GitHub Actions**, then

| Field | Value |
| --- | --- |
| Organization or user | `nimbuscloud-ai` |
| Repository | `suss` |
| Workflow filename | `release.yml` |
| Environment name | *(leave empty)* |
| Allowed actions | `npm publish` |

The workflow filename is the name on its own — not
`.github/workflows/release.yml` — and it keeps its extension. A package
can have only one trusted publisher at a time; changing providers means
editing the existing entry rather than adding a second.

Nothing needs to change in the repository. The pieces the workflow has
to supply are already there:

- `permissions: id-token: write` on the job, which is what lets the
  runner mint an OIDC token at all. Without it npm skips the exchange
  silently.
- npm 11.5.1 or newer, which is ahead of what any Node release bundles,
  hence the `npm install --global npm@latest` step.
- Node 22.14.0 or newer. `.nvmrc` says `22`, which `setup-node`
  resolves to the newest 22.x, so this holds on its own.
- `registry-url` on `setup-node`, which decides the audience the token
  is minted for.

Self-hosted runners are not supported.

### Once every package is across

npm attaches [provenance](https://docs.npmjs.com/generating-provenance-statements)
by itself when it publishes this way, so nothing passes `--provenance`.

Then tighten the other door: **Settings → Publishing access → Require
two-factor authentication and disallow tokens**, and revoke the
automation token. That setting does not affect trusted publishing,
which is not token authentication. Do it only after a real release has
gone out over OIDC — a dry run does not exercise the exchange.

## When a release fails

The publish step prints one failing package's npm output in full and
says when the rest failed the same way, since 34 identical error codes
say less than one transcript does.

`--verbose` puts npm's own account of the token exchange in the log. It
is the only level at which npm explains why a credential came back
empty, and the workflow already passes it.

A run that publishes some packages and not others can be re-run as-is.
Anything already on the registry at that version is skipped, so the
second run picks up only what is left. A package published moments
earlier can still read as missing, because npm's read path trails its
write path by minutes; publishing it again returns "cannot publish over
the previously published versions", which counts as success, because it
is the registry confirming the version is up.

## What a release leaves behind

- 34 packages on the registry at the new version.
- A `chore: release <version>` commit on the branch it ran from.
- An annotated `v<version>` tag, pushed with that commit in one atomic
  push, so a release is never half-recorded.
- A **draft** GitHub release with generated notes, which someone still
  has to read and publish.

The tag has to be annotated: `git push --follow-tags` carries annotated
tags only, and a lightweight one stays on the runner while the commit
goes out — which is how 0.0.2 reached npm and `main` with no tag behind
it. The push names the tag explicitly now, so it no longer turns on
that distinction.
