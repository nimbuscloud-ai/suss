import { packageConfig } from "../../../vitest.shared.js";

export default packageConfig({
  thresholds: {
    // Malformed-AST branches are defensive checks against shapes
    // ts-morph never produces; 70% covers the meaningful ones.
    branches: 70,
  },
});
