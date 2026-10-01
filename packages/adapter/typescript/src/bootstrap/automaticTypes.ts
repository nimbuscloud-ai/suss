/**
 * Sets the list of a project's automatic type packages before the first
 * program is built, read from disk the way TypeScript reads it.
 *
 * Left to TypeScript, the list is read through ts-morph's file system,
 * which can report a missing `node_modules/@types` as present once a file
 * there was asked for. Listing it then throws on every program build. The
 * README in this folder has the details.
 */

import { type Project, ts } from "ts-morph";

export function pinAutomaticTypes(project: Project): void {
  const options = project.getCompilerOptions();
  if (options.types !== undefined) {
    return;
  }

  project.compilerOptions.set({
    types: ts.getAutomaticTypeDirectiveNames(options, ts.sys),
  });
}
