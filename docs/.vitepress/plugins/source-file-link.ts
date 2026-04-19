// Auto-link inline-code occurrences of repo source paths to GitHub.
//
// Any inline code that looks like `packages/ir/src/schemas.ts`,
// `scripts/dogfood.mjs`, or `fixtures/apollo/server.ts` gets wrapped in
// an anchor pointing at the file (blob/main/...) or directory
// (tree/main/...) on GitHub. Solves the recurring problem of writing
// `packages/...` in docs and having the deployed VitePress site 404
// because relative paths that escape `docs/` don't render.

import type MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.js";
import type Token from "markdown-it/lib/token.js";

export interface SourceFileLinkOptions {
  /** GitHub URL base for single files, e.g. `https://github.com/org/repo/blob/main`. */
  githubBlobBase: string;
  /** GitHub URL base for directories, e.g. `https://github.com/org/repo/tree/main`. */
  githubTreeBase: string;
  /** Path prefixes that trigger auto-linking (e.g. `packages/`, `scripts/`). */
  prefixes: readonly string[];
  /** CSS class applied to generated links. */
  className?: string;
}

const FILE_EXTENSION = /\.[a-zA-Z0-9]+$/;

export function sourceFileLinkPlugin(
  md: MarkdownIt,
  options: SourceFileLinkOptions,
): void {
  const {
    githubBlobBase,
    githubTreeBase,
    prefixes,
    className = "suss-source-link",
  } = options;

  const prefixAlternation = prefixes
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pathRegex = new RegExp(`^(?:${prefixAlternation})[a-zA-Z0-9_./-]+$`);

  md.core.ruler.push("suss_source_file_link", (state: StateCore) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== "inline" || !token.children) {
        continue;
      }

      const prev = state.tokens[i - 1];
      if (prev?.type === "heading_open") {
        continue;
      }

      token.children = linkifyChildren(
        token.children,
        state,
        pathRegex,
        githubBlobBase,
        githubTreeBase,
        className,
      );
    }
  });
}

function linkifyChildren(
  children: Token[],
  state: StateCore,
  pathRegex: RegExp,
  blobBase: string,
  treeBase: string,
  className: string,
): Token[] {
  const result: Token[] = [];
  let nestedLinkDepth = 0;

  for (const child of children) {
    if (child.type === "link_open") {
      nestedLinkDepth += 1;
    }
    if (child.type === "link_close") {
      nestedLinkDepth = Math.max(0, nestedLinkDepth - 1);
    }

    if (nestedLinkDepth > 0 || child.type !== "code_inline") {
      result.push(child);
      continue;
    }

    const content = child.content;
    if (!pathRegex.test(content)) {
      result.push(child);
      continue;
    }

    const trimmed = content.replace(/\/+$/, "");
    const isDirectory = content.endsWith("/") || !FILE_EXTENSION.test(trimmed);
    const url = `${isDirectory ? treeBase : blobBase}/${trimmed}`;

    const open = new state.Token("link_open", "a", 1);
    open.attrs = [
      ["href", url],
      ["class", className],
      ["target", "_blank"],
      ["rel", "noopener"],
    ];
    const close = new state.Token("link_close", "a", -1);
    result.push(open, child, close);
  }

  return result;
}
