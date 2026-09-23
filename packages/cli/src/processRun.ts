/**
 * Runs a child process and collects its output.
 *
 * Guided init runs npm and suss itself as child processes. The user sees
 * each one as a spinner line. The output is collected instead of streamed,
 * so when a command fails, init can show its last few lines without
 * scrolling the prompts off the screen.
 */

import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  output: string;
}

/**
 * Runs `bin` and resolves with its exit code and its stdout and stderr
 * interleaved in the order they were printed.
 *
 * `onLine` is called with each line as it arrives, so a spinner can show
 * how far a slow command has got. Cursor moves and colour codes are
 * removed first, because npm redraws its progress bar in place and those
 * escape sequences would corrupt the spinner's line.
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
