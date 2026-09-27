// The `suss` executable. It sets process.exitCode instead of calling
// process.exit, so node finishes writing stdout before the process ends.

import { startWithEnoughHeap } from "./heapSize.js";

async function run(): Promise<void> {
  // Loaded only after the heap is settled, so a process that starts
  // itself again has not paid for loading the compiler twice.
  const { runCli } = await import("./run.js");

  // `suss inspect | head` closes the pipe once head has read its lines. The
  // user asked for that, so the run ends quietly instead of printing a trace.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") {
      throw error;
    }
  });

  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (err: unknown) {
    // Print the stack alone. Its first line already starts with "Error: ".
    const detail =
      err instanceof Error
        ? (err.stack ?? `Error: ${err.message}`)
        : `Error: ${String(err)}`;
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
  }
}

startWithEnoughHeap(run);
