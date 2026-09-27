/**
 * Where two JSON values differ, as the path to each difference and the
 * old and new values there.
 *
 * When a changed outcome's short line in `inspect --diff` reads the same
 * on both sides, what moved is deep inside a structure, such as one
 * expression in a render tree, and printing both structures whole hides it.
 *
 * A key that went away while another came with the same value is one
 * rename. When an array's length changed, the elements it kept at both
 * ends are set aside first, so one child inserted in a render tree is one
 * difference and the children after it do not all shift.
 */

type Step = string | number;

interface ValueDifference {
  /** The keys and indexes from the top of the value down to the difference. */
  readonly path: readonly Step[];
  /** Undefined when the key or element is only on the other side. */
  readonly before: unknown;
  readonly after: unknown;
  /** Set when the key went away and this key came with the same value. */
  readonly renamedTo?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every difference between the two values, in the order the keys come. */
function valueDifferences(
  before: unknown,
  after: unknown,
  path: readonly Step[],
): ValueDifference[] {
  if (sameJson(before, after)) {
    return [];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return arrayDifferences(before, after, path);
  }
  if (isRecord(before) && isRecord(after)) {
    return recordDifferences(before, after, path);
  }
  return [{ path, before, after }];
}

/** The keys JSON would write, since it leaves out one whose value is undefined. */
function keysOf(record: JsonRecord): string[] {
  return Object.keys(record).filter((key) => record[key] !== undefined);
}

function recordDifferences(
  before: JsonRecord,
  after: JsonRecord,
  path: readonly Step[],
): ValueDifference[] {
  const kept = new Set(keysOf(after));
  const differences = keysOf(before)
    .filter((key) => kept.has(key))
    .flatMap((key) =>
      valueDifferences(before[key], after[key], [...path, key]),
    );

  const came = keysOf(after).filter((key) => before[key] === undefined);
  for (const key of keysOf(before).filter((one) => !kept.has(one))) {
    const renamed = came.findIndex((one) => sameJson(before[key], after[one]));
    const to = came[renamed];
    if (to === undefined) {
      differences.push({
        path: [...path, key],
        before: before[key],
        after: undefined,
      });
      continue;
    }
    came.splice(renamed, 1);
    differences.push({
      path: [...path, key],
      before: before[key],
      after: after[to],
      renamedTo: to,
    });
  }

  for (const key of came) {
    differences.push({
      path: [...path, key],
      before: undefined,
      after: after[key],
    });
  }
  return differences;
}

function arrayDifferences(
  before: readonly unknown[],
  after: readonly unknown[],
  path: readonly Step[],
): ValueDifference[] {
  if (before.length === after.length) {
    return before.flatMap((one, index) =>
      valueDifferences(one, after[index], [...path, index]),
    );
  }

  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && sameJson(before[start], after[start])) {
    start += 1;
  }
  let end = 0;
  while (
    end < shorter - start &&
    sameJson(before[before.length - 1 - end], after[after.length - 1 - end])
  ) {
    end += 1;
  }

  const was = before.slice(start, before.length - end);
  const now = after.slice(start, after.length - end);
  const differences: ValueDifference[] = [];
  for (let index = 0; index < Math.max(was.length, now.length); index += 1) {
    const at = [...path, start + index];
    if (index < was.length && index < now.length) {
      differences.push(...valueDifferences(was[index], now[index], at));
      continue;
    }
    differences.push({ path: at, before: was[index], after: now[index] });
  }
  return differences;
}

// ---------------------------------------------------------------------------
// How a difference prints
// ---------------------------------------------------------------------------

/** How many differences one field prints before the rest are counted. */
const DIFFERENCES_LISTED = 3;

/** The widest a value prints before it is cut or described by its size. */
const VALUE_WIDTH = 60;

/** How much of the text two strings share is kept on each side of where they differ. */
const CONTEXT = 16;

/** How many parts of a path print before the middle is left out. */
const PATH_PARTS = 5;

/**
 * One line per difference inside a field of the two values, such as
 * `output.root.children[1].children[0].sourceText: "a" -> "b"`, and a
 * count of the rest past the first few.
 */
export function differenceTexts(
  field: string,
  before: unknown,
  after: unknown,
): string[] {
  const differences = valueDifferences(before, after, [field]);
  const listed = differences.slice(0, DIFFERENCES_LISTED).map(differenceText);
  const rest = differences.length - listed.length;
  return rest > 0 ? [...listed, `and ${rest} more in ${field}`] : listed;
}

function differenceText(difference: ValueDifference): string {
  const at = pathText(difference.path);
  if (difference.renamedTo !== undefined) {
    return `${at} renamed to ${difference.renamedTo}`;
  }
  if (
    typeof difference.before === "string" &&
    typeof difference.after === "string"
  ) {
    return `${at}: ${stringsText(difference.before, difference.after)}`;
  }
  return `${at}: ${valueText(difference.before)} -> ${valueText(difference.after)}`;
}

const PLAIN_KEY = /^[\w$-]+$/;

/** `output.root.children[1]`, with the middle left out of a long path. */
function pathText(path: readonly Step[]): string {
  const parts: string[] = [];
  for (const step of path) {
    if (typeof step === "number") {
      parts.push(`${parts.pop() ?? ""}[${step}]`);
      continue;
    }
    parts.push(PLAIN_KEY.test(step) ? step : JSON.stringify(step));
  }
  if (parts.length <= PATH_PARTS) {
    return parts.join(".");
  }
  return `${parts[0]}...${parts.slice(-3).join(".")}`;
}

/**
 * A value short enough to read whole, or else what kind of value it is
 * and how big, since a structure cut off partway is JSON nobody can read.
 */
function valueText(value: unknown): string {
  if (value === undefined) {
    return "(none)";
  }
  const text = JSON.stringify(value);
  if (text.length <= VALUE_WIDTH) {
    return text;
  }
  if (typeof value === "string") {
    return quoted(value.slice(0, VALUE_WIDTH), false, true);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (isRecord(value)) {
    const keys = keysOf(value);
    const more = keys.length > 4 ? ", ..." : "";
    return `{ ${keys.slice(0, 4).join(", ")}${more} }`;
  }
  return text;
}

/** Two strings, each cut down to where they differ and a little either side. */
function stringsText(before: string, after: string): string {
  if (before.length <= VALUE_WIDTH && after.length <= VALUE_WIDTH) {
    return `${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
  }
  let prefix = 0;
  while (prefix < Math.min(before.length, after.length)) {
    if (before[prefix] !== after[prefix]) {
      break;
    }
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < Math.min(before.length, after.length) - prefix) {
    if (
      before[before.length - 1 - suffix] !== after[after.length - 1 - suffix]
    ) {
      break;
    }
    suffix += 1;
  }
  return `${around(before, prefix, suffix)} -> ${around(after, prefix, suffix)}`;
}

function around(text: string, prefix: number, suffix: number): string {
  const start = Math.max(0, prefix - CONTEXT);
  const end = Math.min(text.length, text.length - suffix + CONTEXT);
  const middle = text.slice(start, end);
  const cutEnd = end < text.length || middle.length > VALUE_WIDTH;
  return quoted(middle.slice(0, VALUE_WIDTH), start > 0, cutEnd);
}

function quoted(text: string, cutStart: boolean, cutEnd: boolean): string {
  const inner = JSON.stringify(text).slice(1, -1);
  return `"${cutStart ? "..." : ""}${inner}${cutEnd ? "..." : ""}"`;
}
