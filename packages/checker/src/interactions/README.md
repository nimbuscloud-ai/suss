# interactions/

This module builds a single-pass index over interaction effects (`storage-access`, `service-call`, `message-send`, `config-read`, `schedule`, etc.), so that the per-class checkers don't each re-walk every summary.

## Place in the pipeline

`checkAll()` builds the index once at the start. Each per-class checker (`storage/`, `message-bus/`, `runtime-config/`) takes an optional `InteractionIndex` parameter. When it is supplied, the checker uses it for every lookup; when it is left out, the checker builds its own, which is handy for tests and one-off runs.

This module emits no findings. It is pure plumbing.

## Key files

- `dispatcher.ts:buildInteractionIndex` makes one pass over all the summaries, bucketing effects by `(class, semantics name)` and providers by `semantics name`.
- `dispatcher.ts:providersOf` looks providers up by semantics name.
- `dispatcher.ts:interactionsOf` looks interaction effects up by class and semantics name.
- `dispatcher.ts:collectInteractions` is the legacy one-shot walk, for callers written before the unified index. New callers should use the index.

## Non-obvious things

- **Two keys, intentional.** Lookups dispatch on `(class, semanticsName)` even though v0 maps them one to one (e.g. `message-send` → `message-bus`). The IR allows a future class to pair with several semantics types, and the index already supports that.
- **Null-binding summaries DO appear in `providersBySemantics`.** Anything with a binding goes into a bucket, and a summary with `boundaryBinding === null` simply has no bucket entry. The bucket is keyed on the semantics name, not on the summary's identity.
- **InteractionRecord has everything pairing needs.** An `InteractionRecord` is `(effect, summary, transitionId)`, so a per-class checker never has to re-walk the summary to find which transition the effect is on.
- **Index is read-only after build.** There is no mutation API. Rebuilding is cheap (one linear pass over the summaries), so rebuild the index rather than patching it when the summary set changes.

## Sibling modules

- `message-bus/messageBusPairing.ts` uses the index to find producers and receive-side effects.
- `storage/relationalPairing.ts` uses the index to look up storage-access effects.
- `runtime-config/runtimeConfigPairing.ts` takes the index as an optional parameter and builds its own when it is missing.
