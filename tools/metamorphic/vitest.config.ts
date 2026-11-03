import { toolConfig } from "../../vitest.shared.js";

export default toolConfig({
  // Every case runs a whole extraction, and the first one in a worker
  // pays for parsing the default libraries.
  testTimeout: 60_000,
});
