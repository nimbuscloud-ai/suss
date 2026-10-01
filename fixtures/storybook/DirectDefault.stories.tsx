// `export default { ... }` directly, without any intermediate const.
import Greeting from "../react/Greeting";

export default {
  component: Greeting,
};

export const Hello = {
  args: { name: "world" },
};
