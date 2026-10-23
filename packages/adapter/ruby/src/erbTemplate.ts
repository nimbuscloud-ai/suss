/**
 * The Ruby an ERB template runs, laid out on the template's own lines.
 *
 * ERB ships with Ruby. `<%= expr %>` prints a value, `<% code %>` runs
 * code, `<%# ... %>` is a comment and `<%%` prints a literal `<%`. The
 * text between tags runs nothing, so it becomes spaces. Each tag's code
 * ends in `;`, and a printed value goes inside `[ ]`, so a read of it is
 * a value the template uses, the way ERB passes it to the output. Every
 * character keeps its offset, so a node the parser finds in the result is
 * where it is in the template.
 *
 * Which files a library renders through ERB, and when, is the library's
 * to say. A pack lists them.
 */

const OPEN = "<%";
const CLOSE = "%>";

/** `<%%` prints a literal `<%` and opens no tag. */
const LITERAL_OPEN = "<%%";

/** The character after `<%` that makes the tag a comment. */
const COMMENT_MARK = "#";

/** The character after `<%` that makes the tag print its value. */
const OUTPUT_MARK = "=";

/** `<%-` trims the indentation before the tag, and the `-` is not code. */
const TRIM_OPEN_MARK = "-";

/** `-%>` trims the line break after the tag, and the `-` is not code either. */
const TRIM_CLOSE_MARK = "-";

/** What the two characters of `%>` become after a tag that runs code. */
const CODE_CLOSE = "; ";

/** The same after a tag that prints, closing the `[` its opening became. */
const OUTPUT_CLOSE = "];";

const OUTPUT_OPEN = "[";

export function rubyInErbTemplate(template: string): string {
  const parts: string[] = [];
  let at = 0;
  while (at < template.length) {
    const open = template.indexOf(OPEN, at);
    if (open === -1) {
      parts.push(blanked(template.slice(at)));
      break;
    }
    parts.push(blanked(template.slice(at, open)));
    if (template.startsWith(LITERAL_OPEN, open)) {
      parts.push(blanked(LITERAL_OPEN));
      at = open + LITERAL_OPEN.length;
      continue;
    }
    const close = template.indexOf(CLOSE, open + OPEN.length);
    // ERB refuses a tag that never closes, so the rest of the file runs nothing.
    if (close === -1) {
      parts.push(blanked(template.slice(open)));
      break;
    }
    parts.push(tagAsRuby(template.slice(open, close + CLOSE.length)));
    at = close + CLOSE.length;
  }
  return parts.join("");
}

/** One whole tag, `<%` through `%>`, as its code with the delimiters replaced. */
function tagAsRuby(tag: string): string {
  const mark = tag.charAt(OPEN.length);
  if (mark === COMMENT_MARK) {
    return blanked(tag);
  }
  const prints = mark === OUTPUT_MARK;
  const codeStart =
    OPEN.length + (prints || mark === TRIM_OPEN_MARK ? mark.length : 0);
  const beforeClose = tag.length - CLOSE.length;
  const codeEnd =
    beforeClose > codeStart && tag.charAt(beforeClose - 1) === TRIM_CLOSE_MARK
      ? beforeClose - 1
      : beforeClose;
  const opening = blanked(tag.slice(0, codeStart));
  return [
    prints ? `${OUTPUT_OPEN}${opening.slice(OUTPUT_OPEN.length)}` : opening,
    tag.slice(codeStart, codeEnd),
    blanked(tag.slice(codeEnd, beforeClose)),
    prints ? OUTPUT_CLOSE : CODE_CLOSE,
  ].join("");
}

/** The same text with every character but a line break turned into a space. */
function blanked(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}
