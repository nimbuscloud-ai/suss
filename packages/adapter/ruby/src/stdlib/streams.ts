/**
 * Ruby's own output streams as stream-write chains, which the adapter
 * runs over every body without a pack, since `Kernel` provides `puts`
 * and the runtime provides `$stdout`. They make the same `stream-write`
 * effect the Node pack makes of `console.log`, on an `io` binding that
 * says which stream. The stream seeds read the paths from here too.
 */

import { compile, global, streamWrites } from "@suss/recognize";

import type { StreamWriteMethod } from "@suss/recognize";

export const RUBY_STREAM_RECOGNITION = "ruby-stdlib";

const STREAMS = {
  $stdout: "stdout",
  STDOUT: "stdout",
  $stderr: "stderr",
  STDERR: "stderr",
};

/** The globals and constants that spell one of the process's output streams. */
export const STREAM_PATHS = Object.keys(STREAMS);

const TO_RECEIVER: StreamWriteMethod = { to: "receiver" };

/** Kernel's own writes, called with no receiver. `abort` with no message exits without printing. */
const KERNEL_WRITES: Record<string, StreamWriteMethod> = {
  puts: { to: "stdout" },
  print: { to: "stdout" },
  warn: { to: "stderr" },
  abort: { to: "stderr", onlyWithArguments: true },
};

/** The names a call with no receiver writes to a stream by. */
export const KERNEL_WRITE_NAMES = Object.keys(KERNEL_WRITES);

export const STREAM_WRITES = [
  streamWrites({ streams: STREAMS, client: global(...STREAM_PATHS) })
    .methods({
      puts: TO_RECEIVER,
      print: TO_RECEIVER,
      write: TO_RECEIVER,
      "<<": TO_RECEIVER,
    })
    .example('$stderr.puts "failed"'),
  streamWrites({ streams: {}, client: global(...KERNEL_WRITE_NAMES) })
    .methods(KERNEL_WRITES)
    .example('puts "done"'),
];

/** The chains as the hooks the dispatch hands each call. */
export const streamWriteHooks = STREAM_WRITES.map((chain) =>
  compile(chain.declared, RUBY_STREAM_RECOGNITION),
);
