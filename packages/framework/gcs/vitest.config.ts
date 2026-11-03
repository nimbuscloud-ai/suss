import { packageConfig } from "../../../vitest.shared.js";

export default packageConfig({
  thresholds: {
    // Many recognizer branches are defensive null/shape checks for
    // malformed AST inputs that real ts-morph never produces; testing
    // them adds little value. 70% covers the meaningful branches.
    branches: 70,
  },
});
