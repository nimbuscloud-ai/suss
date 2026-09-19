---
title: Read a pull request
description: Diff the behavior of two commits instead of their lines, then put the same diff on every pull request as a comment.
---

# Read a pull request

`inspect --diff` takes the summary file from before a change and the one
from after, and reports what moved:

```bash
npx suss extract -o summaries/before.json   # on the base commit
npx suss extract -o summaries/after.json    # on the working tree
npx suss inspect --diff summaries/before.json summaries/after.json
```

```
1 boundary changed: 3 outcomes.

~ serves GET /users/{id}  src/routes/users.ts::getUser  (3 outcomes)
  outcomes
    + responds 200 { id, status }  when  findUser() && findUser().deletedAt
    - responds 410 { error }  when  findUser() && findUser().deletedAt
    ~ responds 200 { id, name, -email }  otherwise
```

A deleted account used to get a `410` and now gets a `200` with
`status: "deleted"`, and `email` left the response. The response is
still a valid `User`, the OpenAPI document still says `200 | 404 | 410`,
TypeScript is happy, and every caller that read a `200` as a usable
account is now wrong.

It reports which units changed behavior and how, whichever lines the
diff touched. A field that left one response branch is one line here and
one line in a thousand there.

## Put it on every pull request

The GitHub Action runs those two extracts for you, on the base and the
head, and posts the diff as one comment. A later push edits the same
comment.

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
> <sub>Read by suss at 3f2a1c9. The summaries it compared are the `suss-diff` artifact of the run.</sub>

The packs come from the project's `suss.json`, which `suss init` writes.
Without one the action picks the packs `init` would.

[Run suss in CI](/guides/ci-integration) covers every input the action
takes, the second job that fails the build on a finding, and what to do
about pull requests from forks.
