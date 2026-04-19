// Auto-link inline-code occurrences of glossary terms to their canonical
// reference section. Acts as a markdown-it core rule that walks the token
// stream, finds `code_inline` tokens whose content matches a glossary key,
// and wraps them in a `link_open`/`link_close` pair pointing at the term's
// URL.
//
// Skipped contexts:
//   - headings (don't link a heading's own anchor)
//   - already-wrapped links (avoid nested <a>)
//   - code blocks (markdown-it emits these as `code_block`/`fence` tokens,
//     not `code_inline`, so this falls out naturally)

import type MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.js";
import type Token from "markdown-it/lib/token.js";

export interface GlossaryLinkOptions {
  /** Map from identifier → site-absolute URL (without VitePress base). */
  glossary: Record<string, string>;
  /** CSS class applied to generated links. */
  className?: string;
}

export function glossaryLinkPlugin(
  md: MarkdownIt,
  options: GlossaryLinkOptions,
): void {
  const { glossary, className = "suss-glossary-link" } = options;

  md.core.ruler.push("suss_glossary_link", (state: StateCore) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== "inline" || !token.children) {
        continue;
      }

      // Skip the inline block belonging to a heading — linking a heading's
      // own anchor would create a nested <h2><a>…</a></h2> that competes
      // with VitePress's anchor plugin.
      const prev = state.tokens[i - 1];
      if (prev?.type === "heading_open") {
        continue;
      }

      token.children = linkifyChildren(
        token.children,
        state,
        glossary,
        className,
      );
    }
  });
}

function linkifyChildren(
  children: Token[],
  state: StateCore,
  glossary: Record<string, string>,
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

    const target = glossary[child.content];
    if (!target) {
      result.push(child);
      continue;
    }

    const open = new state.Token("link_open", "a", 1);
    open.attrs = [
      ["href", target],
      ["class", className],
    ];
    const close = new state.Token("link_close", "a", -1);
    result.push(open, child, close);
  }

  return result;
}
