/**
 * The projects underneath the directory a run was pointed at.
 *
 * Point suss at a folder of services and it reads them as one project,
 * because it resolves imports against the directory it was given. Every
 * import an author wrote against their own project's layout then reaches
 * nothing: a TypeScript alias from `paths`, a Python package one level
 * further down. The run still writes summaries, which is what makes the
 * loss worth saying out loud.
 *
 * Each language marks a project in its own way, so the marker files
 * differ, and what a reader should do about it differs with them.
 */

import fs from "node:fs";
import path from "node:path";

import type { Language } from "./language.js";

/** How far below the root to look. Deeper than this is somebody's vendored tree. */
const MAX_DEPTH = 3;

/** What says "a project starts here", per language. */
const MARKERS: Record<Language, string[]> = {
  typescript: ["tsconfig.json", "jsconfig.json"],
  python: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
  ruby: ["Gemfile"],
};

const SKIPPED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "site-packages",
  "vendor",
]);

/** Paths of the markers below `root`, relative to it, in a stable order. */
export function projectsBelow(root: string, language: Language): string[] {
  const markers = MARKERS[language];
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
      const marker = markers
        .map((name) => path.join(child, name))
        .find((candidate) => fs.existsSync(candidate));
      if (marker !== undefined) {
        found.push(path.relative(root, marker));
        continue;
      }

      walk(child, depth + 1);
    }
  };

  walk(path.resolve(root), 1);
  return found.sort();
}

/** What each language loses, and how to read one project instead. */
const CONSEQUENCE: Record<Language, (first: string) => string> = {
  typescript: (first) =>
    "  suss read the files without them, and an import written against a project's own\n" +
    "  aliases resolves to nothing that way, so whatever it pointed at is missing here.\n" +
    `  Read one project at a time instead: suss extract -p ${first} ...\n`,
  python: (first) =>
    "  suss resolved imports against this directory, so a module written against a\n" +
    "  project's own package root reached nothing and what it declared is missing here.\n" +
    `  Read one project at a time instead: suss extract --dir ${path.dirname(first)} ...\n`,
  ruby: (first) =>
    "  suss read the files as one project, so a class a project loads from its own\n" +
    "  directory reached nothing and what it declared is missing here.\n" +
    `  Read one project at a time instead: suss extract --dir ${path.dirname(first)} ...\n`,
};

/**
 * What to say when a run read a folder of projects as one. Empty when
 * there is nothing to say, so the caller can write it unconditionally.
 */
export function formatProjectsBelow(
  markers: readonly string[],
  language: Language,
): string {
  const first = markers[0];
  if (first === undefined) {
    return "";
  }

  const named = markers.slice(0, 4).join(", ");
  const rest = markers.length > 4 ? `, and ${markers.length - 4} more` : "";
  const subject =
    markers.length === 1
      ? "This directory holds a project"
      : "This directory holds projects";

  return (
    `${subject} suss did not read as one: ${named}${rest}.\n` +
    CONSEQUENCE[language](first)
  );
}
