/**
 * docsIncludes.mjs: replace each `<!--@include: path-->` in a docs page with
 * the text it points to, the way VitePress does when it builds the page. A
 * script that reads a page's markdown then sees the text a visitor sees.
 *
 * The path is relative to the page, or to docs/ when it starts with `@/`.
 * `#name` after it takes one region of the file, and `{start,end}` a range
 * of lines. An included markdown file loses its frontmatter, and includes
 * inside included text are expanded too. VitePress leaves an include it
 * cannot find as it was; this throws, so a check fails instead.
 */

import fs from "node:fs";
import path from "node:path";

const INCLUDE = /<!--\s*@include:\s*(.*?)\s*-->/g;

const TARGET = /^(.*?)(?:#([\w-]+))?(?:\{(\d*),(\d*)\})?$/;

/** The region markers VitePress recognizes in markdown and in code. */
const REGION_MARKERS = [
  /^<!-- #?(end)?region ([\w*-]+) -->$/,
  /^\/\/ ?#?(end)?region ([\w*-]+)$/,
  /^# ?(end)?region ([\w*-]+)$/,
];

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/**
 * @param {string} line
 * @returns {{ end: boolean, name: string } | null}
 */
function regionMarker(line) {
  for (const marker of REGION_MARKERS) {
    const match = line.trim().match(marker);
    if (match !== null) {
      return { end: match[1] !== undefined, name: match[2] };
    }
  }
  return null;
}

/**
 * @param {string[]} lines
 * @param {string} name
 * @param {string} file
 * @returns {string[]}
 */
function regionLines(lines, name, file) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const marker = regionMarker(lines[i]);
    if (marker === null || marker.name !== name) {
      continue;
    }

    if (!marker.end && start === -1) {
      start = i + 1;
      continue;
    }

    if (marker.end && start !== -1) {
      return lines.slice(start, i);
    }
  }
  throw new Error(`${file} has no region named ${name}`);
}

/**
 * @param {string} target
 * @param {string} file
 * @param {string} srcDir
 * @returns {string}
 */
function includedText(target, file, srcDir) {
  const [, filePath, region, first, last] = target.match(TARGET) ?? [];
  const included = filePath.startsWith("@")
    ? path.join(srcDir, filePath.replace(/^@\/?/, ""))
    : path.join(path.dirname(file), filePath);

  if (!fs.existsSync(included)) {
    throw new Error(
      `${file} includes ${target}, and there is no file at ${included}`,
    );
  }

  const content = fs.readFileSync(included, "utf8");
  if (region === undefined && first === undefined) {
    const text = included.endsWith(".md")
      ? content.replace(FRONTMATTER, "")
      : content;
    return expandIncludes(text, included, srcDir);
  }

  let lines = content.split(/\r?\n/);
  if (region !== undefined) {
    lines = regionLines(lines, region, included);
  }
  if (first !== undefined) {
    const from = first === "" ? 0 : Number(first) - 1;
    const to = last === "" ? lines.length : Number(last);
    lines = lines.slice(from, to);
  }
  return expandIncludes(lines.join("\n"), included, srcDir);
}

/**
 * @param {string} source the markdown of `file`
 * @param {string} file the page's path, which relative includes resolve against
 * @param {string} srcDir the docs directory, which `@/` includes resolve against
 * @returns {string}
 */
export function expandIncludes(source, file, srcDir) {
  return source.replace(INCLUDE, (_comment, target) =>
    includedText(target, file, srcDir),
  );
}
