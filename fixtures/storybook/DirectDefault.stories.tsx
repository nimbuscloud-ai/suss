// `export default { ... }` directly, without any intermediate const.
import type { Greeting } from "../react/Greeting";

export default {
  component: Greeting,
};

export const Hello = {
  args: { name: "world" },
};
