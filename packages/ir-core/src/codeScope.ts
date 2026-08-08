/**
 * One convention for the source directory a deployable unit is built
 * from, and one test for whether a file is inside it.
 *
 * A deploy template gives a directory per unit, and a summary stores it
 * as `metadata.codeScope.path`. Producers write that path and the
 * checker reads it back as a prefix test, so the two sides have to
 * agree on whether it ends in a slash. Normalizing it in one place is
 * what keeps them agreeing. The test also has to stop at a segment
 * boundary, or `src/foo` would cover `src/foobar` and a handler would
 * pair with the wrong function.
 */

/**
 * The canonical form of a code-scope directory: no leading `./`, no
 * trailing slash, no surrounding whitespace. An empty result means the
 * scope is the project root.
 */
export function codeScopePath(raw: string): string {
  return raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Whether a project-relative file is inside a code scope. Matching stops
 * at a segment boundary, so `src/foo` covers `src/foo/a.ts` and never
 * `src/foobar/a.ts`. A scope that is the project root covers every file.
 *
 * Both arguments go through `codeScopePath`, so a scope stored with a
 * trailing slash and one stored without it are read the same way.
 */
export function fileInCodeScope(file: string, scope: string): boolean {
  const prefix = codeScopePath(scope);
  if (prefix === "" || prefix === ".") {
    return true;
  }
  const path = codeScopePath(file);
  return path === prefix || path.startsWith(`${prefix}/`);
}
