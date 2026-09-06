#!/usr/bin/env node
/**
 * generateLlmsTxt.ts: write docs/public/llms.txt, the index of the site
 * an agent reads before it fetches any page.
 *
 * Every markdown file under docs/ is a published page, so the list is the
 * docs tree itself. A page with no frontmatter description falls back to
 * the first sentence of its opening paragraph, so a page nobody has given
 * frontmatter still gets a usable line.
 *
 * `npm run docs:build` runs this through `predocs:build`. On its own:
 *
 *   node --experimental-strip-types scripts/generateLlmsTxt.ts
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS_DIR = path.join(ROOT, "docs");
const OUTPUT = path.join(DOCS_DIR, "public", "llms.txt");

const SITE_ORIGIN = "https://nimbuscloud-ai.github.io/suss/";

const SITE_NAME = "suss";

const SITE_SUMMARY =
  "suss reads TypeScript, Python and Ruby, writes down what each endpoint does on every path, and checks that against the clients, specs and infrastructure that depend on it.";

const SKIPPED_DIRECTORIES = new Set([".vitepress", "public", "node_modules"]);

interface Page {
  url: string;
  title: string;
  description: string;
}

function markdownFiles(dir: string, found: string[] = []): string[] {
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

function frontmatter(content: string): string {
  return content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
}

function scalar(block: string, key: string): string | null {
  const match = block.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
  if (!match) {
    return null;
  }

  return match[1].trim().replace(/^["']|["']$/g, "");
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** A paragraph of prose, as opposed to a heading, quote, table, list or embed. */
function isProse(block: string): boolean {
  return block.length > 0 && !/^(#|>|<|```|\||-|\*|\d+\.)/.test(block);
}

function firstSentence(content: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
  const paragraph = body
    .split("\n\n")
    .map((block) => block.trim())
    .find(isProse);

  if (!paragraph) {
    return "";
  }

  const flattened = stripInlineMarkdown(paragraph);
  const end = flattened.search(/[.?!](\s|$)/);
  return end === -1 ? flattened : flattened.slice(0, end + 1);
}

function readPage(file: string): Page {
  const content = fs.readFileSync(file, "utf8");
  const block = frontmatter(content);
  const relative = path.relative(DOCS_DIR, file).split(path.sep).join("/");
  const slug = relative.replace(/\.md$/, "").replace(/(^|\/)index$/, "$1");

  const title =
    scalar(block, "title") ??
    scalar(block, "name") ??
    content.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    slug;

  const description =
    scalar(block, "description") ?? scalar(block, "tagline") ?? "";

  return {
    url: `${SITE_ORIGIN}${slug}`,
    title: stripInlineMarkdown(title),
    description: stripInlineMarkdown(description) || firstSentence(content),
  };
}

const pages = markdownFiles(DOCS_DIR)
  .map(readPage)
  .sort((left, right) => left.url.localeCompare(right.url));

const lines = [
  `# ${SITE_NAME}`,
  "",
  `> ${SITE_SUMMARY}`,
  "",
  "## Pages",
  "",
  ...pages.map((page) =>
    page.description
      ? `- [${page.title}](${page.url}): ${page.description}`
      : `- [${page.title}](${page.url})`,
  ),
  "",
];

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, lines.join("\n"), "utf8");

console.log(
  `llms.txt: ${pages.length} pages -> ${path.relative(ROOT, OUTPUT)}`,
);
