---
title: Quickstart
description: Work out which packs a project needs, read its source, and print what every route, query and queue does on each path.
---

# Quickstart

Three commands read a project and print what it does on every path.

```bash
npx @suss/cli init
npx suss extract -o summaries/code.json
npx suss inspect summaries/code.json
```

suss does not run your code, and you do not have to annotate anything
first. The output below comes from a small Hono API with a Prisma schema
behind it.

<!-- suss:example -->

`package.json`:

```json
{
  "name": "orders-api",
  "private": true,
  "type": "module",
  "dependencies": {
    "@prisma/client": "^5.0.0",
    "hono": "^4.0.0"
  }
}
```

`prisma/schema.prisma`:

<!-- suss:file prisma/schema.prisma -->

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Order {
  id        Int      @id @default(autoincrement())
  reference String   @unique
  total     Int
  placedAt  DateTime
}
```

`src/api.ts`:

```ts
import { PrismaClient } from "@prisma/client";
import { Hono } from "hono";

const app = new Hono();
const db = new PrismaClient();

app.get("/orders/:reference", async (c) => {
  const order = await db.order.findUnique({
    where: { reference: c.req.param("reference") },
    select: { id: true, reference: true, total: true },
  });

  if (!order) {
    return c.json({ error: "no such order" }, 404);
  }

  return c.json(order);
});

app.post("/orders", async (c) => {
  const body = await c.req.json();

  if (typeof body.total !== "number") {
    return c.json({ error: "total is required" }, 400);
  }

  const order = await db.order.create({
    data: {
      reference: body.reference,
      total: body.total,
      placedAt: new Date(),
    },
  });

  return c.json({ reference: order.reference }, 201);
});

export default app;
```

## Work out which packs the project needs

```bash
npx @suss/cli init
```

suss reads code through one pack per library. `init` looks at your
dependency manifest and at the schemas and deploy templates on disk, then
lists what it can read:

<!-- suss:excerpt -->

```
  Your code
    hono             hono in dependencies
    fetch            TypeScript sources, and fetch reads what the language itself ships

  What your code reaches
    prisma           @prisma/client in dependencies
    node             TypeScript sources, and node reads what the language itself ships

  Declared contracts
    prisma           a Prisma schema at prisma/schema.prisma
```

Then it prints the commands for what it found. If you are sitting at a
terminal, it offers to set them up for you. If the output is piped
somewhere or the run is in CI, it prints the commands and stops.

<!-- suss:excerpt -->

```
   suss extract -f hono -f fetch -f prisma -f node -o summaries/code.json
   suss contract --from prisma prisma/schema.prisma -o summaries/prisma.json
```

## Read the code

```bash
npx suss extract -f hono -f fetch -f prisma -f node -o summaries/code.json
```

```
Wrote 2 summaries to summaries/code.json in 0.24s
```

Each summary describes one unit of code that suss read. Here each unit is
a route handler. In another project it might be a queue consumer or a
Lambda. The
file is JSON, and `inspect` prints it in a form you can read.

Those `-f` flags are the ones `init` printed. If you leave them off,
`extract` reads the packs from `suss.json`, and when there is no such file
it picks the same ones `init` would have.

## Print what it found

```bash
npx suss inspect summaries/code.json
```

```
src/api.ts
├─ GET /orders/{reference}  (hono handler | line 7)
│      if  !db.order.findUnique()
│        -> 404 { error }
│          + c.req.param
│          + db.order.findUnique
│      else
│        -> 200 order
│          + c.req.param
│          + db.order.findUnique
│
└─ POST /orders  (hono handler | line 20)
       if  typeof body.total !== "number"
         -> 400 { error }
           + c.req.json
       else
         -> 201 { reference }
           + c.req.json
           + db.order.create

2 summaries.
```

Under each route you get the branches it takes, the condition that leads
to each one, and the status and body it returns there. The `+` lines are
the calls that branch makes. `POST /orders` only writes to Prisma on the
branch that returns 201.

## Compare it against the schema

`check` needs both sides of a boundary in the same folder. `init` already
printed the command that turns `schema.prisma` into the other side of
every Prisma query, and this project has a caller of its own too.

`src/client.ts`:

```ts
export async function loadOrder(reference: string) {
  const response = await fetch(`/orders/${reference}`);

  if (response.status === 200) {
    return { state: "ready", order: await response.json() };
  }

  return { state: "error" };
}
```

```bash
npx suss extract -f hono -f fetch -f prisma -f node -o summaries/code.json
npx suss contract --from prisma prisma/schema.prisma -o summaries/prisma.json
npx suss check --dir summaries/ --all
```

```
Compared 1 boundary:
  GET /orders/{reference}
    orders-api::src/api.ts::get <-> orders-api::src/client.ts::loadOrder

Providers with no client to compare against:
  POST /orders
    orders-api::src/api.ts::post

Nothing in this run paired with this boundary, so nothing was checked across it:
  postgresql:Order
    prisma/schema.prisma::Order

────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/api.ts::get (src/api.ts:7)
  consumer: src/client.ts::loadOrder (src/client.ts:1)
  boundary: hono (http) GET /orders/:reference
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /orders/{reference}"
      provider: { transitionId: "get:response:404:ca40ca7" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
1 finding: 0 error, 1 warning, 0 info
```

One boundary had both sides in this run. Across it, `loadOrder` treats
every status other than 200 the same way, so a missing order and a failed
request both end up on the screen as one generic error. The two entries
above the finding had only one side here, and suss compared nothing for
them. An empty finding list on its own does not mean the two sides
agreed.

Every finding gives you the boundary, both sides, a file and line to
open, and a rule you can paste if you decide to live with it. The
[findings catalog](/reference/findings) explains what each kind means.

## Next

- [Add suss to a project](/guides/add-to-project) for a repository with
  more than one service, or a language other than TypeScript.
- [Fix a run that found nothing](/guides/fix-an-empty-run) if `init` did
  not match a pack, or `extract` came back empty.
- [Read a pull request](/start/read-a-pull-request) diffs two of these
  runs and posts what changed as a comment.
- [Give your agent suss](/start/give-your-agent-suss) lets a coding agent
  ask the same questions over MCP.
- [Four ideas](/start/four-ideas) explains the four words the rest of the
  documentation leans on.
