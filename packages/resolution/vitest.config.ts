import { packageConfig } from "../../vitest.shared.js";

export default packageConfig({
  thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
});
