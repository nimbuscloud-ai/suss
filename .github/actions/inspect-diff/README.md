# suss inspect --diff as a pull request comment

The action reads every boundary in the repository at the base of a pull request and again at its head, then posts what changed as one comment on the pull request. A later push edits the same comment rather than adding another.

```yaml
name: suss

on: [pull_request]

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
        with:
          extract: -p tsconfig.json -f hono -f prisma
```

The comment looks like this:

> ### 1 unit changes behavior in this pull request
>
> ```
> handler:POST /users
>   hono handler
>   1 change
>     ~ 201 { id, email, name }  (default)
>       -> 201 { id, email }  (default)
> ```
>
> <sub>Read by suss at 3f2a1c9. The summaries it compared are the `suss-diff` artifact of the run.</sub>

## Inputs

| Input | Default | What it is |
| --- | --- | --- |
| `extract` | required | The arguments to `suss extract`, after the command. `-p tsconfig.json -f express` for a TypeScript project, `--dir src -f fastapi` for Python, `--dir app -f rails` for Ruby. |
| `working-directory` | `.` | The directory to run `suss extract` in, relative to the repository root. |
| `version` | `latest` | The version of `@suss/cli` to install. |
| `install` | empty | A command that installs dependencies in the base checkout, such as `pnpm install --frozen-lockfile`. When it is empty the base checkout shares the head's `node_modules` directories, which is right when the pull request does not change dependencies. |
| `comment` | `true` | Whether to post the comment. Set it to `false` to read the outputs and do something else with them. |
| `artifact-name` | `suss-diff` | The name of the run artifact that keeps both summary files and the diff. Two uses of the action in one workflow need two names. |
| `token` | `github.token` | The token used to post the comment. It needs `pull-requests: write`. |

## Outputs

| Output | What it is |
| --- | --- |
| `changed` | How many units changed behavior, as a number. |
| `diff` | The path of the rendered diff. |
| `before` | The path of the summaries read from the base commit. |
| `after` | The path of the summaries read from the head commit. |

`changed` is what a job condition reads:

```yaml
      - uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
        id: suss
        with:
          extract: -p tsconfig.json -f hono
      - if: steps.suss.outputs.changed != '0'
        run: echo "::notice::${{ steps.suss.outputs.changed }} units changed behavior"
```

## How it reads the base

The head is already checked out by `actions/checkout`. The action fetches the base commit and adds it as a git worktree under the runner's temporary directory, then runs the same `suss extract` there. The worktree is named after the repository, so a file path reads the same on both sides and every unit pairs with itself.

A pull request from a fork gets a read-only token, so the comment step fails there. The diff is still in the job log and in the artifact. Set `comment: false` on fork pull requests if the failure is unwelcome:

```yaml
        with:
          extract: -p tsconfig.json -f hono
          comment: ${{ github.event.pull_request.head.repo.full_name == github.repository }}
```

## Where the diff comes from

`suss extract` reads every unit a pack recognizes, a route handler or a queue consumer or a Lambda, into a summary of what it produces on each path. `suss inspect --diff` compares two sets of summaries by unit and prints the paths that differ. Nothing runs and no model is involved, so the same source produces the same diff every time. The [reference for `inspect`](https://github.com/nimbuscloud-ai/suss/blob/main/docs/reference/cli.md) says what each line of the rendering means.
