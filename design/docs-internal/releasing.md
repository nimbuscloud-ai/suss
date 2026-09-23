# Releasing

All 31 packages share one version. You raise that number once in the
root `package.json`.
[`scripts/preparePublish.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/preparePublish.mjs)
copies it into every package, and
[`scripts/release.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/release.mjs)
publishes the whole set at whatever version is committed. The workflow
never picks a version by itself.

Most of what follows is about npm credentials. They live outside the
repository, so a commit cannot fix them.

## Running a release

A release has two steps, and a person does the first one.

**Raise the version, on a branch.** `npm run bump patch` moves the
version up one patch. It also accepts `minor`, `major`, or a version you
type. It writes the root `package.json`, runs `preparePublish` over the
packages, and refreshes `package-lock.json`, because `npm ci` refuses to
install from a lockfile that is out of date. Read the diff, commit it as
`chore: release <version>`, and open a pull request like any other
change.

**Publish it.** Once the bump is on `main`, go to Actions → Release →
Run workflow. The workflow reads the version from the root
`package.json`, stops if that version already has a tag, and publishes.
With `dry-run` it publishes nothing but still writes the release notes
to the job summary, so you can read them before anything goes out.

Start with a dry run. Before it lists anything, it asks the registry
for a publishing credential for every package the run would write. That
request is the only thing that proves a package will publish, so a
rehearsal that prints "would publish 31 packages" would in fact have
published them. A publishing run makes the same request before it
writes the first package. If a release cannot finish, it publishes
nothing and lists the packages that need setting up.

The request mints a short-lived token and writes nothing, so a dry run
can check every package as often as you like.

You can publish from a laptop with `npm run release -- --otp <code>`,
which does the same thing without the tag or the GitHub release. It
prints the three commands for those at the end.

## What goes in the release notes

[`scripts/changelog.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/changelog.mjs)
reads the commits between the last release and `HEAD` and groups them by
conventional-commit type: features first, then fixes, then the rest. A
squash merge ends its subject with the pull request number, and the line
in the notes links to that pull request. A commit without a number links
to the commit.

Run it any time to see what the next release would contain:

```sh
npm run changelog                    # since the last release, to HEAD
npm run changelog -- --from v0.1.0 --version 0.2.0
```

A subject that is not a conventional commit still gets a line, under
"Other changes". The script never drops a commit because of how its
subject is written.

The notes are published on the GitHub release and nowhere else. There
is no committed `CHANGELOG.md`. The commits already record all of it,
and a second copy in the tree would be one more thing to keep in step.

## How npm authenticates the publish

The workflow uses trusted publishing and nothing else. npm takes the
workflow's OIDC token, sends it to the registry, and gets back a
short-lived credential. Nothing is stored, and there is no automation
token behind it. We set it up this way on purpose, so there is no
long-lived write credential to leak or rotate.

If the job cannot mint an OIDC token at all, the release stops before it
writes anything. In the 0.0.2 run, `ENEEDAUTH` on all 34 packages meant
exactly that: npm had no credential at all. The registry had not refused
one.

## Setting up trusted publishing

The token exchange happens **once per package**, against a trusted
publisher that each package configures separately, at
`POST /-/npm/v1/oidc/token/exchange/package/{name}`. A package that has
not been set up gets nothing back. With no token to fall back on, that
package fails and the others do not. npm has no organization-wide
setting and no bulk UI, so you do this for each package.

On npmjs.com, for each package, go to **Packages → the package →
Settings → Trusted Publisher → GitHub Actions** and fill in:

| Field | Value |
| --- | --- |
| Organization or user | `nimbuscloud-ai` |
| Repository | `suss` |
| Workflow filename | `release.yml` |
| Environment name | *(leave empty)* |
| Allowed actions | `npm publish` |

Enter the workflow filename without its directory (not
`.github/workflows/release.yml`), and keep the extension. A package can
have only one trusted publisher at a time, so to change providers you
edit the existing entry instead of adding a second.

### A package npm has never seen

The settings page belongs to a package. A package that has never been
published has no page to configure a publisher on, so its first version
cannot go out over OIDC. Every package that failed at 0.11.0 was already
on the registry from an earlier release but had never been set up. That
is why setting them up and re-running worked.

Publish the first version of a new package by hand, then configure its
trusted publisher. After that it releases the same way as the rest. The
dry run catches a package in this state: it requests a credential for
each package, stops on the one that gets none, and lists which other
packages depend on it.

Nothing needs to change in the repository. The workflow already
supplies everything the exchange needs:

- `permissions: id-token: write` on the job. Without it the runner
  cannot mint an OIDC token, and npm skips the exchange without saying
  so.
- npm 11.5.1 or newer. No Node release bundles a version that new yet,
  so the workflow has an `npm install --global npm@latest` step.
- Node 22.14.0 or newer. `.nvmrc` says `22`, and `setup-node` resolves
  that to the newest 22.x, so this is satisfied with no extra step.
- `registry-url` on `setup-node`. It sets the audience the token is
  minted for.

Self-hosted runners are not supported.

npm attaches [provenance](https://docs.npmjs.com/generating-provenance-statements)
automatically when it publishes this way, so nothing passes
`--provenance`.

### Closing the other door

Once a package uses trusted publishing, turn on **Settings → Publishing
access → Require two-factor authentication and disallow tokens** for it.
The setting does not affect trusted publishing, because trusted
publishing does not authenticate with a token. With it on, a stolen
token cannot publish, even one minted later. A dry run tries the
exchange for every package, so a green dry run tells you every package
has switched over.

## When a release fails

When packages fail, the publish step prints npm's full output for one
of them and then says that the rest failed the same way. One full
transcript tells you more than 44 identical error codes.

`--verbose` makes npm log the details of the token exchange. npm only
explains why a credential came back empty at that level, and the
workflow already passes the flag.

You can re-run a release that published some packages and not others
without changing anything. The script skips every package already on the
registry at that version, so the second run publishes only what is left.
A package published moments earlier can still look missing, because
reads from npm lag behind writes by minutes. Publishing it again returns
"cannot publish over the previously published versions". The script
counts that as success, because the registry is confirming the version
is up.

## What a release leaves behind

- 31 packages on the registry at the new version.
- An annotated `v<version>` tag on the commit that was published.
- A GitHub release at that tag, titled `v<version>`, with the notes
  the workflow generated from the commits since the last release.

The version bump commit is on `main` before the workflow runs, so the
workflow pushes a tag and nothing else. It stops before publishing if
the tag already exists. That happens when somebody dispatches a run
twice, or dispatches one without bumping the version first.

The tag has to be annotated. `--follow-tags` skips a lightweight tag, as
does anything else that reads tag objects. That is how 0.0.2 reached npm
and `main` with no tag. The workflow creates the release with
`--verify-tag`, so if the tag did not reach the remote, no release is
written either.

Publishing 31 packages, tagging, and writing the release are three
separate steps, and a run can stop between any two of them. Dispatching
again is safe. The packages already on the registry are skipped, and the
tag check stops the run before it publishes a version that is already
out. If the tag was pushed but the release was not written, write it by
hand:

```sh
node scripts/changelog.mjs --from v0.0.2 --version 0.0.3 --output /tmp/notes.md
gh release create v0.0.3 --title v0.0.3 --notes-file /tmp/notes.md --verify-tag
```
