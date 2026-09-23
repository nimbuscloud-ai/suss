# interactions/

This module builds an index over interaction effects (`storage-access`, `service-call`, `message-send`, `config-read`, `metadata-read`, `schedule`, etc.) in one pass, so the per-class checkers don't each walk every summary again.

## Place in the pipeline

`checkAll()` builds the index once at the start. Each per-class checker (`storage/`, `message-bus/`, `runtime-config/`) takes an optional `InteractionIndex` parameter. When a caller passes one, the checker uses it for every lookup. When a caller leaves it out, the checker builds its own, which is handy for tests and one-off runs.

This module doesn't emit findings. It builds the index and runs lookups against it.

## Key files

- `dispatcher.ts:buildInteractionIndex` makes one pass over all the summaries. It buckets effects by `(class, semantics name)` and providers by `semantics name`.
- `dispatcher.ts:providersOf` looks providers up by semantics name.
- `dispatcher.ts:interactionsOf` looks interaction effects up by class and semantics name.
- `dispatcher.ts:collectInteractions` is the legacy one-shot walk, kept for callers written before the unified index. New callers should use the index.

## Gotchas

- **Lookups use two keys on purpose.** They dispatch on `(class, semanticsName)` even though v0 maps the two one to one (e.g. `message-send` → `message-bus`). The IR allows a future class to pair with several semantics types, and the index already supports that.
- **Null-binding summaries DO appear in `providersBySemantics`.** Anything with a binding goes into a bucket, and a summary with `boundaryBinding === null` doesn't get an entry. The bucket is keyed on the semantics name and not on the summary's identity.
- **An InteractionRecord has everything pairing needs.** An `InteractionRecord` is `(effect, summary, transitionId)`, so a per-class checker never has to walk the summary again to find which transition the effect is on.
- **The index is read-only once built.** Nothing can change it after `buildInteractionIndex` returns. Rebuilding costs one linear pass over the summaries, so when the summary set changes, rebuild the index instead of patching it.

## Sibling modules

- `message-bus/messageBusPairing.ts` uses the index to find producers and receive-side effects.
- `storage/relationalPairing.ts` uses the index to look up storage-access effects.
- `runtime-config/runtimeConfigPairing.ts` takes the index as an optional parameter and builds its own when it is missing.
