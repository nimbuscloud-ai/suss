# contract/

This module runs the contract-level checks. They compare a provider's implementation with its own declared contract, check that consumers cover the declared statuses, compare an extracted handler with a separate document for the same route, and check that contracts from several sources agree.

## Place in the pipeline

`checkAll()` runs these after pairing. Each check works on a different kind of input:

- **Consistency**: one provider's transitions against its own declared contract (does the implementation match what's documented?).
- **Implementation**: an extracted handler against the document (`suss contract --from openapi`) that describes the same route. The document is a provider too, so pairing never puts the two together. This pass groups them by boundary key and records each pair it compares, so the run counts as a comparison and neither side is listed as unmatched.
- **Completeness**: operations a document declares that no extracted handler implements.
- **Agreement**: N sources describing the same boundary, compared with each other (do the OpenAPI spec and the AppSync schema agree on the response shape?).

All of them take summaries, their declared contracts (parsed from `metadata.http.declaredContract`), and provider gaps (mismatches already caught upstream). They emit `providerContractViolation`, `consumerContractViolation`, `contractOperationUnimplemented` and `contractDisagreement` findings.

## Key files

- `declaredContract.ts:readDeclaredContract` parses the declared contract out of a summary's metadata.
- `declaredContract.ts:statusAccessorsFor` / `bodyAccessorsFor` return the property names the consumer uses to read response fields. When the metadata is missing, they fall back to `["status", "statusCode"]` and `["body"]`, which covers hand-written and older summaries.
- `contractConsistency.ts:checkContractConsistency` compares a provider's transitions with its declared schema.
- `contractImplementation.ts:checkContractImplementation` compares a handler that has no contract of its own with a document at the same boundary. A status the handler produces that the document leaves out is an error. A status the document declares that no path produces is a warning. A declared 5XX is left alone, because the framework usually produces those. Bodies go through the same comparison as consistency.
- `contractCompleteness.ts:checkContractCompleteness` reports declared operations no handler implements.
- `contractAgreement.ts:checkContractAgreement` checks that the contracts from N sources agree on status sets and body shapes for the same boundary.

## Ranges and `default`

A contract may declare a response for a class of statuses instead of one code. OpenAPI's `4XX` comes through as an entry in `responseRanges`, and `default` as `defaultResponse`. A range promises some status between its ends without saying which, so the checks read it in two directions:

- A consumer status inside a declared range counts as declared. `contractDeclaresStatus` is the one place that decides membership. A contract with a `defaultResponse` declares every status, because `default` covers everything the other entries leave out.
- A declared range counts as handled when the consumer handles any member, for example with a branch on 404, a `!res.ok` guard, or a default branch for a 2XX range. When no member is handled, the check reports it once as one unhandled response, and does not report each member.
- Agreement reads a range the same way: a source declaring `4XX` agrees with another source's `404`. A range is a weaker statement about the same status, so only literal statuses can disagree.

The consumer is never asked to cover the `default` bucket itself, because it has no concrete status to state an outcome about.

## Gotchas

- **Provenance decides whether a contract is compared with its own implementation.** A contract marked `derived` came from the same source as the implementation, for example an OpenAPI stub generated from the same TS code. Comparing the two would prove nothing, so the check skips them. Only `independent` contracts, which are separate documents, get checked.
- **A status-set disagreement is a warning.** When source A declares `{200, 404}` and source B declares `{200, 500}`, the check flags that as `contractDisagreement`. The two sources attribute different sets to the boundary, and merging them into one union would hide that.
- **Body absence is NOT disagreement.** When one source declares a status without a body and another declares the same status with a body, the two are consistent: one leaves the body out and the other spells it out. Disagreement only fires when both declare a body for the same status and the two shapes differ.
- **Response accessors fall back to convention.** When the metadata doesn't specify accessors, the check assumes `status` / `statusCode` for the status and `body` for the body. That keeps older summaries and hand-written ones working.

## Sibling modules

- `body/bodyMatch.ts` provides `bodyShapesMatch`, which the body-shape disagreement check uses.
- `coverage/responseMatch.ts` extracts literal status codes from transitions.
- `pairing/pairing.ts` provides `boundaryKey`, which groups sources by boundary so that agreement compares like with like.
