# Pack capability registration — design proposal

A declarative `capabilities` field on `PatternPack` describing what a pack might emit (summary kinds, boundary semantics, interaction classes, finding kinds it can trigger downstream) and what it pairs against. The adapter and checker read it before walking source files; the result drives configuration validation, output prediction, work-skipping in the producer, and a foothold for cross-pack-version compatibility.

## Why this exists

Today a `PatternPack` declares discovery patterns, terminals, recognizers, and an optional `discoverUnits` callback — i.e. WHAT it discovers and HOW. It does not declare WHAT KIND of summaries it produces or WHAT it consumes. The set of emitted `BoundaryBinding.semantics`, `Effect.interaction.class`, and downstream `FindingKind` values is implicit, learned only after extraction runs.

Four things break because of this:

1. **Configuration validation.** A user who runs `suss check -f apollo-client` without a GraphQL provider pack gets zero pairings and no explanation. The CLI cannot say "your hook calls have no resolvers / contracts to pair against." Today the failure mode is silent under-reporting.

2. **Output prediction.** `suss inspect --packs <list>` cannot answer "with this configuration, expect summaries of kind X / Y and findings of kind A / B." Useful for CI gating ("fail when no message-bus producer / consumer pair shows up, because we know we loaded both packs"), useful for previewing the surface a new pack adds.

3. **Work-skipping.** A pack that emits `interaction(class: "schedule")` effects has nothing to pair against if no consumer pack reads them. The producer could skip emission entirely. Today every recognizer fires regardless of downstream interest.

4. **Compat checking across pack versions.** Pack A v2 may rename a `binding.semantics` field that Pack B v1 pairs against. There is no metadata to compare. The current `version` field on `PatternPack` is a cache-invalidation key only.

A `capabilities` declaration is the smallest piece of metadata that lets all four work.

## Scope — v0

One field on `PatternPack`, two sub-fields, three checkpoints where it's read.

### Field shape

```ts
interface PatternPack {
  // ... existing fields
  capabilities?: PackCapabilities;
}

interface PackCapabilities {
  produces: ProducedCapability[];
  consumes?: ConsumedCapability[];
}
```

`capabilities` is optional. Packs that omit it auto-register from observed output (back-compat — see below).

`produces` describes what the pack can emit. Each entry is one of:

```ts
type ProducedCapability =
  | { kind: "code-unit"; codeUnitKind: CodeUnitKind }
  | { kind: "boundary"; semantics: SemanticsName; role: "provider" | "consumer" }
  | { kind: "effect"; interactionClass: InteractionClass }
  | { kind: "finding"; findingKind: FindingKind };
```

- `code-unit` — `BehavioralSummary.kind` values the pack will produce (`handler`, `component`, `library`, etc.)
- `boundary` — `binding.semantics.name` values, with `role` distinguishing producer-side (the boundary IS this pack) from consumer-side (the pack calls across this boundary). Same semantics name can appear twice if a pack covers both sides.
- `effect` — `Effect.interaction.class` values emitted by the pack's recognizers (`storage-access`, `service-call`, `message-send`, `config-read`, `schedule`)
- `finding` — `FindingKind` values the pack's checker emitters can produce. Most packs leave this empty (the checker, not the pack, emits findings); reserved for future plugin-checkers.

`consumes` declares what the pack pairs against — i.e. what it expects OTHER packs to produce:

```ts
type ConsumedCapability =
  | { kind: "boundary"; semantics: SemanticsName; role: "provider" | "consumer" }
  | { kind: "effect"; interactionClass: InteractionClass };
```

Example — `@suss/framework-aws-sqs`:

```ts
capabilities: {
  produces: [
    { kind: "code-unit", codeUnitKind: "consumer" },
    { kind: "boundary", semantics: "message-bus", role: "consumer" },
    { kind: "effect", interactionClass: "message-send" },
    { kind: "effect", interactionClass: "message-receive" },
  ],
  consumes: [
    { kind: "boundary", semantics: "message-bus", role: "provider" },
  ],
}
```

The producer side of `message-bus` lives in a contract pack (e.g. `@suss/contract-cloudformation`) that reads CFN templates. The framework pack consumes those provider summaries.

### Where it's checked

Three checkpoints:

1. **At pack-loader startup (CLI).** Walk the loaded pack list, build a `produces` index and a `consumes` index, diff them. Each `consumes` entry with no matching `produces` entry from another pack becomes a `MissingCapabilityWarning` printed to stderr before extraction starts. This catches "loaded apollo-client but no GraphQL provider" and "loaded prisma framework but no contract source for the schema."

2. **At extract time (adapter).** When dispatching recognizers, the adapter checks: for each effect a recognizer would emit, is any loaded pack's `consumes` set interested? If not — and the pack opted in via `skipUnconsumed: true` on the capability — skip the emission. This is the work-skipping path. Off by default in v0; opt-in per pack until we measure the wins.

3. **At check time (checker).** Build the predicted `FindingKind` set from the loaded packs' boundary capabilities (each `boundary` produces a known finding-kind set — e.g. any `boundary: storage-relational` pack wires up `boundaryFieldUnknown` / `boundaryFieldUnused`). Surface this as the "predicted findings" preview for `suss inspect`.

### Decentralizing checker dispatch

Today `checkAll` is a hardcoded chain — `findings.push(...checkProviderCoverage(...))`, `findings.push(...checkContractAgreement(summaries))`, repeated per checker pass. Same centralization problem the discovery layer had before `discoverUnits` callbacks. Each new finding source requires editing `checkAll`, and the checker has to know about every per-domain pass up front.

The capability mechanism is the natural lever to decentralize this. A pack that produces `boundary: storage-relational` already implies `boundaryFieldUnknown(read)` / `boundaryFieldUnused` checking exists; today the checker hardcodes which function runs that check. A cleaner model:

- Each per-domain checker registers itself against the boundary semantics it consumes — `checkRelationalStorage` declares "I run on summary sets containing `storage-relational` providers."
- The dispatch in `checkAll` becomes a loop over the loaded packs' `produces` / `consumes` capability index, calling registered checkers when the relevant semantics exist.
- New checkers ship with their pack rather than being added to the central `checkAll` body. Pack authors who add a new `boundary` semantics also ship the checker that pairs against it.

Trade-off: today's `checkAll` is greppable — every pass appears in one file. Decentralizing splits dispatch across packs, less locality. Mitigated by the capability index doubling as the discovery surface — `suss inspect --packs` already lists what's loaded; extending it to list registered checker passes is a small addition.

This is a v1 deliverable on top of v0 capabilities. The v0 version uses the capability index for prediction + validation only; the registry-based dispatch lands once the capability shape proves stable.

### Back-compat for missing `capabilities`

Packs without a declared `capabilities` field fall back to **observation-based registration**. After the first extraction pass, the adapter records every actual `(codeUnitKind, semanticsName, interactionClass)` the pack emitted and synthesizes a derived capability declaration. The synthesized declaration is cached alongside the pack version stamp and reused on subsequent runs.

This means:

- All currently-shipped packs work unchanged. They get a capability declaration via observation; over time pack authors migrate to declared capabilities.
- The CLI startup check has weaker signal for unmigrated packs (the warning fires after the first extraction, not before). For v0 this is acceptable — the migration happens fast because there are ~15 packs.
- Migration is a strict tightening: an undeclared pack might emit X but a declared pack promises X. Once declared, emitting something not in the declaration is a bug (logged at warn, not enforced as a hard error in v0).

## Out of scope, deferred

- **Pack-version compat ranges.** A `compatibleWith: { "@suss/contract-prisma": "^2.0.0" }` field on `consumes` would let a framework pack refuse to load against an incompatible contract pack. Needs semver discipline across packs that doesn't yet exist; defer until the pack ecosystem has external authors.
- **Auto-discovery of pack capability via dry-run extraction.** The observation-based fallback above already does this on real input; running a synthetic dry-run to populate the capability index ahead of extraction is a more elaborate variant. Defer until the lazy fallback proves insufficient.
- **Pack-pack composition rules.** "Loading `@suss/framework-prisma` requires `@suss/contract-prisma`" — a hard dependency declaration. The `consumes` field surfaces it as a warning today; promoting to a load-time error needs a way to express conditional requirements ("required when you have any Prisma-using code, otherwise optional"). Defer.
- **Field-level capability declarations.** Declaring not just `boundary: storage-relational` but also which COLUMN-level metadata the pack populates. Useful for predicting which findings an extraction will support. Defer until a real ask surfaces.
- **Confidence weighting across overlapping packs.** Open question (see below) — leaning toward not in v0.

## Mechanics

### Capability index

The CLI's pack-loader, after instantiating each pack, builds:

```ts
interface CapabilityIndex {
  // semanticsName → packs that produce it as provider / consumer
  boundaryProducers: Map<SemanticsName, Set<PackName>>;
  boundaryConsumers: Map<SemanticsName, Set<PackName>>;
  // interactionClass → packs that emit it
  effectEmitters: Map<InteractionClass, Set<PackName>>;
  effectReaders: Map<InteractionClass, Set<PackName>>;
  // codeUnitKind → packs that produce it
  unitKinds: Map<CodeUnitKind, Set<PackName>>;
  // findingKind → packs whose declared capabilities transitively imply it
  predictedFindings: Map<FindingKind, Set<PackName>>;
}
```

Built once at startup. Passed to the adapter (so recognizers can short-circuit) and to the CLI's check command (so unmatched-summary reporting can say "no pack consumes this boundary"). The boundary-to-finding mapping is hardcoded in the checker — each known semantics has a fixed set of finding kinds its checker emits, the same way `pairing/` modules are wired today.

### Validation diff

Pseudocode for the startup validation:

```
for pack in loaded_packs:
  for need in pack.consumes:
    if need.kind == "boundary" and need.role == "provider":
      if not capability_index.boundaryProducers.has(need.semantics):
        warn: "{pack} consumes provider summaries with semantics
               {need.semantics} but no loaded pack produces them"
```

Symmetric checks for consumer-role boundaries and for effects. Warnings, not errors — the user might intentionally run in producer-only mode.

### Cache-key implications

The pack version stamp already feeds the cache key. Capability changes split:

- **`produces` changes.** Don't invalidate the cache. Adding a capability to `produces` doesn't change what was actually emitted on the previous run; the cached summaries are still valid. Removing a capability the pack USED to emit IS a real change, but it's covered by the existing `version` bump that should accompany any behavioural change.
- **`consumes` changes.** Don't invalidate extraction cache (consumption is a checker-time concern). MAY invalidate the work-skipping decision — adding a consumer for an effect class means the producer can no longer skip. This is recomputed each run from the loaded pack list, not cached.

Net: capability declarations are NOT part of the cache key. The pack version stamp remains the single cache discriminator.

### Interaction with `discoverUnits`

`discoverUnits` is a callback — the pack can return any `DiscoveredCustomUnit` shape, including ones the declared `produces` doesn't cover. The adapter does NOT enforce capability declarations against callback output in v0. Two reasons:

1. Callback packs frequently discover things by inspection; the set of possible outputs isn't always knowable in advance (e.g. a Storybook pack emits one unit per `*.stories.tsx` story; the kind list is derived from the file).
2. Hard-enforcing would push pack authors toward over-declaring "just in case," which defeats the point.

Instead, the adapter LOGS (warn, throttled) when a callback emits a unit whose kind is not in `produces`. The pack author either widens `produces` or accepts the warning. Same treatment for emitted effect classes from recognizers.

This matches the runtime-node and dynamic-registration proposals' style: declare what's typical, observe what's actual, surface the diff.

## Open questions

- **Field name — `capabilities` vs `registers` vs `declares`.** Leaning `capabilities` because `registers` is semantically overloaded with `registrationCall` / `registrationTemplate` (different concept — those describe what the pack DISCOVERS as a registration shape, not what the pack itself contributes). `declares` is closer but more passive. `capabilities` reads as "what this pack can do." Open to bikeshed input but not blocking.

- **Should capabilities carry confidence estimates?** "I produce `config-read` effects with high confidence on `.ts` files." Two competing packs (a generic `process.env` recognizer and a more specific dotenv-loader recognizer) could both emit an effect for the same call site. Confidence-weighted dispatch would pick one. Tractable, but: the existing cross-pack dedup in the adapter (first pack wins by load order) is the lever today. Confidence would mean rebuilding that path. Lean against in v0; revisit when overlapping recognizers become a real source of double-emission.

- **Granularity of `effect` declarations.** `interactionClass` is the `Effect.interaction.class` discriminator (`storage-access`, `message-send`, etc.). Some packs differentiate within a class (a Postgres-only pack emits `storage-access` but only against `storageSystem: "postgres"`). Should the capability carry the inner discriminator? Probably yes for `boundary` (the semantics name already does this), probably no for `effect` in v0 — start at the class level, refine if validation needs more precision.

- **Should `produces` for `boundary` always pair with at least one `produces` for a corresponding `code-unit` kind?** A pack producing `boundary: rest, role: provider` should also be producing some unit kind (handler / controller). The two are correlated but not strictly so (a contract pack like `@suss/contract-openapi` produces REST provider summaries from spec files alone, not from code units). Keep them independent in v0.

- **How does this interact with the planned pack-authoring DX?** The `capabilities` declaration would need to round-trip into pack-author tooling (a CLI command to scaffold a pack with a starter capability list, validation against the IR's actual semantics enum). Out of v0 scope but worth keeping the schema small enough that a generator can populate it from a few prompts.

## Validation

1. Unit tests in `@suss/extractor` covering capability-declaration parsing + the validation diff against synthetic pack lists. Cover: missing producer, missing consumer, multiple producers (ambiguity is fine), packs declaring the same effect class.
2. Integration test in `@suss/cli` running `suss check` against a project with `framework-prisma` loaded but no `contract-prisma` — assert the missing-capability warning fires before any extraction starts.
3. Migration pass: add `capabilities` to all 15 currently-shipped packs. Compare each pack's declared set against the observation-based set produced by the back-compat path on the dogfood corpus; reconcile drift before declaring v0 done.
4. Inspect-preview integration: extend `suss inspect --packs <list>` to show the predicted summary kinds + finding kinds derived from the capability index. Eyeball against actual output on a real codebase; the two should match.
5. Work-skipping (opt-in): add `skipUnconsumed: true` to the `runtime-node` pack's `schedule` capability. Verify that running suss without any `schedule`-consuming pack produces no `schedule` effects in the IR. (Today there is no consumer; this is the test that the optimisation fires.)

## Cost estimate

- Schema + types in `@suss/extractor`: half a day. The shape is small; the IR enums it references are stable.
- Capability index + startup validation in `@suss/cli`: half a day. Mostly mapping and diffing.
- Observation-based fallback in the adapter: one day. Need a per-pack emission log, persisted alongside the cache, with the synth-on-first-run path.
- Migration of 15 existing packs: half a day. Each pack declaration is ~5 lines; the work is reading each pack to confirm what it actually emits.
- Tests + inspect-preview integration: one day.

Total: 3–3.5 days for v0. Smaller if work-skipping is deferred (drop half a day; it's the only piece that adds runtime branching to the recognizer dispatch).

## Sequencing

This pack-registration work is independent of `runtime-node` and `dynamic-registration`. Either can land first.

If multiple are in flight: registration first is the cheaper unlock. Once it lands, the new `runtime-node` and `dynamic-registration` packs can ship with declared capabilities from day one rather than being retro-fitted. The migration cost on the existing 15 packs is sunk either way; doing it before adding new packs avoids a second migration round.
