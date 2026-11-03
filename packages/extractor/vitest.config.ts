import { packageConfig } from "../../vitest.shared.js";

export default packageConfig({
  coverageExclude: [
    // framework.ts is pure type declarations, no executable code to cover.
    "src/framework.ts",
  ],
});
