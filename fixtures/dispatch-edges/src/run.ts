import { withCacheDir } from "./cache.js";
import { runCheck, runInit } from "./commands.js";

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  init: runInit,
  check: runCheck,
};

export async function runCli(args: string[]): Promise<number> {
  return await dispatch(args);
}

async function dispatch(args: string[]): Promise<number> {
  const command = args[0] ?? "";
  const rest = args.slice(1);
  const run = COMMANDS[command];
  if (run === undefined) {
    return 1;
  }
  return await withCacheDir(".cache", () => run(rest));
}
