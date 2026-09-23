/**
 * Writes a JSON document without ever building it as one string.
 *
 * V8 caps a single string at about 512MB. `JSON.stringify` of a large
 * project's summaries goes past that cap and throws `Invalid string
 * length`, so the run would do all its work and then fail while writing.
 * Rendering the document in pieces and writing each piece as it is
 * produced keeps every string small. The bytes written are identical to
 * `JSON.stringify(value, null, indent)`.
 */

import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";

/**
 * A value that renders to at most this many characters is written as one
 * string, and a larger one is split into its elements or properties. The
 * limit is far below V8's cap because it also bounds how much text the
 * writer keeps at once, so peak memory does not grow with the document.
 */
const MAX_PIECE_CHARS = 4 * 1024 * 1024;

/** How much rendered text to gather before each write syscall. */
const FLUSH_CHARS = 1024 * 1024;

const padding = (indent: number, depth: number) => " ".repeat(indent * depth);

/** What `JSON.stringify` drops from objects and turns into `null` in arrays. */
const isJsonVisible = (value: unknown): boolean =>
  value !== undefined &&
  typeof value !== "function" &&
  typeof value !== "symbol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Calls `toJSON` the way `JSON.stringify` does. A value too large to
 * render whole is walked here instead of by `JSON.stringify`, so the
 * walk has to call it itself.
 */
function unwrap(value: unknown): unknown {
  if (isRecord(value) && typeof value.toJSON === "function") {
    return (value.toJSON as () => unknown).call(value);
  }
  return value;
}

/**
 * The whole rendering of `value`, or null when it is too large for one
 * string and the caller should split it.
 */
function renderWhole(value: unknown, indent: number): string | null {
  try {
    const text = JSON.stringify(value, null, indent);
    if (text === undefined || text.length > MAX_PIECE_CHARS) {
      return null;
    }
    return text;
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}

/**
 * The pieces of `JSON.stringify(value, null, indent)`, in order.
 * Concatenating them gives that exact string.
 */
export function* jsonPieces(value: unknown, indent = 0): Generator<string> {
  yield* piecesAt(value, indent, 0);
}

function* piecesAt(
  value: unknown,
  indent: number,
  depth: number,
): Generator<string> {
  const whole = renderWhole(value, indent);
  if (whole !== null) {
    // `JSON.stringify` renders a value as if it stood alone, so every
    // line after the first needs the indentation for its own depth.
    yield indent > 0 && depth > 0
      ? whole.replaceAll("\n", `\n${padding(indent, depth)}`)
      : whole;
    return;
  }

  const unwrapped = unwrap(value);
  if (Array.isArray(unwrapped)) {
    yield* arrayPieces(unwrapped, indent, depth);
    return;
  }
  if (isRecord(unwrapped)) {
    yield* recordPieces(unwrapped, indent, depth);
    return;
  }
  if (typeof unwrapped === "string") {
    yield* stringPieces(unwrapped);
    return;
  }
  // Numbers, booleans and null render in a handful of characters, so
  // there is nothing left that can be over the limit.
  yield JSON.stringify(unwrapped) ?? "null";
}

/**
 * Renders a string in slices, with its quotes. Escaping each slice gives
 * the same characters as escaping the whole string, as long as no slice
 * boundary cuts a surrogate pair in half. A cut pair leaves two lone
 * surrogates, which `JSON.stringify` writes as `\udXXX` escapes instead
 * of the character.
 */
function* stringPieces(value: string): Generator<string> {
  yield '"';
  let start = 0;
  while (start < value.length) {
    const end = sliceEnd(value, start);
    yield JSON.stringify(value.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield '"';
}

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;

function sliceEnd(value: string, start: number): number {
  const end = Math.min(start + MAX_PIECE_CHARS, value.length);
  const last = value.charCodeAt(end - 1);
  const splitsAPair =
    end < value.length &&
    last >= HIGH_SURROGATE_FIRST &&
    last <= HIGH_SURROGATE_LAST;
  return splitsAPair ? end + 1 : end;
}

function* arrayPieces(
  values: unknown[],
  indent: number,
  depth: number,
): Generator<string> {
  if (values.length === 0) {
    yield "[]";
    return;
  }
  const inner = indent > 0 ? `\n${padding(indent, depth + 1)}` : "";
  yield `[${inner}`;
  for (const [index, value] of values.entries()) {
    if (index > 0) {
      yield `,${inner}`;
    }
    yield* piecesAt(isJsonVisible(value) ? value : null, indent, depth + 1);
  }
  yield indent > 0 ? `\n${padding(indent, depth)}]` : "]";
}

function* recordPieces(
  record: Record<string, unknown>,
  indent: number,
  depth: number,
): Generator<string> {
  const keys = Object.keys(record).filter((key) => isJsonVisible(record[key]));
  if (keys.length === 0) {
    yield "{}";
    return;
  }
  const inner = indent > 0 ? `\n${padding(indent, depth + 1)}` : "";
  const colon = indent > 0 ? ": " : ":";
  yield `{${inner}`;
  for (const [index, key] of keys.entries()) {
    if (index > 0) {
      yield `,${inner}`;
    }
    yield `${JSON.stringify(key)}${colon}`;
    yield* piecesAt(record[key], indent, depth + 1);
  }
  yield indent > 0 ? `\n${padding(indent, depth)}}` : "}";
}

/** Gathers pieces into batches, so a document of thousands of pieces does not make a syscall per piece. */
function batched(sink: (text: string) => void | Promise<void>) {
  let pending: string[] = [];
  let pendingChars = 0;

  const flush = async () => {
    if (pendingChars === 0) {
      return;
    }
    const text = pending.join("");
    pending = [];
    pendingChars = 0;
    await sink(text);
  };

  return {
    add: async (piece: string) => {
      pending.push(piece);
      pendingChars += piece.length;
      if (pendingChars >= FLUSH_CHARS) {
        await flush();
      }
    },
    flush,
  };
}

/** A destination for the text, and the cleanup to run after the last write. */
interface Sink {
  write: (text: string) => void | Promise<void>;
  close: () => void;
}

/**
 * Writes to stdout, waiting when the reader falls behind and stopping
 * when it goes away. `suss extract | head` closes the pipe as soon as
 * head has its lines. The user asked for that, so the write stops
 * quietly instead of failing the run.
 */
function stdoutSink(): Sink {
  let broken = false;
  const noteBrokenPipe = (error: NodeJS.ErrnoException) => {
    broken = broken || error.code === "EPIPE";
  };
  process.stdout.on("error", noteBrokenPipe);

  return {
    write: async (text) => {
      if (broken) {
        return;
      }
      if (process.stdout.write(text) === false) {
        try {
          await once(process.stdout, "drain");
        } catch {
          // The reader closed the pipe during the write. `noteBrokenPipe`
          // has already set `broken` if that should stop the writes.
        }
      }
    },
    close: () => {
      process.stdout.off("error", noteBrokenPipe);
    },
  };
}

function fileSink(file: string): Sink {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const handle = fs.openSync(target, "w");
  return {
    write: (text) => {
      fs.writeSync(handle, text);
    },
    close: () => fs.closeSync(handle),
  };
}

interface WriteJsonOptions {
  value: unknown;
  /** Spaces per level, matching `JSON.stringify`'s third argument. */
  indent?: number;
  /** Where to write. Stdout when omitted. */
  file?: string;
}

/**
 * Writes `value` as JSON followed by a newline, in pieces. The bytes match
 * `${JSON.stringify(value, null, indent)}\n`.
 */
export async function writeJson(options: WriteJsonOptions): Promise<void> {
  const sink =
    options.file === undefined ? stdoutSink() : fileSink(options.file);
  const out = batched(sink.write);
  try {
    for (const piece of jsonPieces(options.value, options.indent ?? 0)) {
      await out.add(piece);
    }
    await out.add("\n");
    await out.flush();
  } finally {
    sink.close();
  }
}
