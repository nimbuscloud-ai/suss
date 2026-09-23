/**
 * Terminal colours for the CLI's output.
 *
 * The CLI writes the escape codes itself. It needs five of them, and a
 * colour library would add a dependency to the supply chain for a dozen
 * lines of code.
 *
 * Colour is off when stdout is not a terminal, so output piped to a file
 * or through `grep` stays plain text. It is also off when NO_COLOR is set,
 * because users expect that convention to work.
 */

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

/** Whether colour is on, for a caller that lays out its output differently when it is. */
export const styled = enabled;
