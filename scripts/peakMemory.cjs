/**
 * Preloaded with `node --require` into a process another script measures.
 * When the process exits, it writes its peak resident memory in bytes to
 * the path in PEAK_MEMORY_FILE. Worker threads share the process, so the
 * figure covers them too.
 */

const fs = require("node:fs");

const file = process.env.PEAK_MEMORY_FILE;
if (file !== undefined && file !== "") {
  process.on("exit", () => {
    fs.writeFileSync(file, String(process.resourceUsage().maxRSS * 1024));
  });
}
