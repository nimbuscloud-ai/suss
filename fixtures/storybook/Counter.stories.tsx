// Exercises additional CSF3 shapes:
//   - `export default { ... }` direct (no intermediate const).
//   - `{...} satisfies Meta<typeof Counter>` on both meta and stories.
//   - A story with no `args` at all.
//   - A shorthand property in args.

import type { Counter } from "../react/Counter";

type Meta<_T> = Record<string, unknown>;
type StoryObj<_T> = Record<string, unknown>;

const label = "primary";

export default {
  component: Counter,
} satisfies Meta<typeof Counter>;

export const Default = {
  args: {
    label,
    initial: 0,
  },
} satisfies StoryObj<typeof Counter>;

export const NoArgs = {} satisfies StoryObj<typeof Counter>;
