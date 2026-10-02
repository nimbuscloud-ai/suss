// Render functions that pass the component props of their own, spread
// the args in, or render it in a way the reader cannot follow.
import { Chip } from "../Chip";

const Frame = (props: { children?: unknown }) => props.children;
const extra = { size: "sm" as const };

export default {
  component: Chip,
  args: { label: "Orders" },
  render(args: { label: string }) {
    return (
      <Frame>
        <Chip {...args} />
      </Frame>
    );
  },
};

export const Spread = {};

export const Sized = {
  render: ({ ...rest }: { label: string }) => <Chip {...rest} size="md" />,
};

export const Elsewhere = {
  render: (args: { label: string }) => <Frame {...args} />,
};

export const Wrapping = {
  render: () => <Chip label="Orders">{"12"}</Chip>,
};

export const Extra = {
  render: (args: { label: string }) => <Chip {...args} {...extra} />,
};
