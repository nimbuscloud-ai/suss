/**
 * The TypeScript projects underneath the directory a run was pointed at.
 *
 * suss looks for a tsconfig at or above where it is pointed, so a
 * directory holding several services, each with its own tsconfig one
 * level down, matches nothing and the files are read with a synthetic
 * default configuration. That configuration has no `paths`, so a
 * project's own import aliases resolve to nothing, and a route object
 * reached through one is lost. The run still writes summaries, which is
 * what makes the loss worth saying out loud.
 */

import fs from "node:fs";
import path from "node:path";

/** How far below the root to look. Deeper than this is somebody's vendored tree. */
const MAX_DEPTH = 3;

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

const SKIPPED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
]);

/** Paths of the configs below `root`, relative to it, in a stable order. */
export function projectsBelow(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED.has(entry.name)) {
        continue;
      }

      const child = path.join(dir, entry.name);
      const config = CONFIG_NAMES.map((name) => path.join(child, name)).find(
        (candidate) => fs.existsSync(candidate),
      );
      if (config !== undefined) {
        found.push(path.relative(root, config));
        continue;
      }

      walk(child, depth + 1);
    }
  };

  walk(path.resolve(root), 1);
  return found.sort();
}

/**
 * What to say when a run read TypeScript with no configuration of the
 * project's own, and the project has some. Empty when there is nothing
 * to say, so the caller can write it unconditionally.
 */
export function formatProjectsBelow(configs: readonly string[]): string {
  if (configs.length === 0) {
    return "";
  }

  const named = configs.slice(0, 4).join(", ");
  const rest = configs.length > 4 ? `, and ${configs.length - 4} more` : "";
  const subject =
    configs.length === 1
      ? "This directory holds a project"
      : "This directory holds projects";

  return (
    `${subject} suss did not read as one: ${named}${rest}.\n` +
    "  suss read the files without them, and an import written against a project's own\n" +
    "  aliases resolves to nothing that way, so whatever it pointed at is missing here.\n" +
    `  Read one project at a time instead: suss extract -p ${configs[0]} ...\n`
  );
}
