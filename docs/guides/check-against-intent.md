---
title: Check against your intent
description: Draft intent documents from the code, curate them, and compare what the code does against what your team said it should do.
---

# Check against your intent

Compare the code against what your team said it should do, rather than
against another piece of code or a published spec.

```bash
npx suss check --dir summaries/ --intent intent/
```

## What an intent document is

Intent is partly shipped. It has an artifact stream of its own, separate from the contract sources read by `suss contract`.

Team-authored intent specs (`*.intent` and `*.prd`, read by `@suss/contract-intent`) parse to `IntentSummary` rather than `BehavioralSummary`, and `@suss/checker-intent` pairs them against derived code through `suss check --dir summaries/ --intent intent/`. There are two kinds:

- **System intent** (`*.intent`), the contract a boundary should satisfy, structural and machine-comparable: "`POST /auth/login` returns 429 with `{ error, retryAfter }`".
- **Outcome intent** (`*.prd`), what should happen for the user, scenario-shaped: "a rate-limited request gets a friendly rejection", with scenarios that can link to system-intent outcomes.

Third-party schemas express some intent, but an OpenAPI document was authored as a wire contract and a Prisma schema as a data model, not as a statement of what the team wanted. That is why intent docs are **open** specifications. They set a floor, what must exist, rather than a closed list of everything allowed. Code that exceeds intent is possibly-missing intent, reported as info rather than as a violation. Boundary-level intent checks ship today, and PRD scenario coverage ships alongside them.

## Draft the documents from the code

`suss infer intent` writes one starting document per boundary, from a
summaries file, for a person to curate. `suss infer prd` reads the
curated documents back and writes a PRD per boundary for a person to
fill in. Both are in the [`suss infer` reference](/reference/cli/infer),
with the shape of each drafted file.

Until the blanks in a draft are filled, the reader rejects the file and
says so, so an uncurated draft never passes for finished.

## What comes back

The intent finding kinds are in the
[findings catalog](/reference/findings). Severity follows the kinds of
truth being compared: a derivation that violates declared system intent
is an error, and a derivation that exceeds open intent is info. See
[Kinds of contract](/why/kinds-of-contract#severity-follows-the-kind-of-truth).
