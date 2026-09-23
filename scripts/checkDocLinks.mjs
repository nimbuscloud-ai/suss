#!/usr/bin/env node
/**
 * checkDocLinks.mjs: every markdown link resolves, anchors included.
 * Links broke quietly when files were renamed and nothing noticed until a
 * reader did, which is #252.
 *
 * A relative link resolves against the file it is in. A site-root link
 * such as `/reference/cli/ask` resolves against the VitePress site in
 * docs/, the way the built site serves it. A link to a directory lands on
 * that directory's index page, so its anchor is checked against that page.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  "grammar",
  // The link checker's own fixtures break links on purpose.
  "__fixtures__",
]);

/** The pages a server shows for a directory: VitePress's first, then GitHub's. */
const INDEX_PAGES = ["index.md", "README.md"];

function markdownFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        markdownFiles(path.join(dir, entry.name), found);
      }
      continue;
    }
    if (entry.name.endsWith(".md")) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/** Inline links and image sources, skipping fenced code blocks. */
function linksIn(source) {
  const links = [];
  let inFence = false;
  for (const line of source.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const withoutCode = line.replace(/`[^`]*`/g, "");
    for (const match of withoutCode.matchAll(/!?\[[^\]]*\]\(([^()\s]+)\)/g)) {
      links.push(match[1]);
    }
  }
  return links;
}

function hasScheme(link) {
  return /^[a-z][a-z0-9+.-]*:/i.test(link);
}

/** The anchor GitHub gives a heading: lowercased, punctuation dropped, spaces to hyphens. */
function slugOf(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function anchorsOf(file) {
  const anchors = new Set();
  const seen = new Map();
  let inFence = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const heading = inFence ? null : line.match(/^#{1,6}\s+(.*)$/);
    if (heading === null) {
      continue;
    }
    const explicit = heading[1].match(/\{#([^}]+)\}\s*$/);
    if (explicit !== null) {
      anchors.add(explicit[1].toLowerCase());
    }
    const base = slugOf(heading[1].replace(/\{#[^}]+\}\s*$/, ""));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count}`;
    anchors.add(slug);
    // VitePress collapses hyphen runs where GitHub keeps them; accept both.
    anchors.add(slug.replace(/-{2,}/g, "-"));
  }
  return anchors;
}

function isFile(candidate) {
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
}

function indexPageOf(directory) {
  return INDEX_PAGES.map((page) => path.join(directory, page)).find(isFile);
}

/** A relative target is a file, or a directory that has an index page. */
function relativeTarget(file, target) {
  if (target === "") {
    return file;
  }
  const resolved = path.resolve(path.dirname(file), target);
  if (isFile(resolved)) {
    return resolved;
  }
  if (fs.existsSync(resolved)) {
    return indexPageOf(resolved) ?? resolved;
  }
  return undefined;
}

/**
 * A site-root target is a page with cleanUrls on, a directory's index
 * page, or a static file under public/.
 */
function siteTarget(siteRoot, target) {
  const page = target.replace(/\.html$/, "").replace(/^\/+/, "");
  const candidates = [
    path.join(siteRoot, `${page.replace(/\/+$/, "")}.md`),
    ...INDEX_PAGES.map((index) => path.join(siteRoot, page, index)),
    path.join(siteRoot, "public", page),
    path.join(siteRoot, page),
  ];
  return candidates.find(isFile);
}

/** Every link under `root` that points at a missing file or heading. */
export function findBrokenLinks({ root, siteRoot = path.join(root, "docs") }) {
  const problems = [];
  for (const file of markdownFiles(root)) {
    const where = path.relative(root, file);
    for (const link of linksIn(fs.readFileSync(file, "utf8"))) {
      if (hasScheme(link)) {
        continue;
      }
      const [target, anchor] = link.split("#");
      const resolved = target.startsWith("/")
        ? siteTarget(siteRoot, target)
        : relativeTarget(file, target);
      if (resolved === undefined) {
        problems.push(`${where}: ${link} points at a file that does not exist`);
        continue;
      }
      if (
        anchor !== undefined &&
        anchor !== "" &&
        resolved.endsWith(".md") &&
        !anchorsOf(resolved).has(anchor.toLowerCase())
      ) {
        problems.push(
          `${where}: ${link} points at a heading ${path.relative(root, resolved)} does not contain`,
        );
      }
    }
  }
  return problems;
}

function main() {
  const problems = findBrokenLinks({ root: ROOT });
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    console.error(`\n${problems.length} markdown links point at nothing.`);
    process.exit(1);
  }
  console.log("Every markdown link resolves, anchors included.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
