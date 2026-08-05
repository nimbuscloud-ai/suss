// bin.ts — bin entry. Forwards process.argv to the testable runCli
// dispatch and converts the returned exit code to process.exit.

import { runCli } from "./run.js";

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    // The stack says where; its first line already reads "Error: ...".
    const detail =
      err instanceof Error
        ? (err.stack ?? `Error: ${err.message}`)
        : `Error: ${String(err)}`;
    process.stderr.write(`${detail}\n`);
    process.exit(1);
  },
);
