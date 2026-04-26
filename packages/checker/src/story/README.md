# story/

React-specific check pairing Storybook stories against the inferred component summaries. Verifies story args match component props and that story coverage exercises every prop-conditional branch.

## Place in the pipeline

Runs in `checkAll()` as an independent pass. Consumes summaries filtered by `metadata.component.storybook` presence — stories carry the marker, components don't. Pairs by component name. Emits `boundaryFieldUnknown` (story supplies an unknown arg) and `scenarioCoverageGap` (component has a conditional branch on a prop no story provides).

## Key files

- `componentStoryAgreement.ts:checkComponentStoryAgreement` — main entry. Two-pass: unknown-arg detection, then coverage-gap detection.
- `componentStoryAgreement.ts:makeUnknownArgFinding` — warning for story args the component doesn't declare.
- `componentStoryAgreement.ts:makeCoverageGapFinding` — warning for component branches on props no story exercises.
- `componentStoryAgreement.ts:collectGatingProps` — extracts prop names referenced in component transition conditions. Walks structured `Predicate` and `ValueRef` IR — falls back to a regex on the raw text when the predicate is opaque.

## Non-obvious things

- **Stories vs. components by metadata, not name.** `metadata.component.storybook` is the discriminator. A summary without the marker is the inferred component (the React component pack discovered it); with the marker, it's a story file.
- **Coverage walks structured predicates first.** `collectGatingProps` reads `Predicate.subjects` and `ValueRef` chains to find prop names. For nested refs (`user.active`), it extracts the root binding (`user`).
- **Opaque predicate fallback is a regex with an exclusion list.** When the predicate's structured form is unavailable, the code regexes for bare identifiers and filters out reserved words (`true`, `null`, `typeof`, etc.). Conservative but safe — false negatives over false positives.
- **Findings carry `aspect: "construct"`.** Construct-time mismatches (story instantiates the component with these props). Future phases will add `aspect: "snapshot"` and `"play"` for runtime-rendering and play-function checks.
- **No InteractionIndex dependency.** Unlike storage / message-bus / runtime-config, story checking operates directly on summaries — there's no per-class effect bucket to look up.

## Sibling modules

- `pairing/pairing.ts` — story checks don't use `boundaryKey` directly; component-by-name pairing happens inline.
- `coverage/responseMatch.ts` — `makeSide` for location strings on findings (shared convention across checker).
