# interactions/

Single-pass index over interaction effects (`storage-access`, `service-call`, `message-send`, `config-read`, `schedule`, etc.), so per-class checkers don't each re-walk every summary.

## Place in the pipeline

Built once at the start of `checkAll()`. Each per-class checker (`storage/`, `message-bus/`, `runtime-config/`) accepts an optional `InteractionIndex` parameter — when supplied, the checker uses it for all lookups; when omitted, the checker builds its own (handy for tests and one-off runs).

No findings are emitted from this module. Pure plumbing.

## Key files

- `dispatcher.ts:buildInteractionIndex` — single pass over all summaries; buckets by `(class, semantics name)` for effects and by `semantics name` for providers.
- `dispatcher.ts:providersOf` — lookup providers by semantics name.
- `dispatcher.ts:interactionsOf` — lookup interaction effects by class + semantics name.
- `dispatcher.ts:collectInteractions` — legacy one-shot walk for callers that pre-date the unified index. New callers should use the index.

## Non-obvious things

- **Two keys, intentional.** Lookups dispatch on `(class, semanticsName)` even though v0 has 1:1 mapping (e.g. `message-send` → `message-bus`). The IR allows future classes to pair with multiple semantics types; the index already supports it.
- **Null-binding summaries DO appear in `providersBySemantics`.** Anything with a binding gets bucketed; summaries with `boundaryBinding === null` simply have no bucket entry. The bucket is keyed on the semantics name, not the summary's identity.
- **InteractionRecord carries everything pairing needs.** `(effect, summary, transitionId)` — no need for the per-class checker to re-walk the summary to find which transition the effect lives on.
- **Index is read-only after build.** No mutation API. Re-building is cheap (single linear pass over summaries); rebuild instead of patching when the summary set changes.

## Sibling modules

- `message-bus/messageBusPairing.ts` — uses the index to find producers + receive-side effects.
- `storage/relationalPairing.ts` — uses the index for storage-access effect lookups.
- `runtime-config/runtimeConfigPairing.ts` — optional index parameter; builds its own if missing.
