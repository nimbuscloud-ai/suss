// Auto-link occurrences of glossary terms to their canonical reference
// section. Acts as a markdown-it core rule that walks the token stream,
// finds tokens referring to a glossary key, and wraps them in a
// `link_open`/`link_close` pair pointing at the term's URL.
//
// Matched contexts:
//   - inline code exactly matching a key: `BoundaryBinding`
//   - inline code with member access: `BoundaryBinding.protocol` — the
//     entire span becomes a link to `BoundaryBinding`'s section
//   - bold text matching a key: **Transition** (seen in the architecture
//     doc's vocabulary section)
//
// Skipped contexts:
//   - headings (don't link a heading's own anchor)
//   - already-wrapped links (avoid nested <a>)
//   - code blocks (markdown-it emits these as `code_block`/`fence`
//     tokens, not `code_inline`, so this falls out naturally)

import type MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.js";
import type Token from "markdown-it/lib/token.js";

export interface GlossaryLinkOptions {
  /** Map from identifier → site-absolute URL (without VitePress base). */
  glossary: Record<string, string>;
  /** CSS class applied to generated links. */
  className?: string;
}

const MEMBER_ACCESS = /^([A-Z][A-Za-z0-9]*)\.[A-Za-z_][A-Za-z0-9_]*$/;

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
  let index = 0;

  while (index < children.length) {
    const child = children[index];

    if (child.type === "link_open") {
      nestedLinkDepth += 1;
      result.push(child);
      index += 1;
      continue;
    }
    if (child.type === "link_close") {
      nestedLinkDepth = Math.max(0, nestedLinkDepth - 1);
      result.push(child);
      index += 1;
      continue;
    }

    if (nestedLinkDepth > 0) {
      result.push(child);
      index += 1;
      continue;
    }

    // Case 1: inline code (`BoundaryBinding` or `BoundaryBinding.protocol`)
    if (child.type === "code_inline") {
      const content = child.content;
      let termKey: string | undefined;
      if (glossary[content]) {
        termKey = content;
      } else {
        const member = content.match(MEMBER_ACCESS);
        if (member && glossary[member[1]]) {
          termKey = member[1];
        }
      }

      if (termKey) {
        result.push(...wrap(child, glossary[termKey], className, state));
        index += 1;
        continue;
      }

      result.push(child);
      index += 1;
      continue;
    }

    // Case 2: bold text (**Transition**) — expect `strong_open`, `text`,
    // `strong_close` as a triplet. Link the whole triplet.
    if (
      child.type === "strong_open" &&
      children[index + 1]?.type === "text" &&
      children[index + 2]?.type === "strong_close"
    ) {
      const textToken = children[index + 1];
      const target = glossary[textToken.content];
      if (target) {
        const open = new state.Token("link_open", "a", 1);
        open.attrs = [
          ["href", target],
          ["class", className],
        ];
        const close = new state.Token("link_close", "a", -1);
        result.push(open, child, textToken, children[index + 2], close);
        index += 3;
        continue;
      }
    }

    result.push(child);
    index += 1;
  }

  return result;
}

function wrap(
  target: Token,
  href: string,
  className: string,
  state: StateCore,
): Token[] {
  const open = new state.Token("link_open", "a", 1);
  open.attrs = [
    ["href", href],
    ["class", className],
  ];
  const close = new state.Token("link_close", "a", -1);
  return [open, target, close];
}
