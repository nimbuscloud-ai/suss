---
title: Cross-boundary checking
description: How the checker pairs two summaries across a boundary and reports where the provider and its caller stop agreeing.
---

# Cross-boundary checking

`suss check` reads the handler on one side of a boundary and the call site on the other, and reports where the two disagree. Each side becomes a behavioral summary, and the checker compares them. You do not need a spec, and if you have one, suss compares it against both sides as well.

## An example

Here is the handler, an Express route:

```ts
// src/routes.ts
router.get("/users/:id", async (req, res) => {
  const user = await db.findById(req.params.id);

  if (!user) {
    res.status(404).json({ error: "not found" });
    return;
  }

  if (user.role === "admin") {
    res.json({ ...user, admin: true });
    return;
  }

  res.json(user);
});

declare const db: {
  findById(
    id: string,
  ): Promise<{ id: string; name: string; role: string } | null>;
};
```

Here is the caller, written before either of those branches existed:

```ts
// src/userCard.ts
import axios from "axios";

const client = axios.create({ baseURL: "/" });

export async function getUser(id: string) {
  const response = await client.get(`/users/${id}`);
  return response.data;
}
```

Both files typecheck, and they will keep typechecking however many branches the handler grows. `response.data` is `any`, and each of the handler's three replies is valid Express. Read both sides, then compare them:

```bash
suss extract -f express -f axios -o summaries/all.json
suss check --dir summaries/ --all
```

```
Compared 1 boundary:
  GET /users/{id}
    users-api::src/routes.ts::get <-> users-api::src/userCard.ts::getUser

────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider produces status 404 but no consumer branch handles it
  provider: src/routes.ts::get (src/routes.ts:5)
  consumer: src/userCard.ts::getUser (src/userCard.ts:5)
  boundary: express (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:404:afd032b" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider returns status 200 in 2 different situations, and the consumer treats them all the same
  provider: src/routes.ts::get (src/routes.ts:5)
  consumer: src/userCard.ts::getUser (src/userCard.ts:5)
  boundary: express (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:200:24f5fd8" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
[WARNING] unhandledProviderCase
  Provider transition get:response:200:24f5fd8 for status 200 produces body with admin = true, but no consumer branch tests for this value
  provider: src/routes.ts::get (src/routes.ts:5)
  consumer: src/userCard.ts::getUser (src/userCard.ts:5)
  boundary: express (http) GET /users/:id
  to silence this one, add to the rules in .sussignore.yml:
    - kind: unhandledProviderCase
      boundary: "GET /users/{id}"
      provider: { transitionId: "get:response:200:24f5fd8" }
      reason: TODO say why you accept this
────────────────────────────────────────────────────────────
3 findings: 0 error, 3 warning, 0 info

suss met a call it could not follow in one unit, of 2, so that one is described in part. `suss inspect` says which calls.
```

Three comparisons produced those three findings. The first one compares status codes: the handler can send a 404 and the caller has no branch for one. The second compares sub-cases within a status: the handler returns 200 in two different situations, and one path in the caller receives both. The third compares a body field the handler varies against the conditions the caller tests, and finds nothing that tests `admin`.

Each finding gives you the file and the line on both sides, plus a `.sussignore.yml` rule to paste for any one you decide to live with. See [Accept a finding](/guides/accept-a-finding) for that format.

`db.findById` is declared here and never defined. That is why the last line of the run reports that part of the handler went unread.

## Which summaries face each other

Two summaries pair up when they are on the same boundary, and what that means depends on the kind of boundary:

| Boundary | The two sides pair on | Example |
|---|---|---|
| HTTP REST | method and normalized path | `GET /users/{id}` on an Express route and on an axios call |
| GraphQL | type name and field name | `Query.user` on an Apollo resolver and on a `useQuery` in a component |
| Package export | package name and export path | `fn:@acme/billing::charge` on the exported function and on every file that imports it |
| Storage | system, scope, container and access path | a Prisma model and every query that selects from it |
| Message bus | bus and channel subject | an SQS send and the handler the deploy template wires to that queue |
| Runtime config | deployment target and instance name | the env vars a Lambda reads and the ones its template sets |

[Boundary semantics](/theory/boundary-semantics) explains how the pairing key is built for each of them.

## What gets compared

For each pair the checker runs seven checks. Each one reads nothing but that pair, and none of them can see what another found.

- **Provider coverage.** A status the provider produces that no consumer branch handles, and sub-cases within one status that the consumer treats as one. Those are the first two findings above.
- **Consumer satisfaction.** A consumer branch for a status the provider never produces. That branch is dead.
- **Misread responses.** A consumer path that reads a field off a response that does not include it, when nothing on that path tells it apart from the response that does.
- **Contract consistency.** A handler that never produces a status its contract declares, or that produces one the contract never declared.
- **Consumer contract.** A consumer that reads a field the declared contract never promised, so the consumer depends on an implementation detail.
- **Body compatibility.** The consumer's body-field reads against the bodies the provider produces, per status.
- **Semantic bridging.** The provider puts `admin: true` in a 200 body on the `user.role === "admin"` branch, and the consumer never tests `admin`. That is the third finding above.

All seven compare subjects rather than source text, so a condition written on an intermediate variable still counts: `const data = result.body` resolves back to the response before anything is compared.

Where several sources describe one boundary, say an OpenAPI document and a CloudFormation template for the same endpoint, `checkContractAgreement` compares those declarations against each other and emits `contractDisagreement` when they differ.

The [findings catalog](/reference/findings) lists every finding kind by domain, with its severity and an example. [Kinds of contract](/why/kinds-of-contract#severity-follows-the-kind-of-truth) explains where each severity comes from.

## The three contracts at a boundary

Every boundary has three behavioral contracts: the declared one, which somebody wrote, and the provider's and the consumer's, which suss derives from their code. Each pairwise comparison catches a different class of failure.

<svg class="suss-diagram" viewBox="0 0 660 300" role="img" aria-labelledby="matrix-title matrix-desc">
  <title id="matrix-title">The three contracts at one boundary</title>
  <desc id="matrix-desc">One boundary, GET /users/:id, has a declared contract that is a specification, and two derivations, one read from the provider's code and one from the consumer's. Arrows show which pairs the checker compares and what each comparison catches.</desc>

  <defs>
    <marker id="matrix-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <text class="axis" x="330" y="16" text-anchor="middle">One boundary: GET /users/:id</text>

  <rect class="box-data" x="200" y="30" width="260" height="70" rx="6" />
  <text class="label" x="330" y="52" text-anchor="middle">Declared contract</text>
  <text class="note" x="330" y="70" text-anchor="middle">a specification, written by a person</text>
  <text class="note" x="330" y="87" text-anchor="middle">an OpenAPI file, an SDL, a SAM template</text>

  <rect class="box" x="20" y="200" width="250" height="70" rx="6" />
  <text class="label" x="145" y="222" text-anchor="middle">Provider's behaviour</text>
  <text class="note" x="145" y="240" text-anchor="middle">a derivation, read from the handler</text>
  <text class="note" x="145" y="257" text-anchor="middle">"404 when the user is missing"</text>

  <rect class="box" x="390" y="200" width="250" height="70" rx="6" />
  <text class="label" x="515" y="222" text-anchor="middle">Consumer's expectations</text>
  <text class="note" x="515" y="240" text-anchor="middle">a derivation, read from the call site</text>
  <text class="note" x="515" y="257" text-anchor="middle">"handles 200 and 500"</text>

  <line class="arrow" x1="255" y1="97" x2="160" y2="196" marker-end="url(#matrix-arrow)" />
  <text class="note" x="150" y="124" text-anchor="middle">does the code</text>
  <text class="note" x="150" y="140" text-anchor="middle">do what it promised?</text>

  <line class="arrow" x1="405" y1="97" x2="500" y2="196" marker-end="url(#matrix-arrow)" />
  <text class="note" x="512" y="124" text-anchor="middle">does the caller expect</text>
  <text class="note" x="512" y="140" text-anchor="middle">what was promised?</text>

  <line class="arrow" x1="270" y1="235" x2="386" y2="235" marker-end="url(#matrix-arrow)" />
  <line class="arrow" x1="390" y1="248" x2="274" y2="248" marker-end="url(#matrix-arrow)" />
  <text class="note" x="330" y="192" text-anchor="middle">do the two sides agree</text>
  <text class="note" x="330" y="285" text-anchor="middle">about statuses, sub-cases, and body fields?</text>
</svg>

[Kinds of contract](/why/kinds-of-contract#the-three-contracts-at-a-boundary) defines the three and works through a run where all of them appear.

## What the checker abstains from

Every comparison rests on a claim about how the protocol behaves. When suss reports an unhandled 404, it is treating the status the handler wrote as the status the caller receives, and a middleware or an API gateway can make that untrue. [Protocol assumptions](/theory/protocol-assumptions) lists those claims per protocol and explains what a finding means once one of them is no longer true.

Where the extractor could not take a condition apart, the checker emits `lowConfidence` at info severity instead of a finding it cannot support. A gap that records a `return` matching none of the pack's terminal patterns comes out the same way: the handler may well be returning the right thing, and suss could not read it.

The checker compares two summaries at a time. Anything above that, such as aggregating summaries across an organization or tracking one boundary over a series of commits, is a separate layer, and that layer takes `BehavioralSummary[]` and pairwise findings as its input.
