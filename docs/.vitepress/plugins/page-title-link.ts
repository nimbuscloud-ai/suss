// Prettify internal markdown links with the target page's title, and
// auto-link bare inline-code references to markdown files.
//
// Behaviour 1 — link-text rewrite:
//   - [boundary-semantics.md](boundary-semantics.md) → [Boundary semantics](…)
//   - [./framework-packs](./framework-packs) → [Framework Packs](…)
//   - [cross-boundary-checking](/cross-boundary-checking.md) → […](…)
// Leaves intentional link text alone — `[see the semantics doc](…)`
// doesn't match the filename pattern, so it's a no-op.
//
// Behaviour 2 — inline-code auto-link:
//   - `docs/architecture.md` → <a href="/architecture">Architecture</a>
//   - `boundary-semantics.md` → <a href="/boundary-semantics">Boundary semantics</a>
// Triggers only when the code content resolves to a file inside docs/
// and the target has a readable title. Prose authors don't have to
// reach for full markdown link syntax to get a titled link.

import fs from "node:fs";
import path from "node:path";

import type MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.js";
import type Token from "markdown-it/lib/token.js";

export interface PageTitleLinkOptions {
  /** Absolute path to the docs root (the directory holding the markdown files). */
  docsRoot: string;
  /** CSS class applied to auto-generated links. */
  className?: string;
}

const MD_REFERENCE = /^(?:\.\/|\.\.\/|\/)?(?:docs\/)?[a-zA-Z0-9_\-/]+\.md$/;

export function pageTitleLinkPlugin(
  md: MarkdownIt,
  options: PageTitleLinkOptions,
): void {
  const { docsRoot, className = "suss-doc-link" } = options;
  const titleCache = new Map<
    string,
    { title: string; relPath: string } | null
  >();

  function resolveDocRef(
    currentRelPath: string,
    ref: string,
  ): { title: string; relPath: string } | null {
    if (/^[a-z]+:\/\//i.test(ref) || ref.startsWith("//")) {
      return null;
    }

    const [refPath] = ref.split("#");
    if (!refPath) {
      return null;
    }

    const normalisedRef = refPath.endsWith(".md") ? refPath : `${refPath}.md`;
    const stripped = normalisedRef.replace(/^docs\//, "");

    const currentDir = path.posix.dirname(currentRelPath);
    const joined = stripped.startsWith("/")
      ? stripped.slice(1)
      : path.posix.normalize(path.posix.join(currentDir, stripped));

    if (joined.startsWith("..")) {
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
    if (!title) {
      titleCache.set(joined, null);
      return null;
    }
    const entry = { title, relPath: joined };
    titleCache.set(joined, entry);
    return entry;
  }

  md.core.ruler.push("suss_page_title_link", (state: StateCore) => {
    const currentRel =
      typeof state.env.relativePath === "string" ? state.env.relativePath : "";

    for (const token of state.tokens) {
      if (token.type !== "inline" || !token.children) {
        continue;
      }

      token.children = processChildren(
        token.children,
        state,
        (ref) => resolveDocRef(currentRel, ref),
        className,
      );
    }
  });
}

function processChildren(
  children: Token[],
  state: StateCore,
  resolve: (ref: string) => { title: string; relPath: string } | null,
  className: string,
): Token[] {
  const result: Token[] = [];
  let nestedLinkDepth = 0;
  let index = 0;

  while (index < children.length) {
    const child = children[index];

    if (child.type === "link_open") {
      nestedLinkDepth += 1;
    }
    if (child.type === "link_close") {
      nestedLinkDepth = Math.max(0, nestedLinkDepth - 1);
    }

    // Behaviour 1 — rewrite link text when it's a placeholder (filename-as-text).
    if (
      nestedLinkDepth > 0 &&
      child.type === "link_open" &&
      children[index + 2]?.type === "link_close" &&
      (children[index + 1]?.type === "text" ||
        children[index + 1]?.type === "code_inline")
    ) {
      const inner = children[index + 1];
      const hrefAttr = child.attrs?.find(([key]) => key === "href");
      if (hrefAttr) {
        const href = hrefAttr[1];
        const [hrefPath] = href.split("#");
        if (hrefPath) {
          const baseName = path.posix.basename(hrefPath, ".md");
          const textContent = inner.content.trim();
          const stripDocs = (s: string) => s.replace(/^docs\//, "");
          const normalisedText = stripDocs(textContent);
          const candidates = [
            baseName,
            `${baseName}.md`,
            hrefPath,
            hrefPath.replace(/^\.\//, ""),
            stripDocs(hrefPath),
            stripDocs(hrefPath.replace(/^\.\//, "")),
          ];
          const isPlaceholder = candidates.some(
            (candidate) =>
              candidate === textContent || candidate === normalisedText,
          );
          if (isPlaceholder) {
            const resolved = resolve(href);
            if (resolved) {
              inner.type = "text";
              inner.tag = "";
              inner.content = resolved.title;
              inner.markup = "";
            }
          }
        }
      }
      result.push(child);
      index += 1;
      continue;
    }

    // Behaviour 2 — auto-link inline-code doc references outside any
    // existing link.
    if (nestedLinkDepth === 0 && child.type === "code_inline") {
      const content = child.content;
      if (MD_REFERENCE.test(content)) {
        const resolved = resolve(content);
        if (resolved) {
          const href = "/" + resolved.relPath.replace(/\.md$/, "");
          const textToken = new state.Token("text", "", 0);
          textToken.content = resolved.title;

          const open = new state.Token("link_open", "a", 1);
          open.attrs = [
            ["href", href],
            ["class", className],
          ];
          const close = new state.Token("link_close", "a", -1);
          result.push(open, textToken, close);
          index += 1;
          continue;
        }
      }
    }

    result.push(child);
    index += 1;
  }

  return result;
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
