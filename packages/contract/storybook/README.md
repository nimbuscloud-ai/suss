# @suss/contract-storybook

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package builds suss `BehavioralSummary[]` from [Storybook](https://storybook.js.org/) CSF3 story files. A story is a specification somebody wrote by hand: this component supports this set of props. Reading stories as contracts lets you check whether a component accepts the args every story passes, and whether every branch inferred from the component has a story that reaches it.

## What this package reads

`@suss/contract-storybook` parses `.stories.ts` and `.stories.tsx` files with ts-morph, and reads two things in each one.

The default export gives the component under test. The reader walks the declarations of the default export's symbol, looking for an object literal with a `component` property. That covers `export default { component: Button }`, `const meta = { component: Button }; export default meta;` and `export default { ... } satisfies Meta<typeof Button>`. Parentheses, `as` expressions, and an identifier that points at a local variable are followed through to the literal. A file whose default export never resolves to such an object is skipped, and the rest of the run continues.

Every other named export whose initializer resolves to an object literal is a story. Its `args` object literal becomes the story's arguments, and each property's value is recorded as the source text you wrote. A shorthand property (`{ disabled }`) records its own name.

## What it produces

One `component`-kind summary per named story export:

- `identity.name` is `Component.Story`, with `exportPath` set to the story's export name, and a function-call boundary binding with `transport: "in-process"`, `recognition: "react"`, and the component identifier as the export name.
- One input per arg. The input's `role` is the arg name, and its shape is a `ref` whose name is the arg's source text, so a reader can see the value that was written.
- One default transition whose output is a render of the component. The reader does not evaluate the render, so the rendered tree is left unset.
- `metadata.component.storybook` with the story name, the component name, the args map, and `provenance: "independent"`. The provenance is what lets a story act as a check on an inferred component summary, since it was written separately from the component.
- Confidence is `derived` at `medium`. People write stories, and a story is authoritative about what it covers, but stories do not list everything a component does.

## What it does not read

- **`play` functions.** The sequence of events that drives an interactive story is not recorded.
- **`argTypes`.** Control types and option lists per arg could support stricter type checking, but they are not read today.
- **`decorators` and `parameters`.** These are Storybook runtime setup and do not describe the component's behavior.
- **CSF1 and MDX stories.** CSF3 is the supported format.
- **The component's own module.** The reader keeps the `component` identifier as written and does not follow the import to where the component is defined.
- **Arg values as structured shapes.** An arg's value stays as source text inside a `ref` shape, and is not parsed into a `TypeShape`.

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

The path can be one `.stories.ts[x]` file or a directory, which the CLI searches recursively for story files. The file above produces two summaries, `Button.Primary` and `Button.Disabled`, each with `variant` and `disabled` inputs.

To control the set of files, or the root that relative paths are computed from, call it from code:

```ts
import { generateSummariesFromStories } from "@suss/contract-storybook";

const summaries = generateSummariesFromStories(
  ["src/components/Button.stories.tsx"],
  { projectRoot: process.cwd() },
);
```

## Where it fits in suss

The package depends on `@suss/behavioral-ir` for the IR types it produces and on `@suss/adapter-typescript` for export resolution, with `ts-morph` as a peer dependency. It is the only contract reader that parses TypeScript, because CSF is TypeScript. It still reads a declared artifact, and does not infer behavior from a component's implementation.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../../.github/badges/coverage-contract-storybook.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/reference/summary-format.md`](../../../docs/reference/summary-format.md). For how a story is used as a contract, see [`docs/why/kinds-of-contract.md`](../../../docs/why/kinds-of-contract.md).
