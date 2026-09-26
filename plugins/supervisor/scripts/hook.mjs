/**
 * The command every hook in hooks.json runs: `node hook.mjs <event>`.
 *
 * It reads the event Claude Code writes on stdin, hands it to the
 * handler for that event, and prints what the handler returns. It always
 * exits 0. A supervisor that breaks must not stop the agent, so a
 * failure prints nothing on stdout and one line on stderr, which Claude
 * Code keeps in its debug log.
 */

import { contextFor, handleEvent } from "./events.mjs";

const event = process.argv[2] ?? "";

try {
  const input = JSON.parse(await readStdin());
  const output = await handleEvent(event, input, contextFor(input));
  if (output !== null) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
} catch (error) {
  process.stderr.write(
    `suss ${event} hook: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}
