# @suss/contract-storybook

Generate suss `BehavioralSummary[]` from [Storybook](https://storybook.js.org/) CSF3 story files. A story is a specification somebody wrote by hand: this component supports this prop configuration. Reading stories as contracts lets you ask whether a component accepts the args every story supplies, and whether every branch inferred from the component has a story that reaches it.

## What this package reads

`@suss/contract-storybook` parses `.stories.ts` and `.stories.tsx` files with ts-morph and looks at two things in each one.

The default export gives the component under test. The reader walks the default-export symbol's declarations for an object literal with a `component` property, which covers `export default { component: Button }`, `const meta = { component: Button }; export default meta;`, and `export default { ... } satisfies Meta<typeof Button>`. Parentheses, `as` expressions, and an identifier pointing at a local variable are followed through to the literal. A file whose default export never resolves to such an object is skipped, and the rest of the run continues.

Every other named export whose initializer resolves to an object literal is a story. Its `args` object literal becomes the story's arguments, with each property's value recorded as the source text you wrote. A shorthand property (`{ disabled }`) records its own name.

## What it produces

One `component`-kind summary per named story export:

- `identity.name` is `Component.Story`, with `exportPath` set to the story's export name and a function-call boundary binding: `transport: "in-process"`, `recognition: "react"`, and the component identifier as the export name.
- One input per arg. The input's `role` is the arg name, and its shape is a `ref` whose name is the arg's source text, so a reader can see the concrete value that was written.
- One default transition whose output is a render of the component. The reader does not evaluate the render, so the rendered tree is left unset.
- `metadata.component.storybook` with the story name, the component name, the args map, and `provenance: "independent"`, which is what makes a story usable as a check against an inferred component summary rather than a restatement of it.
- Confidence is `derived` at `medium`. Stories are written by people and are authoritative where they speak, and they do not enumerate everything a component does.

## What it does not read

- **`play` functions.** The event sequence that exercises an interactive story is not captured.
- **`argTypes`.** Per-arg control types and option lists would inform stricter type checking and are not read today.
- **`decorators` and `parameters`.** Storybook runtime plumbing rather than component behavior.
- **CSF1 and MDX stories.** CSF3 is the supported format.
- **The component's own module.** The reader keeps the `component` identifier as written and does not follow the import to where the component is defined.
- **Arg values as structured shapes.** An arg's value stays source text inside a `ref` shape rather than being parsed into a `TypeShape`.

## Worked example

```tsx
// Button.stories.tsx
import { Button } from "./Button";

export default { component: Button };

export const Primary = {
  args: { variant: "primary", disabled: false },
};

export const Disabled = {
  args: { variant: "primary", disabled: true },
};
```

```sh
suss contract --from storybook src/components -o summaries/stories.json
suss check summaries/app.json summaries/stories.json
```

The path may be one `.stories.ts[x]` file or a directory, which the CLI walks recursively for story files. Two summaries come out of the file above, `Button.Primary` and `Button.Disabled`, each with `variant` and `disabled` inputs.

Or programmatically, when you want control over the file set or the root that relative paths are computed against:

```ts
import { generateSummariesFromStories } from "@suss/contract-storybook";

const summaries = generateSummariesFromStories(
  ["src/components/Button.stories.tsx"],
  { projectRoot: process.cwd() },
);
```

## Where it fits in suss

Depends on `@suss/behavioral-ir` (for the IR types it produces) and `@suss/adapter-typescript` (for export resolution), with `ts-morph` as a peer dependency. This is the one contract reader that parses TypeScript, because CSF is TypeScript. It still reads a declared artifact rather than inferring behavior from a component's implementation.

## Coverage

![coverage](../../../.github/badges/coverage-contract-storybook.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/behavioral-summary-format.md`](../../../docs/behavioral-summary-format.md). For how a story is used as a contract, see [`docs/contracts.md`](../../../docs/contracts.md).
