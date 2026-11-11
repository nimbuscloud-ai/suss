/**
 * Writes to the process's own output streams, declared as chains. Each
 * one becomes a `stream-write` interaction on an `io` binding that says
 * which stream.
 *
 * `console` and `process.stdout` are recognized by how they are spelled,
 * since nothing imports or declares them, and a stream handed in through
 * a parameter is one the rules followed there. A parameter declared as a
 * `Console` or a stream writes to no stream in particular, since the
 * source does not say which one it was made with. There are two chains
 * because a `Console` parameter is read for the console methods and a
 * stream parameter for `write`, never the other way round. The README
 * has the rest.
 */

import { anyOf, compile, global, streamWrites, typed } from "@suss/recognize";
import { GLOBAL_MODULE } from "@suss/resolution";

import { RECOGNITION } from "./configBinding.js";

/** The streams `process` has, as a program spells them, and the stream each is. */
const PROCESS_STREAM_NAMES = {
  "process.stdout": "stdout",
  "process.stderr": "stderr",
};

/** The streams `process` has, as a program spells them. */
export const PROCESS_STREAMS = Object.keys(PROCESS_STREAM_NAMES);

const STREAM_WRITES = streamWrites({
  streams: PROCESS_STREAM_NAMES,
  client: anyOf(
    global(...PROCESS_STREAMS),
    typed({
      from: [GLOBAL_MODULE],
      named: ["NodeJS.WriteStream", "NodeJS.WritableStream"],
    }),
  ),
})
  .methods({ write: { to: "receiver" } })
  .example('process.stdout.write("done\\n")');

/** Node's own split: these go to stdout, and the last three to stderr. */
const CONSOLE_WRITES = streamWrites({
  streams: {},
  client: anyOf(
    global("console"),
    typed({ from: [GLOBAL_MODULE], named: ["Console"] }),
  ),
})
  .methods({
    log: { to: "stdout" },
    info: { to: "stdout" },
    debug: { to: "stdout" },
    table: { to: "stdout" },
    dir: { to: "stdout" },
    warn: { to: "stderr" },
    error: { to: "stderr" },
    trace: { to: "stderr" },
  })
  .example('console.error("failed")');

/** The stream writes this pack declares. */
export const STREAM_WRITE_MATCHES = [CONSOLE_WRITES, STREAM_WRITES];

/** The declared stream writes, as the hooks the adapter calls on every call. */
export const streamWriteRecognizers = STREAM_WRITE_MATCHES.map((match) =>
  compile(match.declared, RECOGNITION),
);
