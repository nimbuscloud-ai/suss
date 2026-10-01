// Args on the meta reach every story. A story's own arg of the same name
// wins.
import { Chip } from "../Chip";

const meta = {
  component: Chip,
  args: { label: "Shared", size: "sm" },
};
export default meta;

export const Plain = {};

export const Medium = {
  args: { size: "md" },
};
