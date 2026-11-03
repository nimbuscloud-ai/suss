import { packageConfig } from "../../../vitest.shared.js";

export default packageConfig({
  // Each test spins up a fresh ts-morph Project to parse the CSF file.
  // Locally this is ~250ms; on CI runners it can hit 5-6s, which busts
  // vitest's default 5000ms per-test timeout. Bump to 30s to cover CI.
  testTimeout: 30_000,
  thresholds: {
    // Defensive "return null" branches in the CSF unwrap helpers
    // (AsExpression fallback, undefined-symbol guards) aren't
    // hit by the current fixture set. They exist because ts-morph
    // can hand back any expression kind, and covering them all
    // would require contrived fixtures with no behavioral value.
    branches: 60,
  },
});
