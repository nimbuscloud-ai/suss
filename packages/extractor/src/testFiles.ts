/**
 * Which files a test pack reads. `suss extract --intent` hands a test
 * pack the files the PRDs list under `coveredBy`, written the way the
 * author wrote them, usually from the repository root. An adapter walks
 * absolute paths, so an entry matches a file on whole path segments from
 * the end: `tests/test_orders.py` matches `/repo/api/tests/test_orders.py`
 * and not `/repo/api/tests/other_test_orders.py`. Every adapter's test
 * discovery goes through this, so the three languages agree on it.
 */

/** Whether the file is on the list. Every file is when there is no list. */
export function isListedTestFile(
  file: string,
  listed: readonly string[] | undefined,
): boolean {
  if (listed === undefined) {
    return true;
  }
  const whole = withForwardSlashes(file);
  return listed.some((entry) => {
    const tail = withForwardSlashes(entry).replace(/^\.\//, "");
    return whole === tail || whole.endsWith(`/${tail}`);
  });
}

/**
 * Whether a file's base name matches one of the runner's patterns, where
 * `*` matches any run of characters: `test_*.py` or `*_spec.rb`.
 */
export function matchesTestFileName(
  file: string,
  patterns: readonly string[],
): boolean {
  const base = withForwardSlashes(file).split("/").pop() ?? "";
  return patterns.some((pattern) => globToRegExp(pattern).test(base));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

function withForwardSlashes(file: string): string {
  return file.replace(/\\/g, "/");
}
