import { packageConfig } from "../../../vitest.shared.js";

export default packageConfig({
  thresholds: {
    // Many recognizer branches are defensive null/shape checks for
    // malformed AST inputs that real ts-morph never produces.
    branches: 70,
  },
});
