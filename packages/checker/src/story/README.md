# story/

The story check compares Storybook stories with the component summaries suss inferred for React. It confirms that each story's args match the component's props, and that the stories between them exercise every branch a prop condition guards.

## Place in the pipeline

`checkAll()` runs it as a separate pass. It splits the summaries on whether `metadata.component.storybook` is present: stories have the marker and components do not. It pairs them by component name and emits two findings. `boundaryFieldUnknown` means a story supplies an arg the component does not declare. `scenarioCoverageGap` means the component branches on a prop that no story provides.

## Key files

- `componentStoryAgreement.ts:checkComponentStoryAgreement` is the main entry point. It makes two passes: the first finds unknown args, the second finds coverage gaps.
- `componentStoryAgreement.ts:makeUnknownArgFinding` builds the warning for a story arg the component doesn't declare.
- `componentStoryAgreement.ts:makeCoverageGapFinding` builds the warning for a component branch on a prop no story exercises.
- `componentStoryAgreement.ts:collectGatingProps` collects the prop names that a component's transition conditions refer to. It walks the structured `Predicate` and `ValueRef` IR, and falls back to a regex over the raw text when the predicate is opaque.

## Gotchas

- **Metadata tells stories and components apart, and the name does not.** A summary with the `metadata.component.storybook` marker is a story file. A summary without it is the inferred component, which the React component pack discovered.
- **Coverage walks structured predicates first.** `collectGatingProps` reads `Predicate.subjects` and `ValueRef` chains to find prop names. For a nested ref such as `user.active`, it takes the root binding, `user`.
- **The fallback for an opaque predicate is a regex with an exclusion list.** When the predicate has no structured form, the code matches bare identifiers and drops reserved words such as `true`, `null` and `typeof`. This errs on the side of missing a finding so that it does not raise a false one.
- **Findings have `aspect: "construct"`.** They are mismatches at construction time, where the story instantiates the component with these props. `aspect: "snapshot"` and `"play"` are planned for checks on runtime rendering and on play functions.
- **The check does not use InteractionIndex.** The storage, message-bus and runtime-config checks look effects up in a per-class bucket. Stories have no such bucket, so this check works on the summaries directly.

## Sibling modules

- `pairing/pairing.ts` is not used here. The story check pairs components by name inline and does not go through `boundaryKey`.
- `coverage/responseMatch.ts` provides `makeSide`, which builds the location strings on findings the same way the rest of the checker does.
