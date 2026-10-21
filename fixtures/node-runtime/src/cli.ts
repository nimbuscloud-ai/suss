// A command: it reads its flags and arguments, describes the process it
// runs in, and sets an exit code or exits.

import { parseArgs } from "node:util";

export function run(): number {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      verbose: { type: "boolean" },
      output: { type: "string", short: "o" },
    },
  });
  const script = process.argv[1];
  const where = process.cwd();
  console.log(values.output ?? "-", script, where);
  if (values.verbose === true) {
    console.debug(process.platform, process.arch, process.version, process.pid);
  }
  return 0;
}

export function fail(reason: string): void {
  console.error(reason);
  process.exitCode = 2;
}

export function failWith(code: number): void {
  process.exitCode = code;
}

export function abort(): never {
  process.exit(1);
}

export function finish(ok: boolean): void {
  if (!ok) {
    process.exit(3);
  }
  process.exit();
}

export function describeRuntime(): string {
  return `${process.execPath} ${process.execArgv.join(" ")} ${process.ppid}`;
}

process.exitCode = run();
