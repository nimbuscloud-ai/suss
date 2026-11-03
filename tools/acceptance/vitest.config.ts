import { toolConfig } from "../../vitest.shared.js";

export default toolConfig({
  setupFiles: ["./src/setup.ts"],
  // A cold first spawn pays for loading the adapter and its WASM grammars.
  testTimeout: 120_000,
  // A journey's beforeAll runs the CLI two or three times, which the 10
  // second default does not cover on a busy runner.
  hookTimeout: 120_000,
  // Nothing here imports a source file, so there is no coverage to collect.
});
