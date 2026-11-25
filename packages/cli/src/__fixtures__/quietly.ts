import { runCli } from "../run.js";

/** Run the CLI without its output landing in the test log. */
export async function quietly(argv: string[]): Promise<number> {
  const swallow = (() => true) as typeof process.stdout.write;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = swallow;
  process.stderr.write = swallow;
  try {
    return await runCli(argv);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}
