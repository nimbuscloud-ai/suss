# contract/

This module runs the contract-level checks: a provider's implementation against its own declared contract, consumer coverage of the declared statuses, an extracted handler against a separate document for the same route, and agreement between contracts from several sources.

## Place in the pipeline

`checkAll()` runs these after pairing. Each check works on a different kind of input:

- **Consistency**: one provider's transitions against its own declared contract (does the implementation match what's documented?).
- **Implementation**: an extracted handler against the document (`suss contract --from openapi`) that describes the same route. The document is a provider too, so pairing never puts the two together; this pass groups them by boundary key and records each pair it compares, so the run counts as a comparison and neither side is listed as unmatched.
- **Completeness**: operations a document declares that no extracted handler implements.
- **Agreement**: N sources describing the same boundary against each other (do the OpenAPI spec and the AppSync schema agree on the response shape?).

All take summaries, their declared contracts (parsed from `metadata.http.declaredContract`), and provider gaps (mismatches already caught upstream). They emit `providerContractViolation`, `consumerContractViolation`, `contractOperationUnimplemented` and `contractDisagreement` findings.

## Key files

- `declaredContract.ts:readDeclaredContract` parses the declared contract out of a summary's metadata.
- `declaredContract.ts:statusAccessorsFor` / `bodyAccessorsFor` give the property names the consumer uses to read response fields. When the metadata is missing, they fall back to `["status", "statusCode"]` and `["body"]`, which covers hand-written and older summaries.
- `contractConsistency.ts:checkContractConsistency` compares a provider's transitions against its declared schema.
- `contractImplementation.ts:checkContractImplementation` compares a handler with no contract of its own against a document at the same boundary. A status the handler produces that the document leaves out is an error. A status the document declares that no path produces is a warning, and a declared 5XX is left alone because the framework usually produces those. Bodies go through the same comparison as consistency.
- `contractCompleteness.ts:checkContractCompleteness` reports declared operations no handler implements.
- `contractAgreement.ts:checkContractAgreement` checks that the contracts from N sources agree on status sets and body shapes for the same boundary.

## Ranges and `default`

A contract may declare a response by class rather than by one code: OpenAPI's `4XX` comes through as an entry in `responseRanges`, and `default` as `defaultResponse`. A range promises some status between its ends without saying which, so the checks read it in two directions:

- A consumer status inside a declared range is declared. `contractDeclaresStatus` is the one place that decides membership, and a contract with a `defaultResponse` declares every status, because `default` covers everything the other entries leave out.
- A declared range is handled when the consumer handles any member (a branch on 404, a `!res.ok` guard, a default branch for a 2XX range). When no member is handled it reports once, as one unhandled response, not once per member.
- Agreement reads a range the same way: a source declaring `4XX` agrees with another source's `404`. A range is a weaker statement about the same status, so only literal statuses can disagree.

Nothing asks the consumer to cover the `default` bucket itself: it has no concrete status to state an outcome about.

## Non-obvious things

- **Provenance gates self-comparison.** A contract marked `derived` came from the same source as the implementation (e.g. an OpenAPI stub generated from the same TS code). Comparing the two would prove nothing, so the check skips them. Only `independent` contracts (separate documents) get checked.
- **Status-set disagreement = warning.** When source A declares `{200, 404}` and source B declares `{200, 500}`, the check flags that as `contractDisagreement`. What matters is that the two sources attribute different sets to the boundary, and merging them into one union would not help.
- **Body absence is NOT disagreement.** One source declaring a status without a body and another declaring the same status with a body are consistent (one says nothing, the other is explicit). Disagreement only fires when both declare a body for the same status and the two shapes differ.
- **Response accessors fall back to convention.** When the metadata doesn't specify accessors, the check assumes `status` / `statusCode` for the status and `body` for the body. That keeps older summaries and hand-written ones working.

## Sibling modules

- `body/bodyMatch.ts` provides `bodyShapesMatch`, which powers the body-shape disagreement check.
- `coverage/responseMatch.ts` extracts literal status codes from transitions.
- `pairing/pairing.ts` provides `boundaryKey`, which groups sources by boundary so that agreement compares like with like.
