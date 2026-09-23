// The `suss` executable. It sets process.exitCode instead of calling
// process.exit, so node finishes writing stdout before the process ends.

import { runCli } from "./run.js";

// `suss inspect | head` closes the pipe once head has read its lines. The
// user asked for that, so the run ends quietly instead of printing a trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") {
    throw error;
  }
});

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // Print the stack alone. Its first line already starts with "Error: ".
    const detail =
      err instanceof Error
        ? (err.stack ?? `Error: ${err.message}`)
        : `Error: ${String(err)}`;
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
  },
);
