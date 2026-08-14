#!/usr/bin/env node
// checkDocLinks.mjs: every relative markdown link resolves, anchors included.
// Links broke quietly when files were renamed and nothing noticed until a
// reader did, which is #252. Site-root links are the VitePress site's.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  "grammar",
]);

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

/** A scheme link, or a site-root path VitePress resolves against the site. */
function checkable(link) {
  return !/^[a-z][a-z0-9+.-]*:/i.test(link) && !link.startsWith("/");
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

const problems = [];
for (const file of markdownFiles(ROOT)) {
  for (const link of linksIn(fs.readFileSync(file, "utf8"))) {
    if (!checkable(link)) {
      continue;
    }
    const [target, anchor] = link.split("#");
    const resolved =
      target === "" ? file : path.resolve(path.dirname(file), target);
    if (target !== "" && !fs.existsSync(resolved)) {
      problems.push(
        `${path.relative(ROOT, file)}: ${link} points at a file that does not exist`,
      );
      continue;
    }
    if (
      anchor !== undefined &&
      resolved.endsWith(".md") &&
      !anchorsOf(resolved).has(anchor.toLowerCase())
    ) {
      problems.push(
        `${path.relative(ROOT, file)}: ${link} points at a heading ${path.relative(ROOT, resolved)} does not contain`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  console.error(`\n${problems.length} markdown links point at nothing.`);
  process.exit(1);
}
console.log("Every relative markdown link resolves, anchors included.");
