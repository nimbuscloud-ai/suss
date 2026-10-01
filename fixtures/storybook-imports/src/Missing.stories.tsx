// The import leads to a module that is not on disk, so the component's
// declaration cannot be found.
import { Badge } from "@ui/Badge/Badge";

export default { component: Badge };

export const Default = {
  args: { tone: "info" },
};
