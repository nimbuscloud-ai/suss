---
title: Read a pull request
description: Diff the behavior of two commits instead of their lines, then put the same diff on every pull request as a comment.
---

# Read a pull request

`inspect --diff` reads the summaries from before a change and the ones
from after, and prints the boundaries whose behavior moved.

<!-- suss:example -->

Here is `src/routes/users.ts` on the base commit. It has one route with
three outcomes:

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
npx suss extract -f hono -o summaries/before.json
```

The pull request rewrites two of those returns. A deleted account now
gets a `200` with a status field in it where it used to get a `410`, and
`email` comes off the success body:

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
npx suss extract -f hono -o summaries/after.json
npx suss inspect --diff summaries/before.json summaries/after.json
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
      - uses: nimbuscloud-ai/suss/.github/actions/inspect-diff@main
```

The action reads the packs from your `suss.json`, the file `suss init`
writes. If you do not have one, it picks the packs `init` would have
picked. Four inputs cover most projects:

- `extract` takes the arguments you would pass to `suss extract` after the
  command, so you can choose your own packs: `-p tsconfig.json -f hono -f
  prisma`.
- `working-directory` is the directory to run `suss extract` in, for a
  service kept in a subdirectory of the repository.
- `install` is a shell command that installs dependencies in the base
  checkout, such as `pnpm install --frozen-lockfile`. If you leave it
  empty, the base checkout shares the head checkout's `node_modules`, and
  that works as long as the pull request does not change dependencies.
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
