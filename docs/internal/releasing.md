# Releasing

All 50 packages share one version. You raise that number once in the
root `package.json`,
[`scripts/preparePublish.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/preparePublish.mjs)
copies it out to every package, and
[`scripts/release.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/release.mjs)
publishes the whole set at whatever version is committed. The workflow
never picks a version of its own.

Most of this page is about npm credentials, because that is the part
that lives outside the repository and cannot be fixed by a commit.

## Running a release

Two steps, and a person does the first one.

**Raise the version, on a branch.** `npm run bump patch` moves the
version up one patch. It also takes `minor`, `major`, or a version you
type. It writes the root `package.json`, runs `preparePublish` over the
packages, and refreshes `package-lock.json`, which `npm ci` would
otherwise refuse to install from. Read the diff, commit it as
`chore: release <version>`, and open a pull request like any other
change.

**Publish it.** Once that is on `main`: Actions → Release → Run
workflow. It reads the version out of the root `package.json`, stops if
that version is already tagged, and publishes. `dry-run` publishes
nothing and still writes the release notes to the job summary, so you
can read what the release would say before it says it.

Start with a dry run. It reports which credential it found before it
lists anything, so a rehearsal that says "would publish 50 packages" is
one that would in fact have published them.

You can publish from a laptop with `npm run release -- --otp <code>`,
which does the same thing without the tag or the GitHub release. It
prints the three commands for those at the end.

## What goes in the release notes

[`scripts/changelog.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/changelog.mjs)
reads the commits between the last release and `HEAD` and groups them by
conventional-commit type, features first, then fixes, then the rest. A
squash merge ends its subject with the pull request number, and that
number becomes the link on the line. A commit that arrived without one
links to itself instead.

Run it any time to see where things stand:

```sh
npm run changelog                    # since the last release, to HEAD
npm run changelog -- --from v0.1.0 --version 0.2.0
```

A subject that is not a conventional commit still gets a line, under
"Other changes". Nothing is dropped for being written the wrong way.

The notes live on the GitHub release and nowhere else. There is no
committed `CHANGELOG.md`, because the commits already say all of this
and a second copy in the tree is one more thing to keep in step.

## How npm authenticates the publish

Trusted publishing, and nothing else. npm takes the workflow's OIDC
token, hands it to the registry, and gets back a short-lived credential.
Nothing is stored, and there is no automation token behind it. That is
deliberate, so there is no long-lived write credential to leak or
rotate.

If the job cannot mint an OIDC token at all, the release stops before it
writes anything. That is what `ENEEDAUTH` on all 34 packages meant in
the 0.0.2 run: npm had no credential at all, rather than the registry
refusing one it had.

## Setting up trusted publishing

The exchange happens **once per package**, against a trusted publisher
that each package configures for itself, at
`POST /-/npm/v1/oidc/token/exchange/package/{name}`. A package that has
not been set up gets nothing back, and with no token to fall back on,
that package alone fails. There is no organization-wide setting and no
bulk UI, so you do this 44 times.

On npmjs.com, for each package: **Packages → the package → Settings →
Trusted Publisher → GitHub Actions**, then

| Field | Value |
| --- | --- |
| Organization or user | `nimbuscloud-ai` |
| Repository | `suss` |
| Workflow filename | `release.yml` |
| Environment name | *(leave empty)* |
| Allowed actions | `npm publish` |

The workflow filename is the name on its own (not
`.github/workflows/release.yml`), and it keeps its extension. A package
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

npm attaches [provenance](https://docs.npmjs.com/generating-provenance-statements)
by itself when it publishes this way, so nothing passes `--provenance`.

### Closing the other door

Once a package is switched over, set **Settings → Publishing access → Require
two-factor authentication and disallow tokens** on it. That setting does
not affect trusted publishing, which is not token authentication, and it
means a stolen token cannot publish even if one is minted later. Do it
only after an actual release has gone out over OIDC; a dry run does not
exercise the exchange.

## When a release fails

The publish step prints one failing package's npm output in full and
then notes that the rest failed the same way, since 44 identical error
codes tell you less than one full transcript does.

`--verbose` puts npm's own account of the token exchange in the log. It
is the only level at which npm explains why a credential came back
empty, and the workflow already passes it.

A run that publishes some packages and not others can be re-run as-is.
Anything already on the registry at that version is skipped, so the
second run picks up only what is left. A package published moments
earlier can still look missing, because npm's read path trails its
write path by minutes. Publishing it again returns "cannot publish over
the previously published versions", and that counts as success, because
the registry is confirming the version is up.

## What a release leaves behind

- 50 packages on the registry at the new version.
- An annotated `v<version>` tag on the commit that was published.
- A GitHub release at that tag, titled `v<version>`, carrying the notes
  the workflow generated from the commits since the last release.

The version bump commit is already on `main` before any of this runs, so
the workflow pushes a tag and nothing else. It stops before publishing
if that tag is already there, which is what happens when somebody
dispatches a run twice, or dispatches one without bumping the version
first.

The tag has to be annotated. A lightweight one is skipped by
`--follow-tags` and by anything else that reads tag objects, and that is
how 0.0.2 reached npm and `main` with no tag on it. The release is
created with `--verify-tag`, so if the tag did not reach the remote the
release is not written either.

Publishing 50 packages, tagging, and writing the release are three
steps, and a run can stop between them. Re-dispatching is safe: the
packages already on the registry are skipped, and the tag check stops
the run before it publishes a version that is already out. If the tag
landed but the release did not, write it by hand:

```sh
node scripts/changelog.mjs --from v0.0.2 --version 0.0.3 --output /tmp/notes.md
gh release create v0.0.3 --title v0.0.3 --notes-file /tmp/notes.md --verify-tag
```
