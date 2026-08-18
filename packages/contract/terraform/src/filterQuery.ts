/**
 * A filter written as comparisons joined by AND and OR.
 *
 * Several cloud APIs take a selector as one string in this shape:
 * `metric.type = "x" AND resource.type = "y"`, with quoted or bare
 * values, parentheses, NOT, and terms written next to each other for
 * AND. A resource that reads what another resource declares usually
 * says which one inside such a string, so reading the string is how
 * this reader finds out what a resource refers to.
 *
 * A pack says which key it wants. This file knows the grammar and no
 * provider's key names. What comes back is a tree, since OR and NOT
 * change what a term claims and only the caller can judge that.
 */

/** One comparison, as the filter writes it. */
export interface FilterTerm {
  type: "term";
  /**
   * The left side, a dotted path such as `metric.type`. A segment the
   * filter quotes, `metric.label."response_code"`, comes back without
   * the quotes, so one key has one spelling.
   */
  key: string;
  /** `=`, `!=`, `>`, `>=`, `<`, `<=`, or `:` for "has". */
  operator: string;
  /** The right side, with the quotes taken off a quoted value. */
  value: string;
}

/** A call standing where a comparison would, with its arguments. */
export interface FilterCall {
  type: "call";
  name: string;
  arguments: string[];
}

export type FilterQuery =
  | FilterTerm
  | FilterCall
  | { type: "junction"; operator: "and" | "or"; operands: FilterQuery[] }
  | { type: "negation"; operand: FilterQuery };

/** A filter nobody could read says why, rather than reading as empty. */
export type FilterParse =
  | { ok: true; query: FilterQuery }
  | { ok: false; reason: string };

interface Token {
  type: "word" | "string" | "operator" | "open" | "close";
  text: string;
}

const OPERATORS = ["!=", ">=", "<=", "=", ">", "<", ":"];

const KEYWORDS = new Set(["AND", "OR", "NOT"]);

/** Every value a key is compared to with `=`, anywhere in the tree. */
export function filterValuesFor(query: FilterQuery, key: string): string[] {
  return filterTerms(query)
    .filter((term) => term.key === key && term.operator === "=")
    .map((term) => term.value);
}

/** Every comparison in the tree, in the order the filter writes them. */
export function filterTerms(query: FilterQuery): FilterTerm[] {
  if (query.type === "term") {
    return [query];
  }
  if (query.type === "call") {
    return [];
  }
  if (query.type === "negation") {
    return filterTerms(query.operand);
  }
  return query.operands.flatMap(filterTerms);
}

/** Every call in the tree, for a caller that reads one of them. */
export function filterCalls(query: FilterQuery): FilterCall[] {
  if (query.type === "call") {
    return [query];
  }
  if (query.type === "term") {
    return [];
  }
  if (query.type === "negation") {
    return filterCalls(query.operand);
  }
  return query.operands.flatMap(filterCalls);
}

/** Read one filter string, or say what stopped the reading. */
export function parseFilterQuery(source: string): FilterParse {
  const tokens = tokenize(source);
  if (!tokens.ok) {
    return { ok: false, reason: tokens.reason };
  }
  const reader = new TokenReader(tokens.tokens);
  const query = reader.readExpression();
  if (query === null) {
    return { ok: false, reason: reader.reason };
  }
  if (!reader.atEnd()) {
    return {
      ok: false,
      reason: `nothing joins the term at "${reader.rest()}"`,
    };
  }
  return { ok: true, query };
}

type Tokenized = { ok: true; tokens: Token[] } | { ok: false; reason: string };

function tokenize(source: string): Tokenized {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at] as string;
    // A comma only ever separates a call's arguments, so it is skipped
    // the way space is rather than becoming a token of its own.
    if (/\s/.test(char) || char === ",") {
      at += 1;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ type: char === "(" ? "open" : "close", text: char });
      at += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quoted = readQuoted(source, at, char);
      if (quoted === null) {
        return { ok: false, reason: `a quote is never closed at ${at}` };
      }
      // A key may quote one of its own segments, as
      // `metric.label."response_code"` does, and that is still one key.
      const previous = tokens[tokens.length - 1];
      if (previous !== undefined && isPartialKey(previous)) {
        previous.text += quoted.value;
      } else {
        tokens.push({ type: "string", text: quoted.value });
      }
      at = quoted.next;
      continue;
    }
    const operator = OPERATORS.find((candidate) =>
      source.startsWith(candidate, at),
    );
    if (operator !== undefined) {
      tokens.push({ type: "operator", text: operator });
      at += operator.length;
      continue;
    }
    const word = readWord(source, at);
    if (word === null) {
      return { ok: false, reason: `nothing readable at "${char}"` };
    }
    tokens.push({ type: "word", text: word.value });
    at = word.next;
  }
  return { ok: true, tokens };
}

function readQuoted(
  source: string,
  start: number,
  quote: string,
): { value: string; next: number } | null {
  let value = "";
  let at = start + 1;
  while (at < source.length) {
    const char = source[at] as string;
    if (char === "\\" && at + 1 < source.length) {
      value += source[at + 1];
      at += 2;
      continue;
    }
    if (char === quote) {
      return { value, next: at + 1 };
    }
    value += char;
    at += 1;
  }
  return null;
}

/** Whether a token is a key waiting for the segment after its dot. */
function isPartialKey(token: Token): boolean {
  return token.type === "word" && token.text.endsWith(".");
}

/** A bare run of text: a key, a number, or an unquoted value. */
function readWord(
  source: string,
  start: number,
): { value: string; next: number } | null {
  const match = /^[^\s(),="'!<>:]+/.exec(source.slice(start));
  if (match === null) {
    return null;
  }
  return { value: match[0], next: start + match[0].length };
}

/**
 * Recursive descent over the tokens. Terms written next to each other
 * are joined by AND, which is how these filters are usually written.
 */
class TokenReader {
  private at = 0;
  /** What stopped the last read, for the caller to report. */
  reason = "the filter states no comparison";

  constructor(private readonly tokens: Token[]) {}

  atEnd(): boolean {
    return this.at >= this.tokens.length;
  }

  rest(): string {
    return this.tokens
      .slice(this.at)
      .map((token) => token.text)
      .join(" ");
  }

  readExpression(): FilterQuery | null {
    return this.readJunction("or", "OR", () =>
      this.readJunction("and", "AND", () => this.readUnary()),
    );
  }

  private readJunction(
    operator: "and" | "or",
    keyword: string,
    readOperand: () => FilterQuery | null,
  ): FilterQuery | null {
    const first = readOperand();
    if (first === null) {
      return null;
    }
    const operands = [first];
    while (!this.atEnd()) {
      const joined = this.keywordAhead(keyword);
      // Two comparisons with nothing between them are joined by AND, so
      // an AND reader keeps going where an OR reader stops.
      if (!joined && !(operator === "and" && this.termAhead())) {
        break;
      }
      if (joined) {
        this.at += 1;
      }
      const next = readOperand();
      if (next === null) {
        return null;
      }
      operands.push(next);
    }
    return operands.length === 1
      ? (operands[0] as FilterQuery)
      : { type: "junction", operator, operands };
  }

  private readUnary(): FilterQuery | null {
    if (this.keywordAhead("NOT")) {
      this.at += 1;
      const operand = this.readUnary();
      return operand === null ? null : { type: "negation", operand };
    }
    return this.readPrimary();
  }

  private readPrimary(): FilterQuery | null {
    const token = this.tokens[this.at];
    if (token === undefined) {
      this.reason = "the filter ends where a comparison should be";
      return null;
    }
    if (token.type === "open") {
      this.at += 1;
      const inner = this.readExpression();
      if (inner === null) {
        return null;
      }
      if (this.tokens[this.at]?.type !== "close") {
        this.reason = "a parenthesis is never closed";
        return null;
      }
      this.at += 1;
      return inner;
    }
    if (token.type === "word" && this.tokens[this.at + 1]?.type === "open") {
      return this.readCall();
    }
    return this.readTerm();
  }

  /**
   * A call where a comparison would be. Cloud Monitoring writes an SLO
   * burn-rate condition that way, and the call says what the condition
   * is about instead of any comparison.
   */
  private readCall(): FilterCall | null {
    const name = this.tokens[this.at] as Token;
    this.at += 2;
    const args: string[] = [];
    while (!this.atEnd() && this.tokens[this.at]?.type !== "close") {
      const argument = this.tokens[this.at] as Token;
      if (argument.type === "word" || argument.type === "string") {
        args.push(argument.text);
      }
      this.at += 1;
    }
    if (this.atEnd()) {
      this.reason = `the call to "${name.text}" is never closed`;
      return null;
    }
    this.at += 1;
    return { type: "call", name: name.text, arguments: args };
  }

  private readTerm(): FilterTerm | null {
    const key = this.tokens[this.at];
    const operator = this.tokens[this.at + 1];
    const value = this.tokens[this.at + 2];
    if (key === undefined || key.type !== "word") {
      this.reason = `"${key?.text ?? ""}" is not a key`;
      return null;
    }
    if (operator === undefined || operator.type !== "operator") {
      this.reason = `"${key.text}" is compared to nothing`;
      return null;
    }
    if (
      value === undefined ||
      (value.type !== "word" && value.type !== "string")
    ) {
      this.reason = `"${key.text}" is compared to no value`;
      return null;
    }
    this.at += 3;
    return {
      type: "term",
      key: key.text,
      operator: operator.text,
      value: value.text,
    };
  }

  /** Whether the next token is this keyword rather than a key. */
  private keywordAhead(keyword: string): boolean {
    const token = this.tokens[this.at];
    return (
      token !== undefined && token.type === "word" && token.text === keyword
    );
  }

  /** Whether a new comparison starts here, with no keyword joining it. */
  private termAhead(): boolean {
    const token = this.tokens[this.at];
    if (token === undefined) {
      return false;
    }
    if (token.type === "open") {
      return true;
    }
    return token.type === "word" && !KEYWORDS.has(token.text);
  }
}
