---
title: Kinds of contract
description: What kind of truth an artifact about code can tell you, the three contracts that meet at every boundary, and where a finding's severity comes from.
---

# Kinds of contract

"Contract" is the most overloaded word in suss. It means three different things at one boundary, and which one a finding compares against is what decides how bad the finding is.

Take an invoice endpoint. The API document says `GET /invoices/:id` returns 200, 404 or 500. The handler has never produced a 500, and somebody in the web app wrote a retry path for one anyway. The panel that renders the invoice treats every 200 as a live invoice, and since last quarter the handler has been sending voided invoices back as 200 as well. Each of those is true on its own, and the trouble only shows up when two of them are put side by side.

## The three contracts, in one run

Here is that endpoint as three files. The contract is a ts-rest router, so the declaration lives in the repo beside the code. An OpenAPI document read with `suss contract --from openapi` plays the same part.

```ts
// src/contract.ts
export const contract = c.router({
  getInvoice: {
    method: "GET",
    path: "/invoices/:id",
    responses: {
      200: c.type<{ id: string; total: number; state: string }>(),
      404: c.type<{ error: string }>(),
      500: c.type<{ error: string }>(),
    },
  },
});
```

```ts
// src/handler.ts
export const router = s.router(contract, {
  getInvoice: async ({ params }) => {
    const invoice = await findInvoice(params.id);

    if (!invoice) {
      return { status: 404 as const, body: { error: "not found" } };
    }

    if (invoice.voidedAt) {
      return {
        status: 200 as const,
        body: { id: invoice.id, total: 0, state: "void" },
      };
    }

    return {
      status: 200 as const,
      body: { id: invoice.id, total: invoice.total, state: "open" },
    };
  },
});
```

```ts
// src/invoicePanel.ts
export async function loadInvoice(id: string) {
  const response = await fetch(`/invoices/${id}`);

  if (response.status === 200) {
    const invoice = await response.json();
    return { total: invoice.total };
  }

  throw new Error("could not load invoice");
}
```

Read both sides with `suss extract -f ts-rest -f fetch -o summaries/all.json`, which writes three summaries, then print them:

```bash
suss inspect summaries/all.json
```

```
src/handler.ts
└─ GET /invoices/{id}  (ts-rest handler | line 8)
     Contract: 200, 404, 500
       if  !findInvoice()
         -> 404 { error }
       elif  findInvoice().voidedAt
         -> 200 { id, total, state }
       else
         -> 200 { id, total, state }
           + src/db.findInvoice →

       !! Declared response 500 is never produced by the handler

src/invoicePanel.ts
└─ GET /invoices/{id}  (fetch client | line 1)
       if  fetch().status === 200
         -> return { total }
       else
         -> throw Error
           + fetch
           + response.json

src/db.ts
└─ findInvoice  (reachable library | line 5)
       -> return Invoice (src/db.ts)

3 summaries.
```

All three contracts are in that output. `Contract: 200, 404, 500` is the declaration, read off the router. Under the handler are the branches it takes. Under the client are the ones the panel depends on. `check` compares them pairwise:

```bash
suss check --dir summaries/
```

```
Compared 1 boundary.

  1 boundary had nothing to pair with, so nothing was checked across it.
  Run the same command with --all to list them.

────────────────────────────────────────────────────────────
[ERROR] providerContractViolation
  Declared response 500 is never produced by the handler
  provider: src/handler.ts::getInvoice (src/handler.ts:8)
  consumer: src/invoicePanel.ts::loadInvoice (src/invoicePanel.ts:1)
  boundary: ts-rest (http) GET /invoices/:id
────────────────────────────────────────────────────────────
7 findings: 1 error, 6 warning, 0 info

Not shown: 4 unhandledProviderCase (warning), 2 consumerContractViolation (warning). Run the same command with --all to see them.

suss met a call it could not follow in one unit, of 3, so that one is described in part. `suss inspect` says which calls.
```

The 500 is an error and the other six findings are warnings. That difference comes from what each side of each comparison is: a specification, an observation, or a derivation.

## Three kinds of truth

An artifact about code can tell you one sort of thing, and which sort it is decides everything below.

| Kind of truth | What it tells you | Examples | Completeness |
|---|---|---|---|
| **Specification** | what should happen | OpenAPI, TypeScript interfaces, Storybook stories, Prisma schemas, CloudFormation templates | Under-specified. Declares what is allowed, and rarely when each case fires |
| **Observation** | what did happen, once | Snapshots, Pact recordings, Playwright tests, production logs | Point samples. Covers only what was tested |
| **Derivation** | what the code does, across all paths | A suss `BehavioralSummary` | Complete over paths, limited by analyzer fidelity |

The `BehavioralSummary` is the only artifact suss produces itself, and it fills the derivation row. Every declared contract and every contract source suss reads is a specification or an observation.

The findings come from comparing one kind against another:

- **Derivation ⊄ Specification**: the code takes a path the specification never declares. The handler produces a 500 that OpenAPI does not mention.
- **Specification ⊄ Derivation**: the specification declares a case the code cannot reach. That is the error in the run above.
- **Observation ⊄ Derivation**: something happened that the code should not be able to produce. Rare, high signal, usually a bug.
- **Derivation ⊄ Observation**: the code reaches paths no test covered. A coverage signal rather than a finding.

## The three contracts at a boundary

Every boundary has these three whether or not anyone writes them down. Which checker function fires for which comparison is in [Cross-boundary checking](/why/cross-boundary-checking).

**The declared contract** is authored and optional: ts-rest `responses`, an OpenAPI schema, a GraphQL SDL. It says which statuses and body structures are supposed to exist. This is a specification, and it is what most tools check against. A person wrote it, so it can be wrong, incomplete, or a year out of date. Where it exists, it is the one thing the provider team and the consumer team both point at. In the run above it is `Contract: 200, 404, 500`, read straight off the router.

**The provider's inferred contract** is a derivation: the transitions the handler produces, under condition A output X and under condition B output Y. It says more than the declaration in three ways. It separates sub-cases inside one status code, so 200 is `{ total: 0, state: "void" }` when `invoice.voidedAt` is set and `{ total, state: "open" }` otherwise, where the declaration collapses both into one. Each transition has its own body. And it turns up gaps, either a declared 500 no branch produces or a 418 the declaration never mentions.

**The consumer's inferred contract** is the other derivation: which status codes the caller branches on, which body fields it reads, which conditions it tests on the response. It is written down nowhere. It is not in OpenAPI, not in the types, and not in a Pact test unless somebody wrote that exact example, and it is the contract that causes an incident when it breaks. suss reads it out of the consumer's own source. `if (response.status === 200)` says the consumer expects 200 and, in the run above, nothing else. `invoice.total` says it depends on `total` being there. A test like `if (invoice.state === "void")` would say it tells a sub-case apart by a body field; this consumer does not, which is why the run reports the two 200s as one.

## Contract shapes

The three contracts above are HTTP-flavoured. Across domains, contracts arrive in more shapes than "schema", and a substantial domain usually uses several. Each shape is one of the three kinds of truth.

| Shape | What it declares | Kind of truth |
|---|---|---|
| **Schema** | what types cross the boundary: OpenAPI, ts-rest `responses`, GraphQL SDL, Prisma schemas, Avro and Protobuf, database DDL | specification |
| **Examples** | one valid interaction: Pact contracts, HAR captures, fixture files, curl examples in docs | observation |
| **Tests** | what should be true when X happens: Playwright specs, RTL component tests, supertest suites | observation |
| **Snapshots** | what the output looked like for one input: Jest and Vitest `.snap` files, visual-regression baselines | observation |
| **Design** | what the output should look like or do: Figma files, design tokens, accessibility specifications | intent |

Everything suss reads today is schema-shaped, across the HTTP, GraphQL, AppSync, message-bus, storage and component domains. Point `suss contract --from <source>` at one and you get summaries in the same form `extract` produces; [Contract sources](/packs/contract-sources) lists the readers that ship.

The other shapes have no reader. `suss corroborate --experimental` is the one observation that reaches a summary, and it comes from running the code: it generates inputs that satisfy a claim's own conditions, runs the handler on them, and records the verdict in `confidence.corroboration` as `observed`, `refuted` with the input that disagreed, or `untested`. Design shapes are left out on purpose, because design files rarely live in the repo and the API integration costs more than the signal is worth.

Team-authored intent is a kind of truth of its own, with an artifact stream separate from the contract sources. [Check against your intent](/guides/check-against-intent) covers the two document kinds and the commands that read them.

## Severity follows the kind of truth

A finding's severity comes from the kinds of truth being compared, not from the file format the contract arrived in:

- A derivation violates a specification: `error`. The code has drifted from what it promised. That is the `providerContractViolation` in the invoice run, where the router promises a 500 and no branch produces one.
- An observation violates a specification: `warning`. Something happened that the spec said could not.
- An observation is missing for a specification case: `info`. A coverage gap rather than a bug.
- Two specifications disagree: `warning`. Somebody has to reconcile them. This is the `contractDisagreement` finding.
- Two derivations disagree: `warning`. That is why the other six findings in the invoice run are warnings. Whether an uncovered status is a defect depends on intent the code does not state, so the run reports it and leaves the call to you.

The same rule assigns intent severities: a derivation that violates declared system intent is an error, and a derivation that exceeds open intent is info.
