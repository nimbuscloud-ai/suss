# suss inspect --diff as a pull request comment

The action reads every boundary in the repository at the base of a pull request and again at its head, then posts what changed as one comment on the pull request. A later push edits that comment instead of adding another. The `push` trigger is optional. With it, the action reads each commit on `main` before the pull requests that branch from it need it (see [Caching](#caching)).

```yaml
name: suss

on:
  pull_request:
  push:
    branches: [main]

jobs:
  behavior-diff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
```

The action reads the packs from the project's `suss.json`, which `suss init` writes. Without that file, it picks the packs `init` would pick. Set `extract` to choose them yourself:

```yaml
      - uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
        with:
          extract: -p tsconfig.json -f hono -f prisma
```

The comment looks like this:

> ### 2 units change behavior in this pull request
>
> ```
> 1 boundary changed: 1 outcome, 1 effect. 1 unit inside the project also changed.
>
> ~ serves POST /users  src/handlers/users.ts::createUser  (1 outcome, 1 effect)
>   outcomes
>     ~ responds 201 { id, email, -name }  otherwise
>   effects
>     + writes postgresql:audit_log  through recordChange
>
> Changes by file
>
> src/handlers/users.ts
>   ~ createUser
>
> src/serializers/user.ts  (changed in this pull request)
>   ~ serializeUser  1 outcome
> ```
>
> <sub>Read by suss at 3f2a1c9. The summaries it compared are the `suss-diff` artifact of the run; `suss inspect after.json` on them says where suss could not follow a call.</sub>

## Inputs

| Input | Default | What it is |
| --- | --- | --- |
| `extract` | empty | The arguments to `suss extract`, after the command. Empty reads the packs from `suss.json`, or the ones `suss init` would pick when there is no file. `-p tsconfig.json -f express` chooses them for a TypeScript project, `--dir src -f fastapi` for Python, `--dir app -f rails` for Ruby. |
| `working-directory` | `.` | The directory to run `suss extract` in, relative to the repository root. |
| `version` | `latest` | The version of `@suss/cli` to install. |
| `install` | empty | A shell command that installs dependencies in the base checkout, such as `pnpm install --frozen-lockfile` or `npm ci && npm run build`. When it is empty, the base checkout shares the head's `node_modules` directories, which works when the pull request does not change dependencies. |
| `comment` | `true` | Whether to post the comment. Set it to `false` to read the outputs and do something else with them. |
| `artifact-name` | `suss-diff` | The name of the run artifact that keeps both summary files and the diff. Two uses of the action in one workflow need two names. |
| `cache` | `true` | Whether to keep suss's per-file cache and each commit's summaries in the repository's actions cache. See [Caching](#caching). |
| `token` | `github.token` | The token used to post the comment. It needs `pull-requests: write`. |

## Outputs

| Output | What it is |
| --- | --- |
| `changed` | How many units changed behavior, as a number. |
| `diff` | The path of the rendered diff. |
| `before` | The path of the summaries read from the base commit. |
| `after` | The path of the summaries read from the head commit. |

A job condition can read `changed`:

```yaml
      - uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
        id: suss
        with:
          extract: -p tsconfig.json -f hono
      - if: steps.suss.outputs.changed != '0'
        run: echo "::notice::${{ steps.suss.outputs.changed }} units changed behavior"
```

## How it reads the base

`actions/checkout` has already checked out the head. The action fetches the base commit, adds it as a git worktree under the runner's temporary directory, and runs the same `suss extract` there. The worktree is named after the repository, so file paths are the same on both sides and every unit pairs with itself.

A pull request from a fork gets a read-only token, so the comment step fails there. The diff is still in the job log and in the artifact. If you would rather not see the failure, set `comment: false` for pull requests from forks:

```yaml
        with:
          extract: -p tsconfig.json -f hono
          comment: ${{ github.event.pull_request.head.repo.full_name == github.repository }}
```

## Caching

Reading a large project takes a while, and the action reads it twice. Two caches cut that time down. Both live in the repository's actions cache, and both are on by default.

The first is suss's own per-file cache, the `.suss/cache` directory next to the project. The action restores it before it reads the head and saves it afterwards, so a file the pull request did not touch is not read again. A run that changes one file reads that file and whatever depends on it.

The second cache stores the summaries for each commit. To use it, run the action on a push to the default branch as well as on pull requests:

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

On a push, the action reads the commit, saves its summaries under that commit, and stops. There is no diff and no comment, and `changed` is empty. A pull request whose base is that commit restores those summaries and skips the base checkout. A pull request whose base was never read this way reads the base itself, and saves it for its later pushes.

Both caches are keyed on the installed version of `@suss/cli` and on `extract` and `working-directory`, so a new release or a change to the packs starts them again from empty. Set `cache: false` to read everything on every run.

## How the comment is organized

The first line counts what changed: how many boundaries, how many of their outcomes and effects, and how many units further inside the project changed as well.

When one filter, middleware or error handler adds the same outcome to several routes, that outcome is printed once under `From <wrapper>`. It lists the routes that have it, and the routes the wrapper runs on that still do not. So fourteen routes gaining a 401 is printed as the single edit it was. A route that already responded that way is left off both lines, since nothing about it changed.

Next comes a block for each boundary that changed. `outcomes` shows what it returns and under what test, and `effects` shows what a request now reaches, or no longer reaches, through the calls it makes. A unit deeper in the project does not get a block of its own, since the boundaries that reach it already show what its change did. When no boundary changed, the first line says so.

Last come the files that contain units that changed. A unit with only a couple of changed lines has them written out. A unit with more gets a count of the outcomes and effects that changed. A unit in a file the pull request edited gets the count either way, since the reviewer already has that file's diff in front of them.

The action asks GitHub which files the pull request changed and passes them to `suss inspect --diff --changed-files`. Those files come last and are marked. If the call to GitHub fails, every file is treated as untouched.

A comment is limited to 65,536 characters, so the action renders it with `--budget`, and the report counts what it left out. The whole diff is in the run's artifact.

## Where the diff comes from

`suss extract` reads every unit a pack recognizes, such as a route handler, a queue consumer or a Lambda, into a summary of what it produces on each path. `suss inspect --diff` compares two sets of summaries unit by unit and prints the paths that differ. Nothing runs and no model is involved, so the same source produces the same diff every time. The [reference for `inspect`](https://github.com/nimbuscloud-ai/suss/blob/main/docs/reference/cli/inspect.md) explains what each line of the output means.
