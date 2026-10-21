// Writes to the process's output streams: through console, through
// process.stdout and process.stderr, and through a stream handed in.

export function report(total: number): void {
  console.log("total", total);
  console.info({ total });
  console.table([{ total }]);
  console.dir({ total }, { depth: 1 });
  console.warn("slow report");
  console.trace("report traced");
}

export function emitJson(row: { id: string; total: number }): void {
  process.stdout.write(JSON.stringify(row));
  process.stderr.write(`wrote ${row.id}\n`);
}

function writeLine(out: NodeJS.WritableStream, line: string): void {
  out.write(`${line}\n`);
}

export function progress(done: number): void {
  writeLine(process.stdout, `done ${done}`);
}

function writeEither(out: NodeJS.WriteStream, line: string): void {
  out.write(line);
}

export function notify(failed: boolean): void {
  writeEither(failed ? process.stderr : process.stdout, "finished");
}

export function viaStderr(): void {
  writeEither(process.stderr, "warned");
}

// Nothing calls this, so the stream behind the parameter is unknown.
export function logTo(sink: Console, message: string): void {
  sink.log(message);
}
