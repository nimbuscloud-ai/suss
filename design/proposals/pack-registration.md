# Pack capability registration: design proposal

This proposal adds a declarative `capabilities` field to `PatternPack`. It lists what a pack might emit (summary kinds, boundary semantics, interaction classes, and the finding kinds it can trigger downstream) and what it pairs against. The adapter and checker read it before walking source files. The CLI uses it to validate configuration and predict output, the producer uses it to skip work, and it gives us a starting point for checking compatibility between pack versions.

## Why this exists

Today a `PatternPack` declares discovery patterns, terminals, recognizers, and an optional `discoverUnits` callback. That covers what it discovers and how. It does not declare what kind of summaries it produces or what it consumes. Nothing records which `BoundaryBinding.semantics`, `Effect.interaction.class`, and downstream `FindingKind` values it emits, so we only find out after extraction runs.

Four things break because of this:

1. **Configuration validation.** A user who runs `suss check -f apollo-client` without a GraphQL provider pack gets zero pairings and no explanation. The CLI cannot say "your hook calls have no resolvers / contracts to pair against." Today the result is under-reporting with no warning.

2. **Output prediction.** `suss inspect --packs <list>` cannot tell the user "with this configuration, expect summaries of kind X / Y and findings of kind A / B." A prediction like that would help CI gating ("fail when no message-bus producer / consumer pair shows up, because we know we loaded both packs"), and would let someone preview what a new pack adds.

3. **Work-skipping.** A pack that emits `interaction(class: "schedule")` effects has nothing to pair against if no consumer pack reads them. The producer could skip emission entirely. Today every recognizer fires whether or not anything downstream reads its output.

4. **Compat checking across pack versions.** Pack A v2 may rename a `binding.semantics` field that Pack B v1 pairs against. There is no metadata to compare. The current `version` field on `PatternPack` is only a cache-invalidation key.

A `capabilities` declaration is the smallest piece of metadata that lets all four work.

## Scope (v0)

v0 adds one field to `PatternPack`, with two sub-fields, and reads it at three checkpoints.

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

`capabilities` is optional. A pack that omits it is registered automatically from its observed output, for backward compatibility (see below).

`produces` lists what the pack can emit. Each entry is one of:

```ts
type ProducedCapability =
  | { kind: "code-unit"; codeUnitKind: CodeUnitKind }
  | { kind: "boundary"; semantics: SemanticsName; role: "provider" | "consumer" }
  | { kind: "effect"; interactionClass: InteractionClass }
  | { kind: "finding"; findingKind: FindingKind };
```

- `code-unit`: the `BehavioralSummary.kind` values the pack will produce (`handler`, `component`, `library`, etc.)
- `boundary`: `binding.semantics.name` values. `role` separates the producer side, where the pack provides the boundary, from the consumer side, where the pack calls across it. The same semantics name can appear twice if a pack covers both sides.
- `effect`: `Effect.interaction.class` values emitted by the pack's recognizers (`storage-access`, `service-call`, `message-send`, `config-read`, `schedule`)
- `finding`: `FindingKind` values the pack's checker emitters can produce. Most packs leave this empty, because the checker emits findings and packs do not. It is reserved for future plugin checkers.

`consumes` declares what the pack pairs against, meaning what it expects other packs to produce:

```ts
type ConsumedCapability =
  | { kind: "boundary"; semantics: SemanticsName; role: "provider" | "consumer" }
  | { kind: "effect"; interactionClass: InteractionClass };
```

Example (`@suss/framework-aws-sqs`):

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

The producer side of `message-bus` comes from a contract pack, such as `@suss/contract-cloudformation`, which reads CFN templates. The framework pack consumes those provider summaries.

### Where it's checked

It is read at three checkpoints:

1. **At pack-loader startup (CLI).** The loader walks the loaded pack list, builds a `produces` index and a `consumes` index, and diffs them. Each `consumes` entry with no matching `produces` entry from another pack becomes a `MissingCapabilityWarning`, printed to stderr before extraction starts. This catches cases like "loaded apollo-client but no GraphQL provider" and "loaded prisma framework but no contract source for the schema."

2. **At extract time (adapter).** When the adapter dispatches recognizers, it checks each effect a recognizer would emit against the loaded packs' `consumes` sets. If no pack consumes it, and the pack opted in with `skipUnconsumed: true` on the capability, the adapter skips the emission. This is the work-skipping path. It is off by default in v0, and each pack opts in until we measure how much it saves.

3. **At check time (checker).** The checker builds the predicted `FindingKind` set from the loaded packs' boundary capabilities. Each `boundary` capability leads to a known set of finding kinds; for example, any pack with `boundary: storage-relational` brings in `boundaryFieldUnknown` / `boundaryFieldUnused`. `suss inspect` shows this set as the "predicted findings" preview.

### Decentralizing checker dispatch

Today `checkAll` is a hardcoded chain: `findings.push(...checkProviderCoverage(...))`, `findings.push(...checkContractAgreement(summaries))`, repeated per checker pass. The discovery layer had the same centralization problem before `discoverUnits` callbacks. Each new finding source means editing `checkAll`, and the checker has to list every per-domain pass up front.

The capability mechanism is a good way to spread this out. A pack that produces `boundary: storage-relational` already implies that `boundaryFieldUnknown(read)` / `boundaryFieldUnused` checking exists, but today the checker hardcodes which function runs that check. A less centralized model would work like this:

- Each per-domain checker registers itself against the boundary semantics it consumes: `checkRelationalStorage` declares "I run on summary sets containing `storage-relational` providers."
- The dispatch in `checkAll` becomes a loop over the loaded packs' `produces` / `consumes` capability index, calling registered checkers when the relevant semantics exist.
- New checkers ship with their pack instead of being added to the central `checkAll` body. Pack authors who add a new `boundary` semantics also ship the checker that pairs against it.

The cost is locality. Today's `checkAll` is greppable, and every pass appears in one file. Decentralizing splits the dispatch across packs. The capability index makes up for that, because it becomes the place to look: `suss inspect --packs` already lists what is loaded, and listing registered checker passes too is a small addition.

This belongs to v1, on top of the v0 capabilities. v0 uses the capability index only for prediction and validation. The registry-based dispatch lands once the capability format proves stable.

### Back-compat for missing `capabilities`

Packs without a declared `capabilities` field fall back to **observation-based registration**. After the first extraction pass, the adapter records every `(codeUnitKind, semanticsName, interactionClass)` the pack actually emitted and builds a capability declaration from them. That declaration is cached alongside the pack version stamp and reused on later runs.

This means:

- Every pack shipped today works unchanged. It gets a capability declaration through observation, and over time pack authors move to declared capabilities.
- The CLI startup check is weaker for packs that have not migrated, because the warning fires after the first extraction instead of before it. That is acceptable for v0, since there are about 15 packs and the migration is quick.
- Migration only tightens things. An undeclared pack might emit X, and a declared pack promises X. Once a pack declares, emitting something outside the declaration is a bug. v0 logs it at warn and does not enforce it as a hard error.

## Out of scope for now

- **Pack-version compat ranges.** A `compatibleWith: { "@suss/contract-prisma": "^2.0.0" }` field on `consumes` would let a framework pack refuse to load against an incompatible contract pack. That needs semver discipline across packs, which does not exist yet, so it waits until the pack ecosystem has external authors.
- **Auto-discovery of pack capability via dry-run extraction.** The observation-based fallback above already does this on the project's own input. A synthetic dry run that fills the capability index before extraction is a more elaborate version of it. It waits until the lazy fallback turns out not to be enough.
- **Pack-pack composition rules.** A hard dependency declaration, such as "Loading `@suss/framework-prisma` requires `@suss/contract-prisma`". The `consumes` field reports it as a warning today. Turning that into a load-time error needs a way to express conditional requirements ("required when you have any Prisma-using code, otherwise optional"), so it waits.
- **Field-level capability declarations.** Declaring which column-level metadata a pack fills in, on top of `boundary: storage-relational`. That would help predict which findings an extraction can support. It waits until someone asks for it.
- **Confidence weighting across overlapping packs.** This is an open question (see below), and we lean toward leaving it out of v0.

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

The loader builds it once at startup. It passes the index to the adapter, so that recognizers can stop early, and to the CLI's check command, so that the report for an unmatched summary can print "no pack consumes this boundary". The boundary-to-finding mapping is hardcoded in the checker. Each known semantics has a fixed set of finding kinds its checker emits, wired the same way the `pairing/` modules are today.

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

There are matching checks for consumer-role boundaries and for effects. They are warnings, since the user might run in producer-only mode on purpose.

### Cache-key implications

The pack version stamp already feeds the cache key. Capability changes fall into two cases:

- **`produces` changes.** They do not invalidate the cache. Adding a capability to `produces` does not change what the previous run emitted, so the cached summaries are still valid. Removing a capability the pack used to emit does change the output, but the `version` bump that should come with any behavioural change already covers it.
- **`consumes` changes.** They do not invalidate the extraction cache, because consumption matters only at check time. They can change the work-skipping decision: once a pack consumes an effect class, the producer can no longer skip it. That decision is recomputed each run from the loaded pack list and never cached.

So capability declarations are not part of the cache key. The pack version stamp remains the single cache discriminator.

### Interaction with `discoverUnits`

`discoverUnits` is a callback, so the pack can return any `DiscoveredCustomUnit`, including ones its declared `produces` does not cover. In v0 the adapter does not check callback output against capability declarations, for two reasons:

1. Callback packs often discover things by inspection, and the set of possible outputs is not always known in advance. A Storybook pack, for example, emits one unit per `*.stories.tsx` story, and the kind list comes from the file.
2. Hard enforcement would push pack authors to over-declare defensively, and then the declaration would stop meaning anything.

Instead, the adapter logs a throttled warning when a callback emits a unit whose kind is not in `produces`. The pack author either widens `produces` or accepts the warning. Effect classes emitted by recognizers get the same treatment.

The runtime-node and dynamic-registration proposals work the same way: a pack declares what is typical, the adapter observes what actually happens, and the difference gets reported.

## Open questions

- **Field name: `capabilities` vs `registers` vs `declares`.** We lean toward `capabilities`, because `registers` already has a meaning through `registrationCall` / `registrationTemplate`. Those describe what the pack discovers as a registration in the code, which is a different concept from what the pack itself contributes. `declares` is closer but more passive. `capabilities` means "what this pack can do." Other suggestions are welcome, and the name does not block anything.

- **Should capabilities include confidence estimates?** "I produce `config-read` effects with high confidence on `.ts` files." Two competing packs (a generic `process.env` recognizer and a more specific dotenv-loader recognizer) could both emit an effect for the same call site. Confidence-weighted dispatch would pick one. That can be built, but today we use the adapter's cross-pack dedup, where the first pack by load order wins, and confidence would mean rebuilding that path. We lean against it for v0, and would revisit it if overlapping recognizers start emitting the same effect twice on a regular basis.

- **Granularity of `effect` declarations.** `interactionClass` is the `Effect.interaction.class` discriminator (`storage-access`, `message-send`, etc.). Some packs differentiate within a class; a Postgres-only pack emits `storage-access` but only against `storageSystem: "postgresql"`. Should the capability include the inner discriminator? Probably yes for `boundary`, where the semantics name already does this, and probably no for `effect` in v0. Start at the class level, and refine if validation needs more precision.

- **Should `produces` for `boundary` always pair with at least one `produces` for a corresponding `code-unit` kind?** A pack producing `boundary: rest, role: provider` should also be producing some unit kind (handler / controller). The two usually go together, but not always. A contract pack like `@suss/contract-openapi` produces REST provider summaries from spec files alone, with no code units. Keep them independent in v0.

- **How does this interact with the planned pack-authoring DX?** The `capabilities` declaration would need to round-trip into pack-author tooling, such as a CLI command that scaffolds a pack with a starter capability list, or validation against the IR's actual semantics enum. That is out of scope for v0, but the schema should stay small enough that a generator can fill it in from a few prompts.

## Validation

1. Unit tests in `@suss/extractor` covering capability-declaration parsing and the validation diff against synthetic pack lists. The cases are a missing producer, a missing consumer, multiple producers (ambiguity is fine), and packs declaring the same effect class.
2. An integration test in `@suss/cli` that runs `suss check` against a project with `framework-prisma` loaded but no `contract-prisma`. It asserts that the missing-capability warning fires before any extraction starts.
3. Migration pass: add `capabilities` to all 15 currently shipped packs. On the dogfood corpus, compare each pack's declared set with the set the back-compat path observes, and reconcile any drift before calling v0 done.
4. Inspect-preview integration: extend `suss inspect --packs <list>` to show the predicted summary kinds and finding kinds derived from the capability index. Compare it by eye against actual output on a production codebase; the two should match.
5. Work-skipping (opt-in): add `skipUnconsumed: true` to the `runtime-node` pack's `schedule` capability. Verify that running suss without any `schedule`-consuming pack produces no `schedule` effects in the IR. No pack consumes `schedule` today, so this test shows that the optimisation fires.

## Cost estimate

- Schema and types in `@suss/extractor`: half a day. The schema is small, and the IR enums it references are stable.
- Capability index and startup validation in `@suss/cli`: half a day. It is mostly mapping and diffing.
- Observation-based fallback in the adapter: one day. We need a per-pack emission log, persisted alongside the cache, plus the path that builds the declaration from it on the first run.
- Migration of 15 existing packs: half a day. Each pack declaration is about 5 lines, and the work is reading each pack to confirm what it actually emits.
- Tests and the inspect-preview integration: one day.

Total: 3 to 3.5 days for v0. Leaving out work-skipping saves half a day, since it is the only piece that adds runtime branching to the recognizer dispatch.

## Sequencing

This pack-registration work is independent of `runtime-node` and `dynamic-registration`. Either can land first.

If more than one is in progress, landing registration first costs less. The new `runtime-node` and `dynamic-registration` packs can then ship with declared capabilities from the start instead of being retrofitted. The existing 15 packs have to migrate either way, and migrating them before new packs arrive avoids a second round.
