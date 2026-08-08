// setup.ts: clear away the directories the journeys wrote into.
//
// Registered as a vitest setup file so no journey has to remember, and
// so a journey that fails still leaves nothing behind.

import { afterAll } from "vitest";

import { removeTemporaryDirectories } from "./harness.js";

afterAll(() => {
  removeTemporaryDirectories();
});
