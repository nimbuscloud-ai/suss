/**
 * An argument as the source writes it, and the same argument with every
 * part computed at run time blanked out.
 *
 * Two calls that pass `"user:#{id}:posts"` and `"user:#{user.id}:posts"`
 * write the same key with a different value in the hole, so they share
 * a group. A bare name or a call is computed as a whole, so it blanks to
 * one hole and every such value groups together. The adapters record an
 * interpolated string as the text they read, so the holes are found in
 * that text by the syntax each language uses for them.
 */

/** What a summary records for one argument, as the adapters write it. */
export type RecordedArgument =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "undefined" }
  | { kind: "object"; fields: Record<string, RecordedArgument> }
  | { kind: "array"; items: RecordedArgument[] }
  | { kind: "template"; sourceText: string }
  | { kind: "identifier"; name: string }
  | { kind: "call"; callee: string; args: RecordedArgument[] }
  | null;

export interface SpelledArgument {
  /** The argument as the source writes it. */
  spelled: string;
  /** The same text with each computed part replaced by `_`. */
  blanked: string;
}

/** The hole every computed value blanks to. */
export const HOLE = "_";

/** How each language spells a null the caller wrote, keyed by the caller file's extension. */
const NULL_WORD: Record<string, string> = {
  rb: "nil",
  py: "None",
};

export function spellArgument(
  argument: RecordedArgument,
  file: string,
): SpelledArgument {
  if (argument === null) {
    return { spelled: "?", blanked: HOLE };
  }
  return SPELLERS[argument.kind](argument as never, file);
}

type Speller<K extends string> = (
  argument: Extract<NonNullable<RecordedArgument>, { kind: K }>,
  file: string,
) => SpelledArgument;

const SPELLERS: {
  [K in NonNullable<RecordedArgument>["kind"]]: Speller<K>;
} = {
  string: (argument) => same(JSON.stringify(argument.value)),
  number: (argument) => same(String(argument.value)),
  boolean: (argument) => same(String(argument.value)),
  null: (_argument, file) => same(NULL_WORD[extensionOf(file)] ?? "null"),
  undefined: () => same("undefined"),
  object: (argument, file) => {
    const fields = Object.entries(argument.fields).map(([name, value]) => ({
      name,
      ...spellArgument(value, file),
    }));
    return {
      spelled: `{${fields.map((field) => `${field.name}: ${field.spelled}`).join(", ")}}`,
      blanked: `{${fields.map((field) => `${field.name}: ${field.blanked}`).join(", ")}}`,
    };
  },
  array: (argument, file) => {
    const items = argument.items.map((item) => spellArgument(item, file));
    return {
      spelled: `[${items.map((item) => item.spelled).join(", ")}]`,
      blanked: `[${items.map((item) => item.blanked).join(", ")}]`,
    };
  },
  template: (argument) => writtenText(argument.sourceText),
  identifier: (argument) => writtenText(argument.name),
  call: (argument, file) => ({
    spelled: `${argument.callee}(${argument.args.map((arg) => spellArgument(arg, file).spelled).join(", ")})`,
    blanked: HOLE,
  }),
};

function same(text: string): SpelledArgument {
  return { spelled: text, blanked: text };
}

function extensionOf(file: string): string {
  return file.slice(file.lastIndexOf(".") + 1);
}

/**
 * Text the adapter copied from the source. A string literal with
 * interpolation keeps its fixed parts. Anything else is an expression,
 * computed as a whole.
 */
function writtenText(text: string): SpelledArgument {
  const spelled = text.replace(/\s+/g, " ").trim();
  const quoting = QUOTINGS.find((one) => one.opens.test(spelled));
  if (quoting === undefined) {
    return { spelled, blanked: HOLE };
  }
  return { spelled, blanked: blankHoles(spelled, quoting) };
}

interface Quoting {
  opens: RegExp;
  hole: RegExp;
  /** Text that looks like a hole and is not one, such as Python's `{{`. */
  escape?: RegExp;
}

/**
 * The ways a string literal with holes starts, and how a hole opens in
 * it. Ruby writes `"#{x}"`, JavaScript `` `${x}` ``, and Python
 * `f"{x}"`, where `{{` is a brace and not a hole.
 */
const QUOTINGS: readonly Quoting[] = [
  { opens: /^`/, hole: /\$\{/y },
  {
    opens: /^(?:[rR]?[fF]|[fF][rR])["']/,
    hole: /\{/y,
    escape: /\{\{|\}\}/y,
  },
  { opens: /^["']/, hole: /#\{/y },
];

/** The text with the inside of every hole replaced by `_`, braces counted so a hole may contain braces. */
function blankHoles(text: string, quoting: Quoting): string {
  let blanked = "";
  let at = 0;
  while (at < text.length) {
    const escaped = matchAt(quoting.escape, text, at);
    if (escaped !== null) {
      blanked += escaped;
      at += escaped.length;
      continue;
    }
    const opened = matchAt(quoting.hole, text, at);
    if (opened === null) {
      blanked += text[at];
      at += 1;
      continue;
    }
    const close = closingBrace(text, at + opened.length);
    blanked += `${opened}${HOLE}}`;
    at = close + 1;
  }
  return blanked;
}

/** The text a sticky pattern matches starting at `at`, or null. */
function matchAt(
  pattern: RegExp | undefined,
  text: string,
  at: number,
): string | null {
  if (pattern === undefined) {
    return null;
  }
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0] ?? null;
}

function closingBrace(text: string, from: number): number {
  let depth = 1;
  for (let at = from; at < text.length; at += 1) {
    depth += BRACE_DEPTH[text[at] ?? ""] ?? 0;
    if (depth === 0) {
      return at;
    }
  }
  return text.length - 1;
}

const BRACE_DEPTH: Record<string, number> = { "{": 1, "}": -1 };
