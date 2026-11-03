import { toolConfig } from "../../vitest.shared.js";

export default toolConfig({
  // The sweep runs four thousand fixpoints in one case.
  testTimeout: 300_000,
});
