// The meta spreads a shared base and then writes args of its own, which
// replace the base's args in the object Storybook reads.
import { Chip } from "../Chip";

const shared = { component: Chip, args: { label: "Shared", size: "sm" } };

export default { ...shared, args: { label: "Own" } };

export const Plain = {};
