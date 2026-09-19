#!/usr/bin/env node
/**
 * generateLlmsTxt.ts: write docs/public/llms.txt, the index of the site an
 * agent reads before it fetches any page, and docs/public/llms-full.txt, the
 * whole site as one file so an agent can skip the fetching.
 *
 * The index lists every markdown file under docs/, since each one is a
 * published page. A page with no frontmatter description falls back to the
 * first sentence of its opening paragraph. The full file follows the sidebar
 * instead, so the pages arrive in the order a reader meets them.
 *
 * `npm run docs:build` runs this through `predocs:build`. On its own:
 *
 *   node --experimental-strip-types scripts/generateLlmsTxt.ts
 */

import fs from "node:fs";
import path from "node:path";

import { type SidebarItem, sidebar } from "../docs/.vitepress/sidebar.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS_DIR = path.join(ROOT, "docs");
const OUTPUT = path.join(DOCS_DIR, "public", "llms.txt");
const FULL_OUTPUT = path.join(DOCS_DIR, "public", "llms-full.txt");

const SITE_ORIGIN = "https://nimbuscloud-ai.github.io/suss/";

const SITE_NAME = "suss";

const SITE_SUMMARY =
  "suss reads TypeScript, Python and Ruby, writes down what the code does on every path, from the request or message that comes in to the table or queue it touches, and checks that against the clients, specs and infrastructure on the other side.";

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

/** Every page link in the sidebar, depth first, in the order it is listed. */
function sidebarLinks(items: SidebarItem[], found: string[] = []): string[] {
  for (const item of items) {
    if (item.link !== undefined) {
      found.push(item.link);
    }
    if (item.items !== undefined) {
      sidebarLinks(item.items, found);
    }
  }
  return found;
}

/** The markdown file a sidebar link points at. */
function fileForLink(link: string): string {
  const slug = link.replace(/^\//, "");
  const candidate = path.join(DOCS_DIR, `${slug.replace(/\/$/, "")}.md`);
  return slug.endsWith("/") || slug === ""
    ? path.join(DOCS_DIR, slug, "index.md")
    : candidate;
}

function withoutFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

const sidebarOrder = ["/", ...sidebarLinks(sidebar)];
const seen = new Set<string>();
const fullSections: string[] = [];
const missing: string[] = [];

for (const link of sidebarOrder) {
  const file = fileForLink(link);
  if (seen.has(file)) {
    continue;
  }
  seen.add(file);

  if (!fs.existsSync(file)) {
    missing.push(link);
    continue;
  }

  const page = readPage(file);
  const body = withoutFrontmatter(fs.readFileSync(file, "utf8"));
  fullSections.push(`# ${page.url}\n\n${body}`);
}

fs.writeFileSync(
  FULL_OUTPUT,
  `${[`# ${SITE_NAME}`, "", `> ${SITE_SUMMARY}`, "", ...fullSections].join("\n")}\n`,
  "utf8",
);

console.log(
  `llms-full.txt: ${fullSections.length} pages -> ${path.relative(ROOT, FULL_OUTPUT)}`,
);

if (missing.length > 0) {
  console.error(
    `The sidebar points at ${missing.length} pages that do not exist: ${missing.join(", ")}`,
  );
  process.exit(1);
}
