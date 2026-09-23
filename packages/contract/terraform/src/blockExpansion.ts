/**
 * The blocks a module writes once and deploys many times.
 *
 * A container's environment is the usual case. HCL writes it either as
 * a `dynamic "env"` block around a `content` body or as a `for`
 * expression that produces a list. Either way the parser returns one
 * block with an iterator in it, and this module expands it into the
 * blocks the deployment gets.
 *
 * Whatever the iteration cannot resolve is left as written, so a value
 * built at deploy time leaves the same hole it would if somebody had
 * typed the block out by hand.
 */

import { parseHclExpression } from "./hclDocument.js";
import {
  arrayOf,
  asRecord,
  mapStrings,
  recordsIn,
  someString,
} from "./hclValue.js";
import { statedMap } from "./mapValue.js";
import { interpolatedReferences, replaceInterpolations } from "./references.js";

import type { ReferenceScope } from "./references.js";

/** The block HCL wraps a repeated one in, labelled by what it writes. */
const DYNAMIC = "dynamic";

/** `${item}`, the form the parser returns an `iterator` attribute in. */
const BARE_NAME = /^\$\{([A-Za-z_][\w-]*)\}$/;

/** `[for k, v in <collection> : <body>]`, over a map. */
const FOR_EXPRESSION =
  /^\$\{\s*\[\s*for\s+([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s+in\s+([^:]+):([\s\S]*)\]\s*\}$/;

/** The value one iteration step gives a reference, or null when it gives none. */
type Settle = (reference: string) => string | null;

/** The blocks that `dynamic` blocks with this label expand to. */
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
 * An entry that leaves an iterator reference unfilled does not match
 * what the content expects, so its block is dropped instead of being
 * read with the reference still in it.
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
 * The records a `for` expression over a map produces, or null when the
 * expression cannot be resolved. ECS takes its containers as JSON, so a
 * module builds the environment list this way instead of with a
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
 * The parser leaves the two iterators in it as interpolations, and the
 * substitution fills them in.
 */
function parseBody(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  return trimmed.startsWith("{") ? asRecord(parseHclExpression(trimmed)) : null;
}

/** The name each entry goes by: the `iterator` attribute if set, else the label. */
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
  const fill = (text: string) => replaceInterpolations(text, settle);
  return mapStrings(value, fill);
}

/** Whether any reference left in a block still starts with an iterator. */
function mentions(value: unknown, iterators: string[]): boolean {
  const mentionsOne = (text: string) =>
    interpolatedReferences(text).some((reference) =>
      iterators.includes(reference.split(".")[0] ?? ""),
    );
  return someString(value, mentionsOne);
}
