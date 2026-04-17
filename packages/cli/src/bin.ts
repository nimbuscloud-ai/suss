// bin.ts — bin entry. Forwards process.argv to the testable runCli
// dispatch and converts the returned exit code to process.exit.

import { runCli } from "./run.js";

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  },
);
