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

Your code never runs and nothing has to be annotated first. The output
below comes from a small Hono API with a Prisma schema behind it.

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

suss reads code through a pack per library. `init` looks at the
dependency manifest and at the schemas and deploy templates on disk, and
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

Then it prints the commands for what it found. In a terminal it offers to
set them up for you; piped or in CI it prints and stops.

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

A summary is one unit suss read: a route handler here, a queue consumer or
a Lambda in another project. The file is JSON, and `inspect` prints it in
a form meant for people.

Those `-f` flags are the ones `init` printed. Leave them off and `extract`
reads the packs from `suss.json`, or picks the same ones `init` would when
there is no file.

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

Each route comes with the branches it takes, the condition that leads to
each one, and the status and body that branch returns. The `+` lines are
the calls that path makes, so `POST /orders` writes to Prisma on its 201
and not on its 400.

## Next

- [Add suss to a project](/guides/add-to-project) for a repository with
  more than one service, or a language other than TypeScript.
- [Fix a run that found nothing](/guides/fix-an-empty-run) if `init` did
  not match a pack, or `extract` came back empty.
- [Read a pull request](/start/read-a-pull-request) diffs two of these
  runs and posts what changed as a comment.
- [Give your agent suss](/start/give-your-agent-suss) lets a coding agent
  ask the same questions over MCP.
- [Four ideas](/start/four-ideas) is the vocabulary the rest of the
  documentation uses.
