/**
 * What a name written more than once comes down to.
 *
 * Each adapter reads writes out of a different parser, so the reading
 * stays with the adapter and the decision lives here, over a
 * description of the writes that nothing parser-shaped reaches. While
 * each adapter decided for itself, the same source resolved in one
 * language and not in another.
 *
 * Whether the writes run in order is the one question this cannot
 * answer: it needs the language's statement structure. The adapter
 * works that out and passes the answer in.
 */

/** One write to a name, in the order it is written. */
export interface NameWrite {
  /**
   * The key of the value written, or null when the write states no
   * value of its own, as `count += 1` and `index++` do.
   */
  value: string | null;
  /** Whether a later write is expected to replace this value: `null`, `undefined`, `None`, `nil`. */
  placeholder: boolean;
  /**
   * The value's source text when it is built where it is written, so a
   * call, a `new`, or an object or array literal. Null otherwise.
   */
  construction: string | null;
  /**
   * Whether the value is a call on the name being written, `query =
   * query.filter(x)`, which leaves the name what the other writes gave
   * it with a method applied. A call returning something of another kind
   * is not told apart, and a narrowing written through a second name,
   * `tmp = query.limit(1)` then `query = tmp`, is not recognized.
   */
  narrowsName: boolean;
}

/**
 * The value a name comes down to, or null when the writes leave it
 * undecided.
 *
 * With `ordered`, every write runs once in the order it is written and
 * nothing reads the name in between, so the last write is what a reader
 * sees. Otherwise the writes are candidates the caller cannot order,
 * and they settle the name only when they all build the same thing.
 *
 * A write with no value of its own puts a hole in the sequence, and then
 * no write can be called the last one. A narrowing write is set aside.
 */
export function valueLeftByWrites(
  writes: readonly NameWrite[],
  ordered: boolean,
): string | null {
  const deciding = writes.filter((write) => !write.narrowsName);
  const left = deciding.length === 0 ? writes : deciding;
  if (left.some((write) => write.value === null)) {
    return null;
  }
  if (ordered) {
    return left[left.length - 1]?.value ?? null;
  }
  return sharedConstruction(left);
}

/**
 * The value every write builds, when they agree on one. A placeholder
 * write is set aside first, and a name written only as a placeholder
 * settles on nothing rather than on one of them.
 */
function sharedConstruction(writes: readonly NameWrite[]): string | null {
  let settled: NameWrite | null = null;
  for (const write of writes) {
    if (write.placeholder) {
      continue;
    }
    if (write.construction === null) {
      return null;
    }
    if (settled !== null && write.construction !== settled.construction) {
      return null;
    }
    settled = write;
  }
  return settled?.value ?? null;
}
