// The component comes in through a path alias the tsconfig declares, from
// a folder beside the story's own.
import { Chip } from "@ui/Chip/Chip";

const meta = { component: Chip };
export default meta;

export const Default = {
  args: { label: "Chip", size: "sm" },
};
