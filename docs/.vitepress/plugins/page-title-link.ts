// Prettify internal markdown links whose visible text is the raw
// filename or href. Rewrite the text to the target page's first h1 (or
// frontmatter `title`, if present).
//
// Matches links where the text is obviously a placeholder:
//   - [boundary-semantics.md](boundary-semantics.md)
//   - [./framework-packs](./framework-packs)
//   - [cross-boundary-checking](/cross-boundary-checking.md)
// Leaves intentional link text alone — if the author wrote
// `[see the semantics doc](boundary-semantics.md)`, the text doesn't
// match the filename pattern and the plugin is a no-op.

import fs from "node:fs";
import path from "node:path";

import type MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.js";

export interface PageTitleLinkOptions {
  /** Absolute path to the docs root (the directory holding the markdown files). */
  docsRoot: string;
}

export function pageTitleLinkPlugin(
  md: MarkdownIt,
  options: PageTitleLinkOptions,
): void {
  const { docsRoot } = options;
  const titleCache = new Map<string, string | null>();

  function resolveTitle(currentRelPath: string, href: string): string | null {
    if (/^[a-z]+:\/\//i.test(href) || href.startsWith("//")) {
      return null;
    }

    const [hrefPath] = href.split("#");
    if (!hrefPath) {
      return null;
    }

    const normalisedHref = hrefPath.endsWith(".md")
      ? hrefPath
      : `${hrefPath}.md`;

    const currentDir = path.posix.dirname(currentRelPath);
    const joined = normalisedHref.startsWith("/")
      ? normalisedHref.slice(1)
      : path.posix.normalize(path.posix.join(currentDir, normalisedHref));

    if (joined.startsWith("..")) {
      // Escapes docs/ — leave it alone.
      return null;
    }

    if (titleCache.has(joined)) {
      return titleCache.get(joined) ?? null;
    }

    const abs = path.join(docsRoot, joined);
    if (!fs.existsSync(abs)) {
      titleCache.set(joined, null);
      return null;
    }

    const title = readTitle(abs);
    titleCache.set(joined, title);
    return title;
  }

  md.core.ruler.push("suss_page_title_link", (state: StateCore) => {
    const currentRel =
      typeof state.env.relativePath === "string" ? state.env.relativePath : "";

    for (const token of state.tokens) {
      if (token.type !== "inline" || !token.children) {
        continue;
      }

      const children = token.children;
      for (let i = 0; i < children.length - 2; i++) {
        const open = children[i];
        const inner = children[i + 1];
        const close = children[i + 2];
        if (open.type !== "link_open" || close.type !== "link_close") {
          continue;
        }
        // Accept either plain text (`[foo](foo.md)`) or a single code_inline
        // child (`` [`foo.md`](foo.md) ``) as the link content. Anything
        // richer (multi-child, nested formatting) is left alone — treat
        // that as deliberate authorial link text.
        if (inner.type !== "text" && inner.type !== "code_inline") {
          continue;
        }

        const hrefAttr = open.attrs?.find(([key]) => key === "href");
        if (!hrefAttr) {
          continue;
        }
        const href = hrefAttr[1];
        const [hrefPath] = href.split("#");
        if (!hrefPath) {
          continue;
        }

        const baseName = path.posix.basename(hrefPath, ".md");
        const fullPathCandidate = hrefPath.replace(/^\.\//, "");
        const textContent = inner.content.trim();
        const isPlaceholder =
          textContent === baseName ||
          textContent === `${baseName}.md` ||
          textContent === hrefPath ||
          textContent === fullPathCandidate;
        if (!isPlaceholder) {
          continue;
        }

        const title = resolveTitle(currentRel, href);
        if (!title) {
          continue;
        }

        // Convert the inner node into a plain text token carrying the
        // resolved title. For a code_inline wrapper we drop the <code>
        // styling since the rewritten text is prose, not an identifier.
        inner.type = "text";
        inner.tag = "";
        inner.content = title;
        inner.markup = "";
      }
    }
  });
}

function readTitle(abs: string): string | null {
  const content = fs.readFileSync(abs, "utf8");

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fmTitle = fmMatch[1].match(/^title:\s*(.+)$/m);
    if (fmTitle) {
      return stripInlineMarkdown(fmTitle[1].trim());
    }
    // VitePress home layout uses `hero.name` as the visible title; fall
    // through to the first h1 if that isn't set either.
    const heroName = fmMatch[1].match(/^\s*name:\s*(.+)$/m);
    if (heroName) {
      return stripInlineMarkdown(
        heroName[1].trim().replace(/^["']|["']$/g, ""),
      );
    }
  }

  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) {
    return stripInlineMarkdown(h1[1].trim());
  }

  return null;
}

function stripInlineMarkdown(text: string): string {
  // Strip the common inline formatting so link text reads as prose.
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}
