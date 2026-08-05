// bin.ts — bin entry. Forwards process.argv to the testable runCli
// dispatch and converts the returned exit code to process.exit.

import { runCli } from "./run.js";

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    // The stack carries the message and says where. Printing only the
    // message made a crash undiagnosable from the outside.
    const detail =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`Error: ${detail}\n`);
    process.exit(1);
  },
);
