/**
 * The name a call suss could not follow would have to use to be a call
 * into a given function. Neither side knows more than the name, so a
 * call matches every function whose own name ends the same way.
 */

/** The method a name ends in, which is what an unfollowed call would spell. */
export function methodName(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** The method a call as written runs: the last name before its arguments or block. */
export function calledMethod(callee: string): string {
  const head = callee.split(/[({\s]/, 1)[0] ?? callee;
  return head.slice(head.lastIndexOf(".") + 1);
}
