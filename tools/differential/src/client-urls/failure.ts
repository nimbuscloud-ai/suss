import type { SpawnSyncReturns } from "node:child_process";

/**
 * Null when the process ran and exited 0. Otherwise the first and last
 * lines it wrote to stderr, since Ruby puts the message first and Python
 * puts it last, or why it could not start.
 */
export function failureOf(run: SpawnSyncReturns<string>): string | null {
  if (run.error === undefined && run.status === 0) {
    return null;
  }

  const lines = (run.stderr?.trim() || run.error?.message || "").split("\n");
  const first = lines[0]?.trim() || `exit code ${run.status}`;
  const last = lines.at(-1)?.trim() ?? "";
  return lines.length > 1 ? `${first} ... ${last}` : first;
}
