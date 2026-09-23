---
title: Four ideas
description: "Boundary, summary, check and pack: the four words the rest of the documentation is written in."
---

# Four ideas

Almost everything suss does comes down to four words.

## Boundary

A boundary is where two units of code meet and neither one can see the
other. A route and the client that calls it are a boundary, and so are a
query and the table it reads. suss records every boundary in the same
format. `check` prints the two sides it paired on each one:

```
Compared 1 boundary:
  GET /orders/{reference}
    orders-api::src/api.ts::get <-> orders-api::src/client.ts::loadOrder
```

## Summary

A summary is what suss worked out about one unit of code. It records the
branches the code takes and the condition that picks each one, what each
branch produces, and everything the code touched along the way.
`inspect` prints one summary per unit:

```
└─ POST /orders  (hono handler | line 20)
       if  typeof body.total !== "number"
         -> 400 { error }
           + c.req.json
       else
         -> 201 { reference }
           + c.req.json
           + db.order.create
```

## Check

A check compares the summaries on either side of one boundary and reports
where the two disagree. Every finding gives you the boundary, both sides
of it, and a file and line to open:

```
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/api.ts::get (src/api.ts:7)
  consumer: src/client.ts::loadOrder (src/client.ts:1)
  boundary: hono (http) GET /orders/:reference
```

## Pack

A pack describes one library to suss. It lists which calls in that
library create a route and which run a query, and what each of those
calls does. You pick the packs for a run with `-f`, and `suss init`
works out which ones your project needs:

```bash
suss extract -f hono -f prisma -o summaries/code.json
```

The [pack catalog](/packs/catalog) lists everything that ships inside
`@suss/cli`. If your library is missing from that list, [Write a
pack](/packs/write-a-pack) walks you through adding it.

## Where next

- **Running it for the first time:** [Quickstart](/start/quickstart).
- **Adopting it one step at a time:** [Adopt it step by step](/guides/adopting-suss), then [Run suss in CI](/guides/ci-integration).
- **Looking something up:** [CLI reference](/reference/cli/) · [Findings catalog](/reference/findings) · [Glossary](/reference/glossary) · [FAQ](/reference/faq).
- **Python or Ruby:** [Read Python or Ruby](/guides/python-and-ruby).
- **Consuming the output:** [Summary format](/reference/summary-format), then [IR types](/reference/ir).

The [Glossary](/reference/glossary) has the rest of the vocabulary:
transition, predicate, subject, effect, gap.
