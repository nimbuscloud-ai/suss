# contract/

Three contract-level checks: provider implementation vs. its own declared contract, consumer coverage of declared statuses, and multi-source contract agreement.

## Place in the pipeline

Runs in `checkAll()` after pairing. Each check operates on a different shape:

- **Consistency** — one provider's transitions against its own declared contract (does the implementation match what's documented?).
- **Agreement** — N sources describing the same boundary against each other (do the OpenAPI spec and the AppSync schema agree on the response shape?).

Both consume summaries, their declared contracts (parsed from `metadata.http.declaredContract`), and provider gaps (mismatches already caught upstream). Emit `providerContractViolation`, `consumerContractViolation`, and `contractDisagreement` findings.

## Key files

- `declaredContract.ts:readDeclaredContract` — parses the declared contract from a summary's metadata.
- `declaredContract.ts:statusAccessorsFor` / `bodyAccessorsFor` — property names the consumer uses to read response fields. Default fallback: `["status", "statusCode"]` and `["body"]` for hand-written or older summaries that lack metadata.
- `contractConsistency.ts:checkContractConsistency` — compares a provider's transitions against its declared schema.
- `contractAgreement.ts:checkContractAgreement` — checks that N sources' contracts agree on status sets and body shapes for the same boundary.

## Non-obvious things

- **Provenance gates self-comparison.** A contract marked `derived` came from the same source as the implementation (e.g. an OpenAPI stub generated from the same TS code). Comparing them is tautological — skipped. Only `independent` contracts (separate documents) are checked.
- **Status-set disagreement = warning.** When source A declares `{200, 404}` and source B declares `{200, 500}`, that's flagged as `contractDisagreement`. The set-attribution mismatch matters; the union doesn't help.
- **Body absence is NOT disagreement.** A source that declares a status without a body and another that declares the same status with a body is consistent (one is silent, the other is explicit). Disagreement only fires when both declare a body for the same status and the shapes differ.
- **Response accessors fall back to convention.** When metadata doesn't specify accessors, assume `status` / `statusCode` for status and `body` for body. Keeps older summaries and hand-written ones working without breakage.

## Sibling modules

- `body/bodyMatch.ts` — `bodyShapesMatch` powers the body-shape disagreement check.
- `coverage/responseMatch.ts` — extracts literal status codes from transitions.
- `pairing/pairing.ts` — `boundaryKey` groups sources by boundary so agreement runs on like-with-like.
