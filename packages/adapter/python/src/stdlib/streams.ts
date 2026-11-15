/**
 * Python's own output streams as stream-write chains, which the adapter
 * runs over every body without a pack, since the standard library
 * provides `print` and `sys.stdout`. They make the same `stream-write`
 * effect the Node pack makes of `console.log`, on an `io` binding that
 * says which stream. The stream seeds read the paths from here too.
 */

import { compile, global, streamWrites } from "@suss/recognize";

export const PYTHON_STREAM_RECOGNITION = "python-stdlib";

const STREAMS = { "sys.stdout": "stdout", "sys.stderr": "stderr" };

/** The paths that spell one of the process's output streams. */
export const STREAM_PATHS = Object.keys(STREAMS);

export const STREAM_WRITES = [
  streamWrites({ streams: STREAMS, client: global(...STREAM_PATHS) })
    .methods({ write: { to: "receiver" } })
    .example('sys.stderr.write("failed\\n")'),
  /** `print(x, file=sys.stderr)` writes to the stream `file` spells; any other `file` is a file, not a stream. */
  streamWrites({ streams: STREAMS, client: global("print") })
    .methods({ print: { to: "stdout", streamAt: { keyword: "file" } } })
    .example('print("done")'),
];

/** The chains as the hooks the dispatch hands each call. */
export const streamWriteHooks = STREAM_WRITES.map((chain) =>
  compile(chain.declared, PYTHON_STREAM_RECOGNITION),
);
