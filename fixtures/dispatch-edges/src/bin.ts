import { runCli } from "./run.js";

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
