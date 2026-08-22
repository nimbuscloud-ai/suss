# Get started

Point suss at the project you already have. `init` works out which
packs your stack needs, `extract` reads your source, and `check`
compares the sides that meet. Nothing runs, and nothing has to be
annotated first.

If your first run turns up nothing to compare, the
[worked example](#an-example-with-a-finding-in-it) at the bottom of
this page builds two files that disagree, so you have a finding in
front of you while you work out what your own project needs.

## Work out which packs you need

```bash
npx @suss/cli init --plain
```

`init` reads your `package.json`, looks for schemas and deploy
templates on disk, and prints the commands for what it found. Without
`--plain` it asks before it installs anything.

Here it is on
[gothinkster/node-express-realworld-example-app](https://github.com/gothinkster/node-express-realworld-example-app),
an Express and Prisma API of about fifty units:

```
✓ Found 4 things to read in node-express-realworld-example-app

  Your code
    express          express in dependencies
    axios            axios in dependencies

  What your code reaches
    prisma           @prisma/client in dependencies

  Declared contracts
    prisma           a Prisma schema at src/prisma/schema.prisma

1. Install the packs

   npm install --save-dev @suss/cli @suss/framework-prisma @suss/client-axios @suss/framework-express @suss/contract-prisma

2. Read each side into one folder

   suss extract -f express -f axios -f prisma -o summaries/code.json
   suss contract --from prisma src/prisma/schema.prisma -o summaries/prisma.json

3. Compare them

   suss check --dir summaries/
```

One pack per library. `framework-express` for the routes,
`client-axios` for the outbound calls, `framework-prisma` for the
queries, and `contract-prisma` to turn `schema.prisma` into the other
side of those queries.

## Read the code

```bash
npm install --save-dev @suss/cli @suss/framework-express \
  @suss/client-axios @suss/framework-prisma @suss/contract-prisma

npx suss extract -p tsconfig.app.json -f express -f axios -f prisma -o summaries/code.json
npx suss contract --from prisma src/prisma/schema.prisma -o summaries/prisma.json
```

```
Wrote 46 summaries to summaries/code.json in 0.94s
Wrote 4 summaries to summaries/prisma.json
```

A summary is what suss worked out about one unit: which branches it
takes, under what conditions, what each one produces, and what it
touched on the way. `suss inspect summaries/code.json` prints them.

`-p` picks the tsconfig covering the code you want read. Leave it off
and suss takes the nearest one, which is right for most projects. This
repo needs it, because its root `tsconfig.json` lists no files of its
own and points at two project references instead, so the tsconfig that
covers `src/` is `tsconfig.app.json`.

## Compare the sides that meet

```bash
npx suss check --dir summaries/
```

```
Compared 4 boundaries.

  20 provider-side boundaries have no client to compare against.
  5 boundaries had nothing to pair with, so nothing was checked across them.
  Run the same command with --all to list them.

3 findings: 0 error, 3 warning, 0 info

Not shown: 3 boundaryFieldUnused (warning). Run the same command with --all to see them.

suss met a call it could not follow in 19 units, of 50, so those are described in part. `suss inspect` says which calls.
```

The four boundaries compared are the four Prisma models, each against
every query that reads or writes it. The twenty HTTP routes went
uncompared because the front end for this API lives in a separate
repository, so the other side of those routes was never extracted.
[Add suss to a project](/guides/add-to-project) covers what to do about
that.

`--all` prints the findings in full:

```
[WARNING] boundaryFieldUnused
  Tag declares "id", and no query here asks for it or writes it. A field the code takes off a record a query returned never counts as a read here, so look for one before treating the field as dead.
  provider: src/prisma/schema.prisma::Tag (src/prisma/schema.prisma:1)
  consumer: src/prisma/schema.prisma::Tag (src/prisma/schema.prisma:1)
  boundary: prisma (postgresql)
```

Every finding gives you the boundary, both sides, and a file and line
to open. There is no aggregate score. See the
[findings catalog](/reference/findings) for what each kind means.

## Ask it something

The same summaries answer questions about your code without you
reading it:

```bash
npx suss ask 'what writes postgresql:Article' --dir summaries/
```

```
6 units write postgresql:Article:
  @api/source::src/app/routes/article/article.service.ts::createArticle (src/app/routes/article/article.service.ts:162) through prisma.article.create
  @api/source::src/app/routes/article/article.service.ts::updateArticle (src/app/routes/article/article.service.ts:289) through prisma.article.update
  @api/source::src/app/routes/article/article.service.ts::deleteArticle (src/app/routes/article/article.service.ts:385) through prisma.article.delete
  @api/source::src/app/routes/article/article.service.ts::favoriteArticle (src/app/routes/article/article.service.ts:562) through prisma.article.update
  @api/source::src/app/routes/article/article.service.ts::unfavoriteArticle (src/app/routes/article/article.service.ts:608) through prisma.article.update
  @api/source::src/app/routes/article/article.service.ts::disconnectArticlesTags (src/app/routes/article/article.service.ts:276) through prisma.article.update

postgresql:Article is provided by src/prisma/schema.prisma::Article.

suss met a call it could not follow in 19 units, of 50, so a reader could be hiding in one of them.
```

That last line matters as much as the list. Six writers are the six
suss could follow, and it says outright that there might be another one
inside a call it could not. [`ask`](/reference/cli#ask) takes the other
question forms too: what an endpoint reaches, why it reaches it, and
who calls a given function.

## An example with a finding in it

Two files, one endpoint and its caller, that disagree about a status
code. Useful when your own first run had nothing to compare, or when
you want to see what a cross-boundary finding looks like before you go
hunting for one.

### Set up a workspace

```bash
mkdir suss-example && cd suss-example
npm init -y
npm pkg set type=module

npm install hono
npm install --save-dev @suss/cli @suss/framework-hono @suss/client-web typescript
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

### Write the two sides

`src/api.ts`, an endpoint with two outcomes, 404 when there is no such
user and 200 with the user otherwise:

```ts
import { Hono } from "hono";

const app = new Hono();

app.get("/users/:id", async (c) => {
  const user = await findUser(c.req.param("id"));

  if (!user) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json({ id: user.id, name: user.name });
});

declare function findUser(
  id: string,
): Promise<{ id: string; name: string } | null>;

export default app;
```

`src/client.ts`, a caller that checks for 200 and treats everything
else the same way:

```ts
export async function loadUser(id: string) {
  const response = await fetch(`/users/${id}`);

  if (response.status === 200) {
    const user = await response.json();
    return { state: "ready", name: user.name };
  }

  return { state: "error" };
}
```

### Read both sides

```bash
npx suss extract -f hono -o summaries/api.json
npx suss extract -f fetch -o summaries/web.json
npx suss inspect summaries/api.json
```

```
src/api.ts
└─ GET /users/{id}  (hono handler | line 5)
       if  !findUser()
         -> 404 { error }
       else
         -> 200 { id, name }
           + findUser

     Reaches:
       invocation findUser

     Could not follow:
       The call to findUser lands on a declaration with no body, so whatever runs there is missing from this summary

1 summary.
```

That is the endpoint's behaviour rather than its types: which condition
leads to which status, and what the body contains in each case. And
`c.json(body, status)` was read correctly without anyone telling suss
which argument is which. `findUser` is declared and never defined here,
so suss says it could not follow the call rather than reporting the
handler as fully read.

### Compare them

```bash
npx suss check --dir summaries/ --fail-on warning
```

An uncovered status is a warning, because whether the fall-through is
the intended handling is your call to make, and a default run only
fails on errors. `--fail-on warning` fails on them too, which is what
this example wants: the disagreement is the point.

```
Compared 1 boundary.

────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/client.ts::loadUser (src/client.ts:1)
  boundary: hono (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:404:afd032b" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
1 finding: 0 error, 1 warning, 0 info

suss met a call it could not follow in one unit, of 2, so that one is described in part. `suss inspect` says which calls.
```

The endpoint separates "no such user" from every other failure. The
caller does not, so a missing user and a database outage both reach the
screen as `{ state: "error" }`. Both files typecheck, so nothing else
was going to tell you.

The last lines are a rule you can paste, for when you decide to live
with a finding. It matches this finding and no other. See
[Suppress a finding](/guides/suppress-findings).

Give the caller its own branch:

```ts
export async function loadUser(id: string) {
  const response = await fetch(`/users/${id}`);

  if (response.status === 404) {
    return { state: "missing" };
  }

  if (response.status === 200) {
    const user = await response.json();
    return { state: "ready", name: user.name };
  }

  return { state: "error" };
}
```

```bash
npx suss extract -f fetch -o summaries/web.json
npx suss check --dir summaries/ --fail-on warning
```

```
Compared 1 boundary.

No findings. Every compared boundary agreed.

suss met a call it could not follow in one unit, of 2, so that one is described in part. `suss inspect` says which calls.
```

### Change the endpoint and watch it break

A deleted user should look different from a missing one, so add a case
for them:

```ts
  if (user.deletedAt) {
    return c.json({ error: "gone" }, 410);
  }
```

with `findUser` now returning `deletedAt: string | null`. Read the
endpoint again and compare:

```bash
npx suss extract -f hono -o summaries/api.json
npx suss check --dir summaries/ --fail-on warning
```

```
────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider produces status 410 but no consumer branch handles it
  provider: src/api.ts::get (src/api.ts:5)
  consumer: src/client.ts::loadUser (src/client.ts:1)
  boundary: hono (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:410:3b915da" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
1 finding: 0 error, 1 warning, 0 info

suss met a call it could not follow in one unit, of 2, so that one is described in part. `suss inspect` says which calls.
```

Nobody touched the caller, and the caller is now wrong. With
`--fail-on warning` the run exits non-zero, so this fails on the pull
request that adds the 410 rather than in a bug report a week later.

## Next

- [Add suss to a project](/guides/add-to-project), including what to do
  when a first run turns up nothing
- [Set up CI checking](/guides/ci-integration)
- [Compatibility](/reference/compatibility), for languages, module
  systems, and where suss stops
- [Findings catalog](/reference/findings), for every finding kind
