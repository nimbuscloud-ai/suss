---
title: The problem
description: Code arrives faster than anyone can read it, and a change that passes review, the type checker and the tests can still break a caller.
---

# The problem

Code arrives faster than anyone can read it. Once a team is working with coding agents, the pull requests get bigger and they arrive more often.

A reviewer falls back on the diff and on the tests, and neither one closes that gap. A diff shows you which lines of text changed, and you still have to work out what the service does now. A field dropped from one response object looks like a single edited line among all the rest. A test only checks what its author thought to check, so when the model that wrote the change also wrote the tests, all they confirm is that the change does what the model meant.

The reviewer needs a description of what the change does that did not come from whoever wrote it. suss reads the source and writes that description. It runs the same way every time and there is no model in it.

## A change that breaks a caller

This Express route grew a branch. While a payment is pending, the response leaves `receiptUrl` out.

```ts
// src/routes.ts
router.get("/orders/:id", async (req, res) => {
  const order = await db.findOrder(req.params.id);

  if (order.status === "pending") {
    res.json({ id: order.id, status: order.status });
    return;
  }

  res.json({ id: order.id, status: order.status, receiptUrl: order.receipt });
});
```

The caller reads `receiptUrl` off every 200:

```ts
// src/receiptLink.ts
export async function receiptLink(id: string) {
  const response = await client.get(`/orders/${id}`);

  if (response.status === 200) {
    return response.data.receiptUrl;
  }

  throw new Error("could not load the order");
}
```

Both files compile, and they will keep compiling however many branches the route grows. `response.data` is `any`, both replies are valid JSON, and no test covers a pending order. So `receiptLink` returns `undefined` for every pending order.

## What suss reports about it

Read both files, then print what suss found:

```bash
suss extract -f express -f axios -o summaries/all.json
suss inspect summaries/all.json
```

```
src/routes.ts
└─ GET /orders/{id}  (express handler | line 5)
       if  db.findOrder().status === "pending"
         -> 200 { id, status }
           + db.findOrder
       else
         -> 200 { id, status, receiptUrl }
           + db.findOrder

     Could not follow:
       The call to db.findOrder lands on a declaration with no body, so whatever runs there is missing from this summary

src/receiptLink.ts
└─ GET /orders/{id}  (axios client | line 5)
       if  client.get().status === 200
         -> return
           + client.get
       else
         -> throw Error
           + client.get

2 summaries.
```

suss worked that description out from the source, and it also reports where it fell short: `db.findOrder` is declared here with no body, so part of the route went unread. The route returns 200 with two different bodies, and the caller handles both of them in one branch. `suss check` reports that:

```bash
suss check --dir summaries/ --all
```

```
[WARNING] unhandledProviderCase
  Provider transition get:response:200:667e122 for status 200 has body field receiptUrl that other transitions lack, but no consumer branch tests for this field
  provider: src/routes.ts::get (src/routes.ts:5)
  consumer: src/receiptLink.ts::receiptLink (src/receiptLink.ts:5)
  boundary: express (http) GET /orders/:id
```

The same run produces two more warnings. Those are about `status`, the field that tells the two 200s apart, which the caller never reads.

## Beyond a route

A route is one kind of boundary. suss reads the same sort of description from a queue consumer or from a table a query selects from, then compares it against whatever is on the other side, such as the deploy template that wires up the queue or the schema that declares the table. [Cross-boundary checking](/why/cross-boundary-checking) explains how that comparison works.

## Where suss stops

- TypeScript is the furthest along. In Python and Ruby, suss reads routes and a smaller set of ORMs. See [Read Python or Ruby](/guides/python-and-ruby).
- One run reads one repository. To check across two repositories, you publish one side's summaries and hand them to the other side's run; see [Work across services](/guides/work-across-services). Tracking a boundary over time and alerting on a regression are up to whatever you build on top of the summaries.
- suss describes what the code does, and it does not decide whether that is correct. If a handler returns 200 on every path where it should return 404, suss produces a summary that its caller agrees with. To state what should happen, your team writes an intent document; see [Check against your intent](/guides/check-against-intent).
- Some code is too dynamic to read statically. suss marks a condition it could not take apart as opaque, and it lists the calls it could not follow, so the gap shows up in the output.

[Compared to other tools](/why/compared) goes through what your type checker, linter, specs and contract tests each see, and what suss adds.
