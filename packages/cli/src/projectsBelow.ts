/**
 * Finds projects underneath the directory a run was given.
 *
 * When suss is pointed at a folder of services, it reads them as one
 * project, because it resolves imports against the directory it was
 * given. Imports written against each project's own layout then resolve
 * to nothing, such as a TypeScript alias from `paths` or a Python package
 * one level further down. The run still writes summaries, so without a
 * warning the user would not know anything is missing.
 *
 * Each language marks a project with different files, and the advice on
 * how to read one project at a time differs by language too.
 */

import fs from "node:fs";
import path from "node:path";

import type { Language } from "./language.js";

/** A project deeper than this is usually vendored code, not one of the user's services. */
const MAX_DEPTH = 3;

/** The files that mark the root of a project, per language. */
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

/** Whether `dir` itself declares a project in `language`. */
export function isProjectIn(dir: string, language: Language): boolean {
  return MARKERS[language].some((name) => fs.existsSync(path.join(dir, name)));
}

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

/** What each language loses when projects are read as one, and how to read one at a time. */
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
 * The warning for a run that read a folder of projects as one. It is an
 * empty string when `markers` is empty, so the caller can write it
 * without checking first.
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
