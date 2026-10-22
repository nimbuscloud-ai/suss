/**
 * The app's source files, read once, for the grep rival.
 */

import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
]);

const SKIPPED = new Set([
  "node_modules",
  "dist",
  "build",
  "vendor",
  "coverage",
  "tmp",
  "log",
  "venv",
]);

export class SourceTree {
  readonly files: string[] = [];
  private readonly texts = new Map<string, string>();

  constructor(readonly root: string) {
    this.walk(root);
  }

  private walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walk(full);
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        this.files.push(full);
      }
    }
  }

  text(file: string): string {
    const known = this.texts.get(file);
    if (known !== undefined) {
      return known;
    }
    const read = fs.readFileSync(file, "utf8");
    this.texts.set(file, read);
    return read;
  }

  /** The files whose path ends with this relative one, for a path a summary or a span wrote. */
  endingWith(relative: string): string[] {
    const suffix = `${path.sep}${relative.replace(/^\.?\//, "")}`;
    return this.files.filter((file) => file.endsWith(suffix));
  }

  /** A path relative to the root when it is under it, for a report line. */
  relative(file: string): string {
    return file.startsWith(this.root) ? path.relative(this.root, file) : file;
  }
}
