/**
 * The blocks a module writes once and deploys many times.
 *
 * A container's environment is the usual case. HCL has two spellings, a
 * `dynamic "env"` block around a `content` body and a `for` expression
 * producing a list, and both leave the reader looking at one block with
 * an iterator in it rather than at the variables the process starts
 * with. This gives back the blocks the deployment will see.
 *
 * Whatever the iteration cannot settle is left as written, so a value
 * built at deploy time comes out as the same hole it would have had if
 * somebody had typed the block out by hand.
 */

import { parseHclExpression } from "./hclDocument.js";
import { statedMap } from "./mapValue.js";

import type { ReferenceScope } from "./references.js";

/** The block HCL wraps a repeated one in, labelled by what it writes. */
const DYNAMIC = "dynamic";

/** `${X}`, the same interpolation a name pattern reads. */
const SUB_TOKEN = /\$\{([^}]*)\}/g;

/** `${item}`, which is how an `iterator` attribute arrives. */
const BARE_NAME = /^\$\{([A-Za-z_][\w-]*)\}$/;

/** `[for k, v in <collection> : <body>]`, over a map. */
const FOR_EXPRESSION =
  /^\$\{\s*\[\s*for\s+([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s+in\s+([^:]+):([\s\S]*)\]\s*\}$/;

/** What one step of an iteration settles, or null when it settles nothing. */
type Settle = (reference: string) => string | null;

/** Every block one `dynamic` under this name writes. */
export function dynamicBlocks(
  body: Record<string, unknown>,
  block: string,
  scope: ReferenceScope,
): Array<Record<string, unknown>> {
  const written: Array<Record<string, unknown>> = [];
  const labelled = arrayOf(body[DYNAMIC]).flatMap((entry) =>
    recordsIn(asRecord(entry)?.[block]),
  );
  for (const declared of labelled) {
    const stated = statedMap(declared.for_each, scope);
    if (stated === null) {
      continue;
    }
    const iterator = iteratorName(declared, block);
    for (const [key, value] of Object.entries(stated)) {
      const settle = entrySettle(iterator, key, value);
      for (const content of recordsIn(declared.content)) {
        written.push(...filledBlock(content, settle, [iterator]));
      }
    }
  }
  return written;
}

/**
 * The block for one entry, or none at all. An entry that leaves part of
 * the iterator unfilled is not the one the content was written for, so
 * the block goes unread rather than read with the reference still in it.
 */
function filledBlock(
  content: Record<string, unknown>,
  settle: Settle,
  iterators: string[],
): Array<Record<string, unknown>> {
  const filled = substituted(content, settle) as Record<string, unknown>;
  return mentions(filled, iterators) ? [] : [filled];
}

/**
 * Every record a `for` expression over a map produces, or null when the
 * value is not one this can settle. ECS takes its containers as JSON,
 * so a module builds the environment list this way rather than with a
 * `dynamic` block.
 */
export function iteratedRecords(
  value: unknown,
  scope: ReferenceScope,
): Array<Record<string, unknown>> | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = FOR_EXPRESSION.exec(value.trim());
  if (parsed === null) {
    return null;
  }
  const [, keyName, valueName, collection, body] = parsed;
  const stated = statedMap(`\${${(collection as string).trim()}}`, scope);
  if (stated === null) {
    return null;
  }
  const template = parseBody(body as string);
  if (template === null) {
    return null;
  }
  return Object.entries(stated).flatMap(([key, entry]) =>
    filledBlock(
      template,
      pairSettle(keyName as string, valueName as string, key, entry),
      [keyName as string, valueName as string],
    ),
  );
}

/**
 * The body of a `for` expression, as the record it writes each time.
 * The parser leaves the two iterators in it as interpolations, which is
 * what the substitution then fills.
 */
function parseBody(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  return trimmed.startsWith("{") ? asRecord(parseHclExpression(trimmed)) : null;
}

/** What the module calls each entry: the `iterator` it states, or the label. */
function iteratorName(
  declared: Record<string, unknown>,
  block: string,
): string {
  const stated = declared.iterator;
  if (typeof stated !== "string") {
    return block;
  }
  const bare = BARE_NAME.exec(stated.trim());
  return bare === null ? block : (bare[1] as string);
}

/** `env.key`, `env.value` and `env.value.<field>`, for one map entry. */
function entrySettle(iterator: string, key: string, value: unknown): Settle {
  return (reference) => {
    const steps = reference.split(".");
    if (steps[0] !== iterator) {
      return null;
    }
    if (steps.length === 2 && steps[1] === "key") {
      return key;
    }
    return steps[1] === "value" ? fieldOf(value, steps.slice(2)) : null;
  };
}

/** `k` and `v`, and a field of `v`, for one entry of a `for` expression. */
function pairSettle(
  keyName: string,
  valueName: string,
  key: string,
  value: unknown,
): Settle {
  return (reference) => {
    const steps = reference.split(".");
    if (steps.length === 1 && steps[0] === keyName) {
      return key;
    }
    return steps[0] === valueName ? fieldOf(value, steps.slice(1)) : null;
  };
}

/** The entry itself, or the field of it the reference asks for, as text. */
function fieldOf(value: unknown, steps: string[]): string | null {
  if (steps.length === 0) {
    return typeof value === "string" ? value : null;
  }
  if (steps.length > 1) {
    return null;
  }
  const field = asRecord(value)?.[steps[0] as string];
  return typeof field === "string" ? field : null;
}

/** The same block with every reference the iteration settles filled in. */
function substituted(value: unknown, settle: Settle): unknown {
  if (typeof value === "string") {
    return value.replace(
      SUB_TOKEN,
      (written, inner: string) => settle(inner.trim()) ?? written,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substituted(entry, settle));
  }
  const record = asRecord(value);
  if (record === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([name, entry]) => [
      name,
      substituted(entry, settle),
    ]),
  );
}

/** Whether any reference left in a block still starts with an iterator. */
function mentions(value: unknown, iterators: string[]): boolean {
  if (typeof value === "string") {
    return [...value.matchAll(SUB_TOKEN)].some((match) =>
      iterators.includes((match[1] as string).trim().split(".")[0] ?? ""),
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => mentions(entry, iterators));
  }
  return Object.values(asRecord(value) ?? {}).some((entry) =>
    mentions(entry, iterators),
  );
}

function recordsIn(value: unknown): Array<Record<string, unknown>> {
  return arrayOf(value)
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
