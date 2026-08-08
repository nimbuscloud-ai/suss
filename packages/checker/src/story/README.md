# story/

This is a React-specific check that pairs Storybook stories against the inferred component summaries. It verifies that story args match the component's props, and that the stories exercise every branch a prop condition guards.

## Place in the pipeline

`checkAll()` runs it as an independent pass. It takes the summaries filtered by whether `metadata.component.storybook` is present: stories have the marker, components don't. It pairs them by component name, and emits `boundaryFieldUnknown` (a story supplies an unknown arg) and `scenarioCoverageGap` (the component has a branch on a prop no story provides).

## Key files

- `componentStoryAgreement.ts:checkComponentStoryAgreement` is the main entry point. It makes two passes: first it finds unknown args, then it finds coverage gaps.
- `componentStoryAgreement.ts:makeUnknownArgFinding` generates the warning for story args the component doesn't declare.
- `componentStoryAgreement.ts:makeCoverageGapFinding` generates the warning for component branches on props no story exercises.
- `componentStoryAgreement.ts:collectGatingProps` pulls out the prop names a component's transition conditions refer to. It walks the structured `Predicate` and `ValueRef` IR, and falls back to a regex over the raw text when the predicate is opaque.

## Non-obvious things

- **Stories vs. components by metadata, not name.** `metadata.component.storybook` is what tells the two apart. A summary without the marker is the inferred component (the React component pack discovered it), and one with the marker is a story file.
- **Coverage walks structured predicates first.** `collectGatingProps` reads `Predicate.subjects` and `ValueRef` chains to find prop names. For a nested ref (`user.active`), it takes the root binding (`user`).
- **Opaque predicate fallback is a regex with an exclusion list.** When the structured form of the predicate is unavailable, the code runs a regex for bare identifiers and filters out reserved words (`true`, `null`, `typeof`, etc.). That is conservative but safe: it would rather miss a finding than raise a false one.
- **Findings have `aspect: "construct"`.** These are mismatches at construction time, where the story instantiates the component with these props. Later work will add `aspect: "snapshot"` and `"play"` for checks on runtime rendering and on play functions.
- **No InteractionIndex dependency.** Unlike storage, message-bus, and runtime-config, the story check works directly on the summaries, because there is no per-class effect bucket to look up.

## Sibling modules

- `pairing/pairing.ts` is not used directly here: the story checks pair components by name inline rather than through `boundaryKey`.
- `coverage/responseMatch.ts` provides `makeSide` for the location strings on findings, the same convention the rest of the checker follows.
