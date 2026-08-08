import { afterAll } from "vitest";

import { removeTemporaryDirectories } from "./harness.js";

afterAll(() => {
  removeTemporaryDirectories();
});
