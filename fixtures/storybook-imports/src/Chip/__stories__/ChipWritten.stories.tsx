// The component is written inside a type assertion, and the args use a
// key the file computes, a key nothing in the file settles, and values
// inside `as const` and parentheses.
import { Chip } from "@ui/Chip/Chip";

declare const chosen: string;

const sizeKey = "size";

export default { component: Chip as never };

export const Written = {
  args: {
    [sizeKey]: "md",
    [chosen]: "unread",
    label: "Written" as const,
    count: (2),
  },
};
