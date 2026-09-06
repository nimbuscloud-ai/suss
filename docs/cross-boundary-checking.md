---
title: How suss compares a provider against the code that calls it
description: How the checker pairs two summaries across a boundary and decides that a provider and its caller no longer agree.
---

# Cross-Boundary Checking

You added a branch to a handler last Tuesday. Admins now get an extra field, and a 404 goes out for a user who is not there. The pull request was three lines, the tests passed, and nobody on the web team was on the review.

The review needed one question answered, and nobody could get it by reading: does what the handler now does still match what its callers expect? A machine can answer that, given a behavioral summary for each side of the boundary, one for the handler that produces the response and one for the call site that reads it.

For the contract taxonomy these comparisons rest on, the three kinds of truth and the three contracts at every boundary, see [`contracts.md`](contracts.md). For the design of `BehavioralSummary` itself, see [`ir-reference.md`](ir-reference.md). For how a summary gets built in the first place, see [`architecture.md`](architecture.md).

Three kinds of boundary are checked today: HTTP REST, a GraphQL resolver against an operation, and an in-process function call through a package's exports. REST is the case the design leans on hardest. The status code says which outcome happened, the body is the payload, and the two sides pair by `(method, normalizedPath)`. GraphQL resolvers pair by `(typeName, fieldName)`. An in-process `function-call` pairs by `fn:<package>::<exportPath>`, which arrived with the `packageExports` and `packageImport` discovery variants, so a library's provider summaries pair with every caller that imports from it. See [`boundary-semantics.md`](boundary-semantics.md) for the layered model and [`reference/pack-patterns.md`](reference/pack-patterns.md) for the discovery variants.

## What that Tuesday change looks like

The handler, an Express route:

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

The caller, written before either branch existed:

```ts
// src/userCard.ts
import axios from "axios";

const client = axios.create({ baseURL: "/" });

export async function getUser(id: string) {
  const response = await client.get(`/users/${id}`);
  return response.data;
}
```

Both files typecheck, and they will keep typechecking however many branches the handler grows. `response.data` is `any`, and each of the handler's three replies is valid Express. Read both sides with `suss extract -f express -f axios -o summaries/all.json`, then compare them:

```bash
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

Three different comparisons produced those three findings. The first compares status codes: the handler can send a 404 and the caller has no branch for one. The second compares sub-cases within a status: two 200s leave the handler and one path in the caller receives both. The third compares a body field the handler varies against the conditions the caller tests, and finds nothing testing `admin`.

Each finding gives you the file and line on both sides, plus a `.sussignore.yml` rule you can paste for any one you decide to live with. See [`suppressions.md`](suppressions.md) for that format.

The last line is the other half of the answer. `db.findById` is declared here and never defined, so suss says outright that part of the handler went unread instead of reporting three findings as though it had seen everything.

## The comparison matrix

Every boundary has three contracts: the declared contract, which is a specification, and the provider's and the consumer's inferred contracts, which are both derivations. [`contracts.md`](contracts.md#the-three-contracts-at-a-boundary) defines them. Each pairwise comparison catches a different class of failure.

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

| Comparison | What it catches | Implemented |
|---|---|---|
| Provider inferred vs declared | Handler never produces a declared status. Handler produces an undeclared status. The body does not match the schema. | Yes (`checkContractConsistency`) |
| Provider inferred vs consumer inferred (status) | Provider returns 404 and the consumer has no branch for it. Consumer handles 410 and the provider never produces one. | Yes (`checkProviderCoverage`, `checkConsumerSatisfaction`) |
| Provider inferred vs consumer inferred (sub-cases) | Provider has two 200s, active and deleted, and the consumer has one 200 branch. | Yes (`checkProviderCoverage` sub-case analysis) |
| Provider inferred vs consumer inferred (body fields) | Consumer reads `body.email` and the provider's 200 response does not include it. | Yes (`checkBodyCompatibility`) |
| Consumer reads a field no response includes | Consumer reads `body.email` on a path where nothing distinguishes the response that has it from the one that does not, so the read comes back undefined and nothing says so. | Yes (`checkResponseMisread`) |
| Consumer inferred vs declared | Consumer reads `body.role` and the declared 200 schema does not include `role`. The consumer depends on an undeclared implementation detail. | Yes (`checkConsumerContract`) |
| Provider output ↔ consumer conditions (semantic bridging) | Provider's `user.deletedAt` transition produces a body with `status: "deleted"`, and the consumer tests `body.status === "deleted"`. Those are the same behavioral case written in two domains. | Yes (`checkSemanticBridging`) |

## What is checked today

The checker compares:

- **Status-code coverage in both directions.** A status the provider produces with no consumer branch, or a consumer branch for a status the provider never produces.
- **Collapsed sub-cases.** A consumer that treats two provider outcomes sharing a status code as one, which is the second finding in the run above.
- **Body fields.** What the consumer reads against what the provider produces, and against the declared contract.
- **Subjects through intermediate variables.** A condition on `const data = result.body` still resolves back to the response.
- **Semantic conditions.** A provider puts `admin: true` in a 200 body on the `user.role === "admin"` branch, and the consumer never tests `admin`. Both 200s land in the same branch of the caller, and the checker says so. This is the comparison that catches a 200 whose meaning changed.

Some layers are still in progress: local-function inlining, complement reasoning on negated conditions, and body accessors beyond `.body` and `.json()`.

Each of those comparisons takes a position on how the protocol behaves. Reporting an unhandled 404 treats the status the handler wrote as the status the caller receives, and a middleware or an API gateway can make that false. [`internal/protocol-assumptions.md`](internal/protocol-assumptions.md) lists those claims per protocol. It says what a finding means once one of them stops being true, and points at the test that pins today's behaviour.

## How the IR supports comparison

**Transitions are atomic.** Each transition is `(conditions → output, effects)` with a stable `id`. Matching happens at the transition level, which is why the run above can point at `get:response:200:24f5fd8` as the one 200 with `admin` in its body.

**Predicates are structural rather than textual.** A predicate is `{ subject, test }`, not a source string. Structured predicates can be compared across a boundary where the same idea is written two different ways.

**Subjects have identity.** `ValueRef` records where a value came from as a graph you can walk: a parameter, a call to a dependency, or a property read off one of those. On the provider side `user.deletedAt` resolves to `derived(dependency("db.findById"), propertyAccess("deletedAt"))`. On the consumer side `result.body.status` resolves to `derived(derived(dependency("client.getUser"), propertyAccess("body")), propertyAccess("status"))`. Semantic bridging works by matching the provider's output body field paths against the consumer's subject derivation chains.

**`expectedInput` records what the consumer reads.** Each client transition has an optional `expectedInput: TypeShape` for the response body fields the consumer touches inside that branch. It comes from the property access chains on the response variable, with nothing to annotate.

**Opaque predicates surface uncertainty.** When decomposition fails, the checker emits `lowConfidence` rather than a false negative.

**Gaps reach the findings, and the two kinds are treated differently.** A provider's `unhandledCase` gap becomes a `providerContractViolation` at error severity: the contract declares a response the handler never produces, or the handler produces one the contract never declared. An `unreadOutcome` gap becomes `lowConfidence` at info instead. That gap says a `return` matched none of the pack's terminal patterns, which is a limit on what suss could read. The handler may be returning exactly the right thing, and failing the check would punish working code.

## Output: findings

```typescript
interface Finding {
  kind: FindingKind;  // see /reference/findings for the full catalog
  boundary: BoundaryBinding;
  provider: { summary: string; transitionId?: string; location: SourceLocation };
  consumer: { summary: string; transitionId?: string; location: SourceLocation };
  description: string;
  severity: "error" | "warning" | "info";
  sources?: string[];               // present when dedupe collapsed multiple
  suppressed?: FindingSuppression;  // present when a .sussignore rule matched
}
```

`FindingKind` covers REST coverage, consumer satisfaction and contract consistency, GraphQL operation pairing, React component and Storybook agreement, storage field pairing, message-bus producer, consumer and queue pairing, runtime-config env-var pairing, and the meta-findings `lowConfidence`, `unsupportedSemantics` and `opaquePredicateBlocking`. The authoritative list is `FindingKindSchema` in `packages/behavioral-ir/src/schemas.ts`, and the [findings catalog](/reference/findings) groups every kind by domain with its severity, its emitter, and an example.

Findings are JSON-serializable. The CLI exits non-zero when any `error`-severity finding exists, which `--fail-on` tunes.

**Accepted findings.** When a finding is true and you have decided to tolerate it, say because this consumer does not need to handle a 500, a `.sussignore.yml` file at the project root or beside the summaries can `mark`, `downgrade` or `hide` it. `mark` keeps the finding visible and takes it out of the exit code, `downgrade` drops its severity one level, and `hide` removes it. See [`suppressions.md`](suppressions.md) for the format. The `Finding.suppressed` field on output records the rule's reason and effect, so a downstream tool can tell an accepted finding from one that was silently dropped.

**Cross-source contract agreement.** Sometimes several providers describe the same boundary, say an OpenAPI contract and a CloudFormation contract for one endpoint. Each arrives with its own declared contract. `checkContractAgreement`, which `checkAll` invokes for you, compares those contracts against each other and emits `contractDisagreement` when they differ: "sources disagree on whether status 500 exists at `GET /pet/:id`". It works at the contract level only, over `{statusCode, body}` tuples, and never looks at transitions. That is what keeps three or more sources to one finding per disputed status instead of an N-way pairwise explosion.

`checkContractConsistency` still handles the separate question of whether each provider agrees with its own contract. The `declaredContract.provenance` field, "derived" or "independent", tells it whether a provider's transitions and its contract came from the same source. OpenAPI contracts are derived, so the self-comparison is skipped. CFN contracts, and extracted handlers with an authored contract, are independent.

**Confidence is informational.** Each summary includes `ConfidenceInfo`, high, medium or low plus a source, which reflects how well the extractor decomposed the source: how many opaque predicates it fell back to, and whether wrapper expansion inferred the summary indirectly.

The checker does **not** downgrade a severity based on it. Summary confidence measures how well the analysis went on one side of a pair. How certain a finding is has its own mechanism, the `lowConfidence` finding kind. Folding one into the other would hide both.

Reviewers still see it. The human `suss check` output appends `(confidence: medium|low)` after any side below `high`, and a downstream tool can read `summary.confidence` from the JSON and apply its own policy.

## Scope

### In scope (OSS)

- The `suss check <provider.json> <consumer.json>` command. It compares one pair at a time, runs locally, and keeps no state between runs.
- Deterministic findings output, JSON or human-readable.
- The comparisons described above: status-code coverage, sub-case detection, field presence, consumer against declared contract, subject resolution, and semantic bridging.
- A library API so other tools can call the checker programmatically.

### Beyond pairwise

The checker compares two summaries at a time. Every analysis layer above that is a separate concern: aggregating summaries across an organization, tracking boundaries over commits, alerting on behavioral regressions, working out which pull requests break which consumers. Those layers take `BehavioralSummary[]` and pairwise findings as their input.

The OSS scope stops at producing summaries and running local checks. This repository has no aggregation layer in it. Building one on top should be straightforward, because summaries are stable JSON and findings are structured.
