---
title: Compared to other tools
description: What your type checker, your linter, your contract tests, your specs and your tracing each tell you, and what suss tells you that they do not.
---

# Compared to other tools

## Why the tools you already run miss it

Every layer below describes something true about the code, and none of them compares what one side does against what the other side expects:

- **Type systems** describe structure. `User` is still `User` whether the user is active, soft-deleted, or shadow-banned.
- **Structural schemas** (OpenAPI, JSON Schema, Protobuf, GraphQL SDL) describe payload structure, that the response has a `status` string field, not under what conditions it takes the value `"deleted"`.
- **Runtime validators** (Zod, Yup, io-ts) check the payload's structure at the boundary. "Valid" is silent on which branch produced it.
- **End-to-end typed stacks** (tRPC, GraphQL codegen, OpenAPI codegen) pin down the structure on both sides. Both agree on `User | null`; neither records *when* the server returns `null`.
- **Example-based fixtures and contract tests** (Pact, Storybook / CSF, MSW) describe concrete cases. The example set is always incomplete, and the fixture doesn't cross-check whether a call site ever produces that combination.
- **Integration / e2e / visual-regression tests** (Cypress, Playwright, Chromatic) cover the golden path plus a handful of cases the author thought of. The interesting failures are the ones nobody wrote a test for.
- **Linters and pattern-based static analysis** (ESLint, CodeQL, Semgrep) match syntactic patterns. They don't model what a function produces under what conditions.
- **Deep static analysis** (Infer, symbolic execution) proves the absence of specific bug classes against a callee in isolation. It doesn't surface the callee's behavioral contract or compare it to what callers assume.
- **Observability** (OpenTelemetry, APM, Sentry) records what happened once. The union of traces is a subset of reachable behavior, and drift shows up after the incident.
- **Formal methods** (TLA+, Alloy, Design by Contract) describe behavior precisely but require hand-authored specifications that drift the moment someone forgets to update them.

What's missing is a way to *derive* a unit's behavioral contract from its implementation, across every boundary it participates in, and compare it against what each caller assumes. The per-tool "how is suss different from X" answers are in the [FAQ](/reference/faq).


The rest of this page takes them one at a time.

## How is this different from a linter?

A linter matches syntactic patterns: a forbidden call, a missing `await`, an unused variable. It never models what a function produces, so it cannot compare what one function sends with what another expects. A suss finding points at one path on the provider side that disagrees with one path on the consumer side, and gives you a file and a line for each, the way the output above does.

## How is this different from TypeScript?

TypeScript checks the structure of the data. `User` is still `User` whether the user is active, soft-deleted or shadow-banned, and `Response<200, User>` type-checks the same whichever branch of the handler produced it.

Here is `suss inspect` on a handler where the type is constant and the behavior is not. It is one summary out of three in the file, and the effects and gaps under it are cut:

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
```

Both 200 branches satisfy the same declared type. One of them sends `total: 0` and `state: "void"`. suss models which branch produced what and under what condition, which is a fact about values rather than about types.

## How is this different from OpenAPI, ts-rest or tRPC?

Those are specifications: somebody wrote down what the API should accept and return. suss is derivation: an extracted description of what the implementation does. They complement each other, and `suss check` pairs them and reports the drift. Checking that handler against its router gives seven findings, and this is the only error among them:

```
[ERROR] providerContractViolation
  Declared response 500 is never produced by the handler
  provider: src/handler.ts::getInvoice (src/handler.ts:8)
  consumer: src/invoicePanel.ts::loadInvoice (src/invoicePanel.ts:1)
  boundary: ts-rest (http) GET /invoices/:id
```

If you have an OpenAPI document, run `suss contract --from openapi` and check it against your handlers' summaries. [Check against OpenAPI](/guides/check-against-openapi) walks that through.

## How is this different from tests?

Tests record what happened on the inputs the author thought of. suss records what happens on every reachable path whether or not anyone wrote a test for it. Tests verify behavior with concrete data. suss enumerates the structure of behavior and finds the cases the test set never reaches.

## How is this different from observability?

Observability records what happened at runtime, once. The union of your traces is always a subset of reachable behavior, and you learn about drift after the incident. suss derives the structure of behavior statically, so a case that can fire in production but has not yet still appears in the output.

## Does suss replace OpenAPI, Storybook or Prisma schemas?

No, it reads them. Each of those is a specification or an observation, and suss is derivation. The interesting comparisons run across those kinds: does the derivation match the specification, and does the specification declare cases the derivation never reaches? [Three kinds of truth](/why/kinds-of-contract#three-kinds-of-truth) is the taxonomy underneath that.

