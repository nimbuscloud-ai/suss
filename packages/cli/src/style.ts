// style.ts — terminal styling, off unless the terminal wants it.
//
// No dependency for this. The handful of codes below is the whole of
// what the output needs, and a colour library is a supply-chain
// surface for something a dozen lines can do.
//
// Colour is off when stdout is not a terminal, so piping to a file or
// through `grep` gives plain text, and off when NO_COLOR is set, which
// is the convention users expect to work.

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY === true;

function wrap(open: string, close: string): (text: string) => string {
  return (text) => (enabled ? `[${open}m${text}[${close}m` : text);
}

export const bold = wrap("1", "22");
export const dim = wrap("2", "22");
export const cyan = wrap("36", "39");
export const green = wrap("32", "39");
export const yellow = wrap("33", "39");

/** Whether styling is on, for a caller that wants to lay out differently. */
export const styled = enabled;
