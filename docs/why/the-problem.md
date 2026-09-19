---
title: The problem
description: Code arrives faster than anyone can read it, and a change that passes review, the type checker and the tests can still break a caller.
---

# The problem

Code arrives faster than anyone can read it. A team shipping with a coding agent merges pull requests of a thousand lines several times a day.

The two things a reviewer falls back on do not close that gap. The diff tells you what the text changed, not what the service now does: a field dropped from one response object is one line out of a thousand. Tests share their author's assumptions, so when the model that wrote the change also wrote the tests, they check that the change does what the model meant.

What the reviewer needs is a description of what the change does that did not come from whoever wrote it. suss reads the source and produces that description. It runs the same way every time, and there is no model in it.

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

Both files compile, and they will keep compiling however many branches the route grows. `response.data` is `any`, both replies are valid JSON, and no test covers a pending order. The link comes back `undefined` for every pending order.

## What suss says about it

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

That description came out of the source rather than out of the pull request, and it says where suss fell short too: `db.findOrder` is declared here with no body, so part of the route went unread. Two 200s leave the route with different bodies, and one branch in the caller receives both. `suss check` reports that:

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

Two more warnings come out of the same run, about the two 200s being told apart by `status` that the caller never reads.

## Beyond a route

A route is one kind of boundary. suss reads the same description off a queue consumer or a table a query selects from, and compares it against whatever is on the other side: the deploy template that wires the queue, or the schema that declares the table. [Cross-boundary checking](/why/cross-boundary-checking) is how the comparison works.

## Where suss stops

- TypeScript is the furthest along. Python and Ruby read routes and fewer ORMs. See [Read Python or Ruby](/guides/python-and-ruby).
- One run reads one repository. Checking across two repositories means publishing one side's summaries and handing them to the other's run; see [Work across services](/guides/work-across-services). Tracking a boundary over time and alerting on a regression are left to whatever consumes the summaries.
- suss describes what the code does and does not decide whether that is correct. A handler that returns 200 on every path when it should return 404 produces a summary its caller agrees with. Intent documents your team writes are the way to state what should happen; see [Check against your intent](/guides/check-against-intent).
- Some code is too dynamic to read statically. suss marks a condition it could not take apart as opaque and says which calls it could not follow, rather than leaving the gap out of the output.

[Compared to other tools](/why/compared) goes through what your type checker, linter, specs and contract tests each see, and what suss adds.
