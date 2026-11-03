import { toolConfig } from "../../vitest.shared.js";

export default toolConfig({
  // The self-run parses every TypeScript file this workspace ships.
  testTimeout: 120_000,
});
