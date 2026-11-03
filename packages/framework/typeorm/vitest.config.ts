import { packageConfig } from "../../../vitest.shared.js";

export default packageConfig({
  thresholds: {
    // Many branches are defensive null/shape checks for AST inputs
    // ts-morph never actually produces; testing them adds little value.
    branches: 70,
  },
});
