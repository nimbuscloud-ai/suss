/**
 * The project root when nothing declares one.
 *
 * Resolution from anywhere inside a tree finds the same `node_modules`,
 * and a recursive reader pointed at the directory every file shares
 * reaches all of them, so the deepest common directory serves both.
 */

import path from "node:path";

/** The deepest directory containing every file, or undefined when they share no absolute root. */
export function commonDirectoryOf(
  files: ReadonlyArray<string>,
): string | undefined {
  const absolute = files.filter((f) => path.isAbsolute(f));
  const first = absolute[0];
  if (first === undefined) {
    return undefined;
  }

  let shared = path.dirname(first).split(path.sep);
  for (const file of absolute.slice(1)) {
    const parts = path.dirname(file).split(path.sep);
    let i = 0;
    while (i < shared.length && i < parts.length && shared[i] === parts[i]) {
      i += 1;
    }
    shared = shared.slice(0, i);
  }

  const joined = shared.join(path.sep);
  return joined.length > 1 ? joined : undefined;
}
