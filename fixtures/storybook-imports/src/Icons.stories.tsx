// The component is a member of a namespace import, and the file also
// exports a value that is not a story.
import * as Icons from "./icons";

export default { component: Icons.Star };

export const Default = {
  args: { size: "sm", onPick() {} },
};

export const sizes = ["sm", "md"];
