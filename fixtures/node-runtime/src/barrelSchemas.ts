// t3's createEnv through a project module that re-exports it, in a file
// whose text never mentions the library.

import { z } from "zod";

import { createEnv } from "./envLib.js";

export function reexported() {
  return createEnv({
    server: { REEXPORTED_KEY: z.string() },
    runtimeEnv: process.env,
  });
}
