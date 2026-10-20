---
title: Read a pull request
description: Diff the behavior of two commits instead of their lines, then put the same diff on every pull request as a comment.
---

# Read a pull request

`inspect --diff` reads the summaries from before a change and the ones
from after, and prints the boundaries whose behavior moved.

<!-- suss:example -->

`src/routes/users.ts` on the base commit has one route with three
outcomes:

```ts
import { Hono } from "hono";

type User = { id: string; name: string; email: string; deletedAt: string | null };
declare function findUser(id: string): Promise<User | null>;

export const users = new Hono();

users.get("/users/:id", async (c) => {
  const user = await findUser(c.req.param("id"));

  if (!user) {
    return c.json({ error: "not found" }, 404);
  }

  if (user.deletedAt) {
    return c.json({ error: "gone" }, 410);
  }

  return c.json({ id: user.id, name: user.name, email: user.email });
});
```

```bash
npx @suss/cli extract -f hono -o summaries/before.json
```

The pull request rewrites two of those returns. A deleted account used to
get a `410`, and now it gets a `200` with a status field in it. `email`
is also gone from the success body:

<!-- suss:file src/routes/users.ts -->

```ts
import { Hono } from "hono";

type User = { id: string; name: string; email: string; deletedAt: string | null };
declare function findUser(id: string): Promise<User | null>;

export const users = new Hono();

users.get("/users/:id", async (c) => {
  const user = await findUser(c.req.param("id"));

  if (!user) {
    return c.json({ error: "not found" }, 404);
  }

  if (user.deletedAt) {
    return c.json({ id: user.id, status: "deleted" });
  }

  return c.json({ id: user.id, name: user.name });
});
```

```bash
npx @suss/cli extract -f hono -o summaries/after.json
npx @suss/cli inspect --diff summaries/before.json summaries/after.json
```

```
1 boundary changed: 3 outcomes.

~ serves GET /users/{id}  src/routes/users.ts::get  (3 outcomes)
  outcomes
    + responds 200 { id, status }  when  findUser() && findUser().deletedAt
    - responds 410 { error }  when  findUser() && findUser().deletedAt
    ~ responds 200 { id, name, -email }  otherwise

Changes by file

src/routes/users.ts
  ~ get
```

The text diff is two edited lines in one file, and those two lines change
what callers get. A caller that treated `200` as a usable account now
receives deleted accounts as well, and a caller that read `email` gets
`undefined`. The response still matches the `User` type and the OpenAPI
document still lists `200 | 404 | 410`, so the compiler and the schema
both pass.

`--diff` reports the units whose behavior moved, whatever lines the pull
request touched. When a large change moves the behavior of one unit, you
get a report about that one unit.

<!-- suss:unchecked check --base reads git history, and the example runner works in a folder that is not a repository -->

## The findings it introduced

`inspect --diff` says what moved. `check --base` says which of those
moves break something on the other side of a boundary. Say the project
also has a client for the route, in `src/web/profile.ts`:

```ts
export async function loadProfile(id: string) {
  const res = await fetch(`/users/${id}`);

  if (res.status === 404) {
    return null;
  }

  if (res.status === 410) {
    return { deleted: true };
  }

  const user = await res.json();
  return { name: user.name, email: user.email };
}
```

On the pull request's branch, `check --base` reads the commit the branch
started from and reports the findings that are new since then:

```bash
npx @suss/cli check --base origin/main
```

```
Compared with eb902e5, where this branch left origin/main. 1 file changed:
  1 boundary changed: GET /users/{id}
  4 new findings, 0 resolved.

────────────────────────────────────────────────────────────
[WARNING] deadConsumerBranch
  Consumer expects status 410 but provider never produces it
  provider: src/routes/users.ts::get (src/routes/users.ts:8)
  consumer: src/web/profile.ts::loadProfile (src/web/profile.ts:1)
  boundary: hono (http) GET /users/:id
```

The client still waits for a `410` that the route stopped sending, and
the report goes on to say that nothing in the client tells the new
`status: "deleted"` body apart from a live account. Each finding gives
the file and line on both sides. The findings the base already had are
left out, and so are the ones that touch nothing the branch changed.
Findings the branch fixed are listed after the new ones, one line each.

The checkout is left alone: the base is written out of git into a
temporary folder and read there with the same packs. An agent reviewing
the branch gets the same result from the MCP server's `suss_check` with
`base: "origin/main"`. [`suss check`](/reference/cli/check#checking-a-pull-request)
says which findings count as part of the change.

## Put it on every pull request

The action runs those two extracts for you, one on the base commit and
one on the head, and posts the diff as a comment. When you push again, it
edits that same comment.

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
      - uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@v0.34.1
```

`@v0.34.1` pins the action to a release. A commit SHA in place of the
tag pins it to code you have read.

The action reads the packs from your `suss.json`, the file `suss init`
writes. If you do not have one, it picks the packs `init` would have
picked. Five inputs cover most projects:

- `extract` takes the arguments you would pass to `suss extract` after the
  command, so you can choose your own packs: `-p tsconfig.json -f hono -f
  prisma`.
- `working-directory` is the directory to run `suss extract` in, for a
  service kept in a subdirectory of the repository.
- `install` is a shell command that installs dependencies in the base
  checkout, such as `pnpm install --frozen-lockfile`. If you leave it
  empty, the base checkout shares the head checkout's `node_modules`, and
  that works as long as the pull request does not change dependencies.
- `findings` adds the findings the pull request introduced to the
  comment, after the diff, the way `check --base` reports them. It is
  `false` by default.
- `comment` is `true` by default. A pull request from a fork gets a
  read-only token, so the comment step fails there. You can still read the
  diff in the job log and in the run's artifact, so if you would rather
  not see that failure, turn the comment off for pull requests from forks:

```yaml
        with:
          comment: ${{ github.event.pull_request.head.repo.full_name == github.repository }}
```

The comment on the change above looks like this:

> ### 1 unit changes behavior in this pull request
>
> ```
> 1 boundary changed: 3 outcomes.
>
> ~ serves GET /users/{id}  src/routes/users.ts::get  (3 outcomes)
>   outcomes
>     + responds 200 { id, status }  when  findUser() && findUser().deletedAt
>     - responds 410 { error }  when  findUser() && findUser().deletedAt
>     ~ responds 200 { id, name, -email }  otherwise
>
> Changes by file
>
> src/routes/users.ts
>   ~ get
> ```
>
> <sub>Read by suss at 3f2a1c9. The summaries it compared are the `suss-diff` artifact of the run; `suss inspect after.json` on them says where suss could not follow a call.</sub>

[Run suss in CI](/guides/ci-integration) covers the rest of the inputs,
the second job that fails the build on a finding, and the caches that
stop a large repository being read twice on every run.
