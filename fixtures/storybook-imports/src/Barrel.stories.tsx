// The component is renamed on import and re-exported through a barrel.
import { Chip as UiChip } from "./index";

export default { component: UiChip };

export const Large = {
  args: { label: "Chip", size: "md" },
};
