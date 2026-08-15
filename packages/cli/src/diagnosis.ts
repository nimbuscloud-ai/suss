// diagnosis.ts: the one shape for telling a user why a run produced
// nothing and what to do about it: what happened, then why, then the
// fix, pastable whenever the CLI can build the command.

export interface Diagnosis {
  /** What happened, readable on its own. Always the first line. */
  problem: string;
  /** Why, in one line. */
  cause?: string;
  /** What to do about it. */
  fix?: Fix;
}

export type Fix =
  /** A command the user can paste, with an optional trailing note. */
  | { command: string; note?: string }
  /** A sentence, for when no single command covers the fix. */
  | { advice: string };

export function renderDiagnosis(d: Diagnosis, indent = "  "): string[] {
  const lines = [`${indent}${d.problem}`];
  if (d.cause !== undefined) {
    lines.push(`${indent}${d.cause}`);
  }
  if (d.fix !== undefined) {
    lines.push(`${indent}${renderFix(d.fix)}`);
  }
  return lines;
}

function renderFix(fix: Fix): string {
  if ("command" in fix) {
    const note = fix.note !== undefined ? `  (${fix.note})` : "";
    return `Try: ${fix.command}${note}`;
  }
  return fix.advice;
}
