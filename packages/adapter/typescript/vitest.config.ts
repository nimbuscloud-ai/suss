import { packageConfig } from "../../../vitest.shared.js";

export default packageConfig({
  testTimeout: 90_000,
  isolate: false,
  thresholds: {
    lines: 76,
    // Defensive recognizer-dispatch branches (try/catch + null
    // returns + scope-skip) are by nature hard to hit from normal
    // tests. 70% covers everything else meaningfully.
    branches: 70,
    statements: 76,
  },
});
