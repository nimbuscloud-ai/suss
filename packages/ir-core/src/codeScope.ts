/**
 * One convention for the source directory a deployable unit is built
 * from, one test for whether a file is inside it, and one reading of
 * the handler string that says which code the platform calls.
 *
 * A deploy template gives a directory per unit, and a summary stores it
 * as `metadata.codeScope.path`. Producers write that path and the
 * checker reads it back as a prefix test, so the two sides have to
 * agree on whether it ends in a slash. The test also has to stop at a
 * segment boundary, or `src/foo` would cover `src/foobar` and a handler
 * would pair with the wrong function. A CloudFormation template and a
 * Terraform configuration spell a handler the same way, so they read it
 * through the same function rather than through two of them.
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

export interface ParsedHandler {
  modulePath: string;
  exportName: string;
}

/**
 * Split a handler string into its module path and exported symbol.
 * The final dot separates them: `"src/handlers/confirmToken.handler"` →
 * `{ modulePath: "src/handlers/confirmToken", exportName: "handler" }`.
 * Returns null when there's no dot, since there's no export to bind to.
 */
export function parseHandler(handler: string): ParsedHandler | null {
  const trimmed = handler.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return null;
  }
  return {
    modulePath: trimmed.slice(0, lastDot),
    exportName: trimmed.slice(lastDot + 1),
  };
}
