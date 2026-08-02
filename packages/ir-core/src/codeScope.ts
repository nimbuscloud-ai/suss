// codeScope.ts — one convention for the source directory a deployable
// unit is built from, and one test for whether a file sits inside it.
//
// A deploy template names a directory per unit and a summary carries it
// as `metadata.codeScope.path`. Producers write it and the checker
// reads it back as a prefix test, so the two sides have to agree on
// whether that path ends in a slash. They did not: one producer
// preserved whatever was authored, another appended a slash always, and
// a third stripped it, while the readers spelled the test as
// `startsWith` twice and `includes` once. A prefix test that ignores
// the segment boundary is what let a handler pair with the wrong
// function, so the convention and the test belong together.

/**
 * The canonical form of a code-scope directory: no leading `./`, no
 * trailing slash, no surrounding whitespace. An empty result means the
 * scope names the project root.
 */
export function codeScopePath(raw: string): string {
  return raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Whether a project-relative file sits inside a code scope. Matching
 * stops at a segment boundary, so `src/foo` covers `src/foo/a.ts` and
 * never `src/foobar/a.ts`. A scope naming the project root covers
 * every file.
 *
 * Both arguments pass through `codeScopePath`, so a scope stored under
 * either of the older trailing-slash conventions still reads correctly.
 */
export function fileInCodeScope(file: string, scope: string): boolean {
  const prefix = codeScopePath(scope);
  if (prefix === "" || prefix === ".") {
    return true;
  }
  const path = codeScopePath(file);
  return path === prefix || path.startsWith(`${prefix}/`);
}
