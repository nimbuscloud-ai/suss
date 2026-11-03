// The meta spreads a base that a function returning its argument made.
// One story's render function comes from a factory, and another's is a
// named function expression.
import { Chip } from "../Chip";

function defineMeta<T>(meta: T): T {
  return meta;
}

function renderSized(size: "sm" | "md") {
  return (args: { label: string }) => <Chip {...args} size={size} />;
}

const base = defineMeta({ component: Chip, args: { label: "Made" } });

export default { ...base, title: "Chip/Made" };

export const Plain = {};

export const Sized = {
  render: renderSized("md"),
};

export const Named = {
  render: function Render(args: { label: string }) {
    return <Chip {...args} size="sm" />;
  },
};
