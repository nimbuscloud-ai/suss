import { toolConfig } from "../../vitest.shared.js";

export default toolConfig({
  include: ["test/**/*.test.ts"],
  // The hook tests spawn node and the built suss several times each,
  // and a cold first spawn pays for loading the adapter.
  testTimeout: 120_000,
  hookTimeout: 120_000,
});
