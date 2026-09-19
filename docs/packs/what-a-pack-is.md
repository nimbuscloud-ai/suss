---
title: What a pack is
description: A pack is a data object that tells suss how one library is written, so the adapter can read a project's handlers, clients and effects through it.
---

# What a pack is

A pack is a data object that says how one library is written: where it registers handlers, what returning a response looks like, which calls reach a database. The language adapter reads your source through the packs a run loads, so teaching suss a new framework means adding data rather than changing the analyzer.

Take a Hono route:

```ts
// src/orders.ts
import { Hono } from "hono";

const app = new Hono();

app.post("/orders/:id/refund", async (c) => {
  const order = await loadOrder(c.req.param("id"));
  if (!order) {
    return c.json({ error: "no such order" }, 404);
  }
  if (order.refundedAt) {
    return c.text("already refunded", 409);
  }
  const refund = await refundOrder(order);
  return c.json(refund, 201);
});
```

Run the Hono pack over it:

```bash
suss extract --dir src -f hono -o summaries.json
suss inspect summaries.json
```

```
src/orders.ts
└─ POST /orders/{id}/refund  (hono handler | line 7)
       if  !loadOrder()
         -> 404 { error }
           + c.req.param
           + src/orders-store.loadOrder →
       elif  loadOrder().refundedAt
         -> 409 "already refunded"
           + c.req.param
           + src/orders-store.loadOrder →
       else
         -> 201 Refund (src/orders-store.ts)
           + c.req.param
           + src/orders-store.loadOrder →
           + src/orders-store.refundOrder →
```

The pack contributed three facts about Hono. Routes are registered as `app.post(path, handler)`, so the method comes from the registration and the path from its first argument. A handler responds by calling `c.json(body, status)` on its first parameter, and Hono sends 200 when the status is left off. The handler takes one parameter, the context.

Everything else in that output came from reading the code: the two guards, the calls into `orders-store`, the shape of what each branch returns.

## What a pack declares

The three facts above are the three required fields of a `PatternPack`. Here they are as [`@suss/framework-hono`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/framework/hono/src/index.ts) writes them, shortened to one verb and one response method:

```ts
export function honoFramework(): PatternPack {
  return {
    name: "hono",
    protocol: "http",
    languages: ["typescript", "javascript"],

    discovery: httpRouteDiscovery({
      importModule: "hono",
      importNames: ["Hono", "OpenAPIHono"],
      methods: [".get", ".post" /* ... */],
      mount: { method: "route", prefixPosition: 0, targetPosition: 1 },
    }),

    terminals: [
      {
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 0,
          methodChain: ["json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
    ],

    inputMapping: {
      type: "positionalParams",
      params: [{ position: 0, role: "context" }],
    },
  };
}
```

`discovery` finds the units. `terminals` says what producing an output looks like. `inputMapping` says how the unit's arguments arrive. `protocol` says which transport the boundary crosses, and `name` is what a summary records as the pack that recognized it. [Pack patterns](/packs/patterns) has every variant of each field.

A pack can also declare optional fields for things a library does that the three required ones do not cover: `contractReading` for a framework with declared response schemas, `invocationRecognizers` and `accessRecognizers` for calls that produce an effect, `subUnits` for callbacks the runtime schedules, `requiresImport` to skip files that never import the library.

Beside the pattern object, a pack exports a one-line description of itself:

```ts
export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-hono",
  dependencies: [{ ecosystem: "npm", name: "hono" }],
  reads: "Hono handlers, including the `c.json(body, status)` argument order.",
};
```

`suss init` reads `dependencies` to work out which packs a project needs, and the tables in the [pack catalog](/packs/catalog) are generated from `reads`.

## Kinds of pack

`kind` on the declaration puts a pack in one of three groups, and the catalog has a table per group.

**Framework packs** find the units a framework defines: a route handler, a React component, a GraphQL resolver, a queue consumer. Without a framework pack for your server, suss does not know your handlers exist.

**Client packs** find the other side, the call sites: `fetch`, axios, the Apollo hooks, Python's `requests`, Ruby's Net::HTTP. They bind a call to the method and path it sends, so the checker can pair it against whoever serves that route.

**Effects packs** fire on calls inside units another pack already found. `-f prisma` alone comes back empty; run beside `-f hono` it attaches a storage read to the query inside the handler. Because effects packs fire wherever the call is, they work across framework boundaries without any pack knowing about any other.

Contract readers are a fourth thing, and not a `PatternPack` at all. They read something the project declares rather than the code: `suss contract --from openapi orders.yaml` turns a spec into the same summaries the extractor writes. [Contract sources](/packs/contract-sources) lists all ten.

## Which packs a run uses

`suss init` reads a project's dependencies and says which packs match:

```bash
$ suss init
✓ Found 3 things to read in /projects/orders-api

  Your code
    hono             hono in dependencies
    fetch            TypeScript sources, and fetch reads what the language itself ships

  What your code reaches
    node             TypeScript sources, and node reads what the language itself ships
```

Run in a terminal it then offers to write `suss.json` at the project root. Piped or in CI it prints the commands instead, and `--plain` prints them either way.

```json
{
  "version": 1,
  "read": [
    {
      "kind": "extract",
      "language": "typescript",
      "packs": ["hono", "fetch", "node"]
    }
  ]
}
```

`suss extract` with no `-f` reads that file and says what it decided:

```
$ suss extract -o summaries.json
Reading what suss.json says.
  suss extract --lang typescript -f hono -f fetch -f node
Wrote 5 summaries to /projects/orders-api/summaries.json in 0.30s
```

`-f` overrides the file for one run, and it is repeatable: `suss extract -f hono -f prisma`. A `-f` name the CLI does not ship resolves as a package, so a pack you wrote yourself is `-f @acme/suss-pack-itty-router`. Commit `suss.json`, since which packs the project needs is the same for everybody working on it.

## What a pack can see

A pack states positions, and the adapter resolves what is at them. That resolution follows a value through a property read, an array element, an alias, an import and a barrel, so `app.get(USERS, handler)` finds `/users` and `` app.get(`${BASE}/items/:id`, handler) `` finds `/api/items/:id` when `BASE` is `"/api"`. A pack never reads the syntax tree to do it. `npm run check:readers` fails a pack that reaches for ts-morph, so `getInitializer`, `getSymbol` and `getLiteralValue` do not build.

What a pack cannot do is invent a value the code settles at run time. This handler passes the upstream response's status straight through:

```ts
app.post("/webhooks/inbound", async (c) => {
  const result = await forward(await c.req.json());
  return c.json(result.body, result.status);
});
```

The terminal matched, and the status did not resolve:

```
src/webhooks.ts
└─ POST /webhooks/inbound  (hono handler | line 7)
       -> result.status any
         + c.req.json
         + src/upstream.forward →
   
     Reaches:
       reads POST /inbound  through forward
       writes POST /inbound  through forward
```

`any` is the summary saying the status is whatever `forward` returns, and the `Reaches` block shows the outbound call the fetch pack found behind it. A field the pack could not read stays null; the crossing is still recorded. That matters on the other side of the boundary, because a consumer pairing against `result.status any` is told the provider did not commit to a code rather than being told nothing happened.

A pack also sees only one library. Hono's pack knows nothing about Prisma, and Prisma's knows nothing about Hono. What joins them is the run: every pack in the run fires on every unit any of them found.

## Next

- [Pack catalog](/packs/catalog), every pack that ships and what each one reads
- [Write a pack](/packs/write-a-pack), building one for a framework that has none
- [Pack patterns](/packs/patterns), every pattern variant and the code it matches
