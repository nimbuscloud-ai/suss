// The component is read off a namespace import by a computed key.
import * as Icons from "./icons";

const pick = "Star";

export default { component: Icons[pick] };

export const Default = {
  args: { size: "md" },
};
