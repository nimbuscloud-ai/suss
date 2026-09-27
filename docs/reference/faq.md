---
title: FAQ
description: The questions that come up in the first week of running suss.
---

# FAQ

## What is suss, in one sentence?

suss works out every path through every function in your code, pairs those descriptions across the places where two units meet, and reports where the two sides disagree.

A place where two units meet is an HTTP call, a GraphQL field, a queue, a database table, an environment variable, or a function call across a package boundary.

## What does it look like when it finds something?

A route returns an order as the database has it, and the panel that draws the order reads a field the route never sends.

```ts
// src/api.ts
app.get("/orders/:id", (req, res) => {
  const order = orders[req.params.id];
  if (!order) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(200).json(order);   // { id, customer, total }
});

// src/orderPanel.ts
export function loadOrder(id: string) {
  return fetch(`/orders/${id}`)
    .then((res) => res.json())
    .then((data) => data.customerName);
}
```

```bash
suss extract -f express -f fetch -o summaries/code.json
suss check --dir summaries/
```

```
[ERROR] misreadProviderResponse
  The consumer's fall-through path reads "customerName", but the 200 body the provider sends does not include it, and neither does any other response.
  provider: src/api.ts::get (src/api.ts:13)
  consumer: src/orderPanel.ts::loadOrder (src/orderPanel.ts:1)
  boundary: express (http) GET /orders/:id
```

Both files typecheck. Nobody wrote a shared type between them, and `customerName` comes back undefined at runtime with no error to say so.

## How is this different from TypeScript types or a generated client?

A shared type or a generated client catches a wrong shape: a missing field, or a field of the wrong type. It works when both sides are TypeScript and the spec the client was generated from matches the handler. It does not say which branch of the handler returns which status and body. It does not reach a caller written in Python or Ruby, and it trusts a spec even when the handler behind it does something else.

suss reads the branches on both sides, in whichever language each side is written, and compares a spec with the handler as well as with the client. Here the type is the same on two branches and the behavior is not.

<!-- suss:example -->

`src/contract.ts`, the type both sides share:

```ts
import { initContract } from "@ts-rest/core";

const c = initContract();

export const contract = c.router({
  getAccount: {
    method: "GET",
    path: "/accounts/:id",
    responses: {
      200: c.type<{ id: string; plan: string; closed: boolean }>(),
      404: c.type<{ error: string }>(),
    },
  },
});
```

`src/handler.ts`, which also returns a 200 for a closed account:

```ts
import { initServer } from "@ts-rest/express";
import { contract } from "./contract";

declare function findAccount(
  id: string,
): Promise<{ id: string; plan: string; closedAt: Date | null } | null>;

const s = initServer();

export const router = s.router(contract, {
  getAccount: async ({ params }) => {
    const account = await findAccount(params.id);

    if (!account) {
      return { status: 404 as const, body: { error: "not found" } };
    }

    if (account.closedAt) {
      return {
        status: 200 as const,
        body: { id: account.id, plan: "none", closed: true },
      };
    }

    return {
      status: 200 as const,
      body: { id: account.id, plan: account.plan, closed: false },
    };
  },
});
```

`src/billingPanel.ts`, a client that shows the plan on every response except a 404:

```ts
export async function loadPlan(id: string) {
  const response = await fetch(`/accounts/${id}`);

  if (response.status === 404) {
    return { plan: null };
  }

  const account = await response.json();
  return { plan: account.plan };
}
```

```bash
suss extract --dir . -f ts-rest -f fetch -o summaries/all.json
suss check --dir summaries/
```

<!-- suss:excerpt -->

```
[WARNING] unhandledProviderCase
  Provider returns status 200 in 2 different situations, and the consumer treats them all the same
  provider: src/handler.ts::getAccount (src/handler.ts:11)
  consumer: src/billingPanel.ts::loadPlan (src/billingPanel.ts:1)
  boundary: ts-rest (http) GET /accounts/:id
```

Both 200 branches match `{ id: string; plan: string; closed: boolean }`, so the compiler has nothing to say. The panel shows `"none"` as the plan of a closed account, because it never reads `closed`.

<!-- suss:unchecked the rest of this page shows output from projects it does not build -->

## How do I run it for the first time?

Run `suss init` in your project. It reads your dependencies, works out which packs your stack needs, and prints or runs the commands.

[Quickstart](/start/quickstart) walks through the first run end to end.

## Do I need to install anything besides the CLI?

No. Every pack ships inside `@suss/cli`, so `npx @suss/cli init` is the whole installation.

You do need your project's own dependencies installed, because some packs resolve types through them. [Compatibility](/reference/compatibility#dependencies) says which.

## Does it require annotations or changes to my code?

No. suss reads your source exactly as it is, without decorators or JSDoc tags.

It needs two things from you: your `tsconfig.json`, so type resolution matches what your compiler sees, and the packs for your stack.

## What is a "boundary"?

Any place where two units of code meet across a contract: an HTTP request from a client to a handler, a function exported from one package and called from another, a query against a database schema, a message on a queue, a React parent rendering a child.

The contract can be implicit, such as a function signature, or written down, such as an OpenAPI document or a Prisma schema. Every boundary has a provider side that produces the value and a consumer side that acts on it, even when both are in one process. `suss check --all` opens by printing what it paired at each one:

```
Compared 2 boundaries:
  GET /orders/{id}
    proj::src/api.ts::get <-> proj::src/client.ts::loadOrder
    openapi:openapi.yaml::GET /orders/{id} <-> proj::src/client.ts::loadOrder
    proj::src/api.ts::get <-> openapi:openapi.yaml::GET /orders/{id}
  POST /orders
    proj::src/api.ts::post <-> openapi:openapi.yaml::POST /orders
```

## What boundaries are modelled?

HTTP, GraphQL, storage, message buses, runtime configuration, deployed-unit invocation, metrics, and in-process function calls across a package export.

Which libraries suss reads at each of those comes from the packs, and [Pack catalog](/packs/catalog) is the list. Adding a boundary means adding a pack, and nothing around it changes.

## What does "behavioral drift" mean?

Two pieces of code, or one piece of code and one written contract, that used to agree about what crosses a boundary and now do not.

The agreement was about behavior, so the types may not have changed at all:

- A handler used to return `404` for soft-deleted users and now returns `200 { status: "deleted" }`. The caller still takes `200` to mean the user exists.
- A Prisma write used to set `email` and the schema dropped the column. The field is still in the input type, so the type checker says nothing and only the database refuses it.
- A queue producer used to send `{ userId: string }` and the consumer parses `userId` as a number. Both compile and run, and the wrong value gets stored.

## What languages does it support?

suss reads TypeScript and JavaScript through ts-morph, and Python and Ruby through tree-sitter compiled to WASM.

Neither Python nor Ruby needs an installed interpreter. `suss extract --lang python` and `--lang ruby` pick those adapters, and a directory with a `pyproject.toml` or a `Gemfile.lock` in it is recognized without the flag. Over this repository's own `fixtures/python-webapp`, `suss extract --dir fixtures/python-webapp -f fastapi -f flask-restx` writes 14 summaries, 8 of them routes with a path. Here are two of them, with the rest cut:

```
myapp/fastapi_app.py
├─ GET /items/{item_id}  (fastapi handler | line 26 | confidence: low)
│      -> 200 TodoResponse
│
└─ POST /items  (fastapi handler | line 31 | confidence: low)
       -> 201 TodoResponse
```

The IR and the checker never see which language a summary came from. Both read `BehavioralSummary[]` JSON, so a Python service and a TypeScript client compare against each other in one `check` run. [Read Python or Ruby](/guides/python-and-ruby) lists what each adapter reads and where it stops.

## Does it work in monorepos?

Yes. Run `suss extract` once per package with that package's `tsconfig.json`, then `suss check --dir` pairs across the files. When two services serve the same route, a client outside both of them is compared with neither, so check that client against one service per run. [Compatibility](/reference/compatibility#where-it-stops) has the detail.

The contract commands are independent of the source repo, so a spec that lives somewhere else still pairs. [Work across services](/guides/work-across-services) has the commands.

## What if a run runs out of memory?

suss runs with a heap limit of up to 8 GB, about twice the peak of the largest project it has been measured on. If a run still stops with "JavaScript heap out of memory", give it more with `NODE_OPTIONS=--max-old-space-size=12288`. suss uses a size set there as it is. [Memory](/reference/cli/#memory) says how it picks the limit.

## Why did my run find nothing?

Almost always because the pack list does not match the stack, or because a pack needs a dependency that is not installed.

The run reports where it stopped, file by file and pack by pack. [Fix a run that found nothing](/guides/fix-an-empty-run) goes through that output case by case.

## Does it produce false positives?

Sometimes, and the output marks the places where it was unsure.

Three things show up in a summary. A branch condition suss could not resolve becomes an `opaque` predicate with the source text kept. A value whose origin it could not trace becomes an `unresolved` subject, and stays in the summary. And every summary has a `confidence` block. On top of those, each `check` run ends with a line saying how much of the code it could not follow:

```
suss met a call it could not follow in one unit, of 6, so that one is described in part. `suss inspect` says which calls.
```

You will get outright false positives sometimes, findings about something the code does not do. Usually the cause is a wrapper you wrote that the pack has no pattern for. Add that pattern to the pack and the finding goes away.

## How do I silence a finding I have accepted?

Put a rule in `.sussignore`. Every finding prints the rule that would silence it, so you can copy the block out of the output.

A rule can mark a finding (still shown, dropped from the exit code), downgrade it one severity, or hide it. [Accept a finding](/guides/accept-a-finding) has the format.

## Will it fail my build?

It can. `suss check` exits non-zero when it reports any `error`-severity finding, and `--fail-on warning` or `--fail-on info` moves the gate.

[Exit codes](/reference/cli/exit-codes) lists every code, and [Run it in CI](/guides/ci-integration) has a workflow to copy.

## What is the difference between `suss extract` and `suss contract`?

One reads code and one reads a document. `extract` derives summaries from the implementation, and `contract` reads a written artifact and emits summaries in the same form.

Both feed `suss check`, which pairs them. Sometimes `contract` turns up behavior no handler in your code produces. Reading `fixtures/aws-lambda/template.yaml` gives 29 summaries, six of them routes. Here is one route, with the other 28 cut:

```
cloudformation:fixtures/aws-lambda/template.yaml:ListWidgetsFunction:List
└─ GET /widgets  (apigateway handler | line 0)
     Contract:
       if  aws:apigateway:status-504
         -> 504  !! undeclared
       elif  aws:apigateway:status-502
         -> 502  !! undeclared
```

API Gateway produces those two itself, on an integration timeout and an integration failure. No Lambda writes them and every caller can receive them.

## Can library authors publish suss summaries with their package?

Yes. Run `suss extract` at publish time and ship the JSON in `dist/`, and consumers pair against it without needing your source.

The `packageExports` discovery variant writes one provider summary per public export, resolved through your `package.json` entry points, so you never list the exports by hand. On the consumer side the `packageImport` variant finds every call site of an imported binding, and the two sides pair by `fn:<package>::<exportPath>`. [Publish summaries](/guides/publish-summaries) has the convention.

## Is the format stable?

The IR (`@suss/behavioral-ir`) and its JSON Schema are versioned, and a breaking change gets a major version bump.

The CLI flags and the `inspect` output still change between releases, so build any tool of yours on the JSON. [Summary format](/reference/summary-format#what-a-consumer-can-rely-on) lists what is guaranteed.

## How is it different from the tools I already run?

Your linter, type checker and tests each read one side of a boundary, and suss reads both sides and compares them.

[Compared to other tools](/why/compared) takes the linter, the type checker, the spec, the contract test and the tracing one at a time.

## What is out of scope?

Anything that needs a running system, a database of history, or a server.

- Cross-service aggregation, dashboards and historical drift tracking. Those all consume summaries suss produces.
- Continuous monitoring. suss runs on demand, locally or in CI, and never as a daemon.
- Authorial intent, mostly. suss derives what the code does. Written contracts say some of what it should do, and [intent docs](/guides/check-against-intent) your team writes are checked separately.
- Runtime instrumentation. Nothing suss reads comes from your running system. `suss corroborate --experimental` does run handlers, locally, against inputs it generates, and it records what it saw beside the derived claim, which stays as it was.

## How do I add a new framework?

Write a `PatternPack`: declarative configuration saying how the framework registers handlers, where a status code attaches to a response, and what counts as an effect.

Most packs are 100 to 300 lines of data and none of them forks the analyzer. [Write a pack](/packs/write-a-pack) walks through one.
