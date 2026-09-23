/**
 * The source directory a deployable unit is built from, and the handler
 * string that says which code the platform calls.
 *
 * A deploy template gives each unit a directory, and a summary stores it
 * as `metadata.codeScope.path`. Producers write that path and the
 * checker reads it back as a prefix test, so both sides normalize it
 * through `codeScopePath` and agree on the trailing slash. The test
 * stops at a segment boundary, or `src/foo` would cover `src/foobar` and
 * a handler would pair with the wrong function. CloudFormation and
 * Terraform write a handler the same way, so both read it through
 * `parseHandler`.
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
 * Both arguments are normalized with `codeScopePath`, so a trailing
 * slash on either one makes no difference.
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
