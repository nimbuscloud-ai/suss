// A small Storybook CSF3 fixture — two stories of a Button component.
// Used by @suss/stub-storybook to verify story extraction produces one
// BehavioralSummary per named export with args surfaced as inputs.

import type { Button } from "../react/Button";

const meta = {
  component: Button,
};
export default meta;

export const Primary = {
  args: {
    label: "Click me",
  },
};

export const Disabled = {
  args: {
    label: "Can't click",
    disabled: true,
  },
};

