// processRun.ts — run a command and collect what it said.
//
// Guided init shells out to npm and to suss itself. Both are shown to
// the person as a spinner line, and both need their output kept rather
// than streamed, so a failure can be reported as its last few lines
// instead of scrolling the prompts away.

import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  output: string;
}

/**
 * stdout and stderr interleaved, since that is how they were printed.
 *
 * `onLine` sees each line as it arrives, which is what lets a spinner
 * say where a slow command has got to rather than only that it is still
 * going. Cursor moves and colour codes are taken out first, because npm
 * redraws its progress bar in place and the escape sequences would
 * corrupt the line the spinner is drawing on.
 */
export function run(
  bin: string,
  args: string[],
  cwd: string,
  onLine?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, shell: false });
    let output = "";
    let pending = "";

    const collect = (chunk: unknown): void => {
      const text = String(chunk);
      output += text;
      if (onLine === undefined) {
        return;
      }
      pending += text;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const clean = stripAnsi(line).trim();
        if (clean !== "") {
          onLine(clean);
        }
      }
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err) => resolve({ code: 1, output: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ANSI = /\[[0-9;?]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
