// A decorator on the meta can read an arg the component never takes, and
// a story's render function decides which props the component gets.
import { Chip } from "../Chip";

const withRoute = (Story: () => unknown) => Story();

export default {
  component: Chip,
  decorators: [withRoute],
  args: { routePath: "/orders" },
};

export const Routed = {
  args: { label: "Orders" },
};

export const Custom = {
  args: { label: "Custom" },
  render: (args: { label: string }) => <Chip label={args.label} size="md" />,
};
