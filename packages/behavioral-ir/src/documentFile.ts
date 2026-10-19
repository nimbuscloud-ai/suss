/**
 * Writes and reads the JSON files suss keeps on disk: summaries, and the
 * extraction cache's manifest.
 *
 * A file is written one item per line. A top-level array puts each
 * element on its own line, and a top-level object puts each property on
 * its own line, with an array-valued property's elements on lines of
 * their own. Any JSON parser still reads the file. A reader that knows
 * the layout goes line by line, so a file larger than V8's limit on one
 * string (about 512 MB) still reads. A write goes to a temporary file
 * renamed over the target, so a killed run leaves the old file. A file
 * in any other layout, such as the indented files earlier releases
 * wrote, is read whole when it fits in one string.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** What kept a file from being read, for a caller that words it for its own reader. */
export type JsonFileProblem =
  | "unreadable"
  | "notJson"
  | "tooLarge"
  | "notSummaries";

export interface JsonFileIssue {
  path: PropertyKey[];
  message: string;
}

export class JsonFileError extends Error {
  readonly file: string;
  readonly problem: JsonFileProblem;
  /** What the parser or the file system said, without the file's name. */
  readonly detail: string;
  /** Where the content did not fit the summary schema, when `problem` is `notSummaries`. */
  readonly issues: readonly JsonFileIssue[];

  constructor(args: {
    file: string;
    problem: JsonFileProblem;
    detail: string;
    issues?: readonly JsonFileIssue[];
  }) {
    super(MESSAGE_FOR[args.problem](args.file, args.detail));
    this.name = "JsonFileError";
    this.file = args.file;
    this.problem = args.problem;
    this.detail = args.detail;
    this.issues = args.issues ?? [];
  }
}

const MESSAGE_FOR: Record<
  JsonFileProblem,
  (file: string, detail: string) => string
> = {
  unreadable: (file, detail) => `Could not read ${file}: ${detail}`,
  notJson: (file, detail) => `${file} is not JSON suss can read: ${detail}`,
  tooLarge: (file, detail) => `${file} ${detail}`,
  notSummaries: (file, detail) => `${file} is not a summaries file: ${detail}`,
};

/** A top-level array, read one element at a time, or any other value, read whole. */
export type JsonDocument =
  | { kind: "array"; elements: Iterable<unknown> }
  | { kind: "value"; value: unknown };

/** How much rendered text to gather before each write syscall. */
const FLUSH_CHARS = 1024 * 1024;

/** How many bytes a reader takes from the file per read syscall. */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** The most UTF-16 code units V8 lets one string have. */
const MAX_STRING_CHARS = 0x1fffffe8;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const OPEN_BRACKET = 0x5b;
const OPEN_BRACE = 0x7b;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What `JSON.stringify` drops from objects and turns into `null` in arrays. */
const isJsonVisible = (value: unknown): boolean =>
  value !== undefined &&
  typeof value !== "function" &&
  typeof value !== "symbol";

/** A minified value never contains a raw newline, which keeps one item to one line. */
function minified(value: unknown): string {
  return JSON.stringify(isJsonVisible(value) ? value : null) ?? "null";
}

function* elementLines(values: readonly unknown[]): Generator<string> {
  for (const [index, value] of values.entries()) {
    yield index === 0 ? minified(value) : `,\n${minified(value)}`;
  }
}

/**
 * The text of `value` in the line layout, newline at the end included.
 * `JSON.parse` of the joined pieces equals `JSON.parse` of
 * `JSON.stringify(value)`.
 */
export function* documentPieces(value: unknown): Generator<string> {
  if (Array.isArray(value) && value.length > 0) {
    yield "[\n";
    yield* elementLines(value);
    yield "\n]\n";
    return;
  }

  const keys = isRecord(value)
    ? Object.keys(value).filter((key) => isJsonVisible(value[key]))
    : [];
  if (!isRecord(value) || keys.length === 0 || "toJSON" in value) {
    yield `${minified(value)}\n`;
    return;
  }

  yield "{\n";
  for (const [index, key] of keys.entries()) {
    const property = value[key];
    yield `${index === 0 ? "" : ",\n"}${JSON.stringify(key)}:`;
    if (Array.isArray(property) && property.length > 0) {
      yield "[\n";
      yield* elementLines(property);
      yield "\n]";
      continue;
    }

    yield minified(property);
  }
  yield "\n}\n";
}

/**
 * Writes `value` to `file` in the line layout. The text goes to a
 * temporary file in the same directory, which is renamed over `file`
 * once the last byte is written, so an interrupted write never leaves
 * `file` cut short.
 */
export function writeDocumentFile(file: string, value: unknown): void {
  writeFileAtomically(file, documentPieces(value));
}

/** Writes `pieces` to a temporary file beside `file` and renames it into place. */
export function writeFileAtomically(
  file: string,
  pieces: Iterable<string>,
): void {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  // A leading dot and a name not ending in .json keep the file out of a
  // folder read while the write is in progress.
  const temporary = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const handle = fs.openSync(temporary, "w");
  let open = true;
  try {
    let pending: string[] = [];
    let pendingChars = 0;
    for (const piece of pieces) {
      pending.push(piece);
      pendingChars += piece.length;
      if (pendingChars >= FLUSH_CHARS) {
        fs.writeSync(handle, pending.join(""));
        pending = [];
        pendingChars = 0;
      }
    }
    if (pendingChars > 0) {
      fs.writeSync(handle, pending.join(""));
    }
    open = false;
    fs.closeSync(handle);
    fs.renameSync(temporary, target);
  } catch (error) {
    if (open) {
      fs.closeSync(handle);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Opens a JSON file once and reads it. A top-level array comes back as
 * its elements, which a file in the line layout yields one line at a
 * time. Iterate them once with `for...of`: the loop ending, or a `break`
 * out of it, closes the file.
 */
export function openJsonFile(file: string): JsonDocument {
  const resolved = path.resolve(file);
  const fd = openForReading(resolved);
  let closesItself = false;
  try {
    const start = firstBytes(resolved, fd);
    if (!isLineLayout(start)) {
      const value = readWhole(resolved, fd);
      return Array.isArray(value)
        ? { kind: "array", elements: releasedAsRead(value) }
        : { kind: "value", value };
    }

    if (start[0] === OPEN_BRACE) {
      return { kind: "value", value: lineLayoutObject(resolved, fd) };
    }

    closesItself = true;
    return { kind: "array", elements: lineLayoutElements(resolved, fd) };
  } finally {
    if (!closesItself) {
      fs.closeSync(fd);
    }
  }
}

/** Reads a JSON file of any layout into one value. */
export function readJsonFile(file: string): unknown {
  const document = openJsonFile(file);
  return document.kind === "array" ? [...document.elements] : document.value;
}

/** Runs a file system call, turning its error into one that says which file it was. */
function unlessUnreadable<T>(file: string, call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw new JsonFileError({
      file,
      problem: "unreadable",
      detail: messageOf(error),
    });
  }
}

function openForReading(file: string): number {
  return unlessUnreadable(file, () => fs.openSync(file, "r"));
}

/** Reads at a fixed position, which leaves the file's own position at the start for the read that follows. */
function firstBytes(file: string, fd: number): Buffer {
  const buffer = Buffer.alloc(3);
  const read = unlessUnreadable(file, () => fs.readSync(fd, buffer, 0, 3, 0));
  return buffer.subarray(0, read);
}

/**
 * True when the file opens with a bracket alone on its first line and an
 * unindented second line. `JSON.stringify` with an indent puts
 * whitespace at the start of the second line, and without one writes no
 * newline, so neither is taken for the line layout.
 */
function isLineLayout(start: Buffer): boolean {
  if (start.length < 3) {
    return false;
  }
  const opens = start[0] === OPEN_BRACKET || start[0] === OPEN_BRACE;
  const third = start[2];
  return (
    opens &&
    start[1] === NEWLINE &&
    third !== SPACE &&
    third !== TAB &&
    third !== NEWLINE &&
    third !== CARRIAGE_RETURN
  );
}

function readWhole(file: string, fd: number): unknown {
  const size = unlessUnreadable(file, () => fs.fstatSync(fd).size);
  if (size > MAX_STRING_CHARS) {
    throw new JsonFileError({
      file,
      problem: "tooLarge",
      detail: `is ${Math.round(size / (1024 * 1024))} MB of JSON written as one indented or single-line document, more than suss can read in one piece. Releases before 0.34.1 wrote summaries that way. Run the extract again to write it one summary per line.`,
    });
  }
  const text = unlessUnreadable(file, () => fs.readFileSync(fd, "utf-8"));
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new JsonFileError({
      file,
      problem: "notJson",
      detail: messageOf(error),
    });
  }
}

/** Clears each slot as its element is yielded, so the parsed original can be collected once the caller has made its own copy. */
function* releasedAsRead(values: unknown[]): Generator<unknown> {
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    values[index] = undefined;
    yield value;
  }
}

/** One line of the file and its 1-based number, for error messages. */
interface Line {
  text: string;
  number: number;
}

/**
 * The file's lines, split on the newline byte. A multi-byte UTF-8
 * character never contains that byte, so a split cannot cut one.
 */
function* linesOf(fd: number): Generator<Line> {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let partial: Buffer[] = [];
  let number = 0;
  for (
    let read = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null);
    read > 0;
    read = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null)
  ) {
    const view = chunk.subarray(0, read);
    let start = 0;
    for (
      let end = view.indexOf(NEWLINE, start);
      end !== -1;
      end = view.indexOf(NEWLINE, start)
    ) {
      number++;
      yield { text: decoded(partial, view.subarray(start, end)), number };
      partial = [];
      start = end + 1;
    }
    if (start < read) {
      // The chunk is reused for the next read, so the tail is copied.
      partial.push(Buffer.from(view.subarray(start)));
    }
  }
  if (partial.length > 0) {
    number++;
    yield { text: decoded(partial, Buffer.alloc(0)), number };
  }
}

function decoded(partial: Buffer[], last: Buffer): string {
  return partial.length === 0
    ? last.toString("utf-8")
    : Buffer.concat([...partial, last]).toString("utf-8");
}

function lineError(file: string, line: Line | null, detail: string): never {
  const where = line === null ? "at the end" : `line ${line.number}`;
  throw new JsonFileError({
    file,
    problem: "notJson",
    detail: `${where}: ${detail}`,
  });
}

function parsedLine(file: string, line: Line, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    return lineError(file, line, messageOf(error));
  }
}

const withoutTrailingComma = (text: string) =>
  text.endsWith(",") ? text.slice(0, -1) : text;

/**
 * Elements up to the line that closes their array. A minified element
 * never ends in a comma and is never a lone bracket, so neither test can
 * mistake an element for punctuation.
 */
function* elementsUntilClose(
  file: string,
  lines: Iterator<Line>,
  closers: readonly string[],
): Generator<unknown> {
  for (let next = lines.next(); next.done !== true; next = lines.next()) {
    const line = next.value;
    if (closers.includes(line.text)) {
      return;
    }
    yield parsedLine(file, line, withoutTrailingComma(line.text));
  }
  lineError(file, null, "The file ends before its closing bracket");
}

function expectNothingAfter(file: string, lines: Iterator<Line>): void {
  for (let next = lines.next(); next.done !== true; next = lines.next()) {
    if (next.value.text.trim() !== "") {
      lineError(file, next.value, "Unexpected text after the document");
    }
  }
}

/** Owns `fd` and closes it when the iteration ends or is stopped. */
function* lineLayoutElements(file: string, fd: number): Generator<unknown> {
  try {
    const lines = linesOf(fd);
    lines.next();
    yield* elementsUntilClose(file, lines, ["]"]);
    expectNothingAfter(file, lines);
  } finally {
    fs.closeSync(fd);
  }
}

function lineLayoutObject(file: string, fd: number): Record<string, unknown> {
  const lines = linesOf(fd);
  const result: Record<string, unknown> = {};
  lines.next();
  for (let next = lines.next(); next.done !== true; next = lines.next()) {
    const line = next.value;
    if (line.text === "}") {
      expectNothingAfter(file, lines);
      return result;
    }
    const { key, rest } = splitProperty(file, line);
    const value =
      rest === "["
        ? [...elementsUntilClose(file, lines, ["]", "],"])]
        : parsedLine(file, line, withoutTrailingComma(rest));
    // A plain assignment to `__proto__` would set the prototype, where
    // `JSON.parse` makes an ordinary property.
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return lineError(file, null, "The file ends before its closing brace");
}

/** Splits `"key":rest` at the colon after the key's closing quote. */
function splitProperty(
  file: string,
  line: Line,
): { key: string; rest: string } {
  const text = line.text;
  if (!text.startsWith('"')) {
    return lineError(file, line, "Expected a property name");
  }
  let end = 1;
  while (end < text.length && text[end] !== '"') {
    end += text[end] === "\\" ? 2 : 1;
  }
  if (text[end + 1] !== ":") {
    return lineError(file, line, "Expected a colon after the property name");
  }
  const key = parsedLine(file, line, text.slice(0, end + 1));
  return { key: String(key), rest: text.slice(end + 2) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
