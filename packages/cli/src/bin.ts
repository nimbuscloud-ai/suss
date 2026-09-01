// bin.ts: bin entry. Forwards process.argv to the testable runCli
// dispatch and sets the exit code it returns. It sets the code rather
// than calling process.exit so node finishes writing stdout first.

import { runCli } from "./run.js";

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // The stack says where; its first line already reads "Error: ...".
    const detail =
      err instanceof Error
        ? (err.stack ?? `Error: ${err.message}`)
        : `Error: ${String(err)}`;
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
  },
);
