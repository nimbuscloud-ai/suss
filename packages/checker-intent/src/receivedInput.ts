/**
 * Compares the `receives` block of a boundary intent with the paths the
 * unit reads off the value it was handed.
 *
 * Both checks are one-sided. A declared field nothing reads is
 * `unreadInputField`, at warning when the author said the boundary
 * needs it. A read the block leaves out is `undeclaredInputRead`, at
 * info, because a handler often logs a field no author would declare.
 *
 * A doc with no block produces neither finding, and neither does a
 * stand-down from `boundaryInputReads`. A required header is often
 * checked in middleware, so what a wrapper around a route reads counts
 * as what the route reads.
 */

import { boundaryInputReads, formatPath } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  BoundaryIntentSummary,
  IntentFinding,
  IntentInputField,
} from "@suss/intent-ir";
import type { Semantics } from "@suss/ir-core";

/** Which intent, which unit, and how the rest of this pairing writes them. */
interface Pairing {
  intent: BoundaryIntentSummary;
  impl: BehavioralSummary;
  /** Summaries of the middleware registered around `impl`, if any. */
  wrappers: readonly BehavioralSummary[];
  /** The boundary key, as every other finding on this pairing writes it. */
  boundary: string;
  /** The matched code summary, as `${file}::${name}`. */
  code: string;
}

/**
 * Whether two paths are talking about the same field. A read of
 * `provider` covers a declared `provider.identity`, and a read of
 * `provider.identity` covers a declared `provider`, so the check is the
 * same in both directions and both findings use it.
 */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const left = comparable(a);
  const right = comparable(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

/**
 * A path in the form the two sides are compared in. HTTP treats a
 * header name as case-insensitive and Node lowercases one before a
 * handler sees it, so an author writing `X-Tenant-Id` means the header
 * the code reads at `x-tenant-id`.
 */
function comparable(path: readonly string[]): string[] {
  if (path[0] !== "headers") {
    return [...path];
  }
  return path.map((segment, index) =>
    index === 1 ? segment.toLowerCase() : segment,
  );
}

export function checkReceivesBlock(pairing: Pairing): IntentFinding[] {
  const declared = pairing.intent.receives;
  if (declared.length === 0) {
    return [];
  }
  // The intent's boundary gives the protocol, and pairing has already
  // matched the code to it. The implementation's own binding can be null.
  const result = boundaryInputReads(
    pairing.impl,
    pairing.intent.boundary,
    pairing.wrappers,
  );
  if (!result.read) {
    return [];
  }

  const read = result.reads.paths;
  const unread = declared.filter(
    (field) => !read.some((path) => overlaps(path, field.path)),
  );
  const alreadyDescribed =
    DESCRIBED_WITHOUT_LISTING[pairing.intent.boundary.semantics.name];
  const undeclared = read.filter(
    (path) =>
      !declared.some((field) => overlaps(path, field.path)) &&
      !alreadyDescribed(declared, path),
  );

  return [
    ...unread.map((field) => unreadFinding(pairing, field)),
    ...undeclaredFindings(pairing, undeclared),
  ];
}

/** A protocol whose block accounts for nothing it did not list. */
const LISTS_EVERYTHING = () => false;

/**
 * Whether a block accounts for a read without listing it. A REST block
 * that declares the body has said what is in it, so a read of
 * `body.items[0].sku` is a question about that shape rather than a
 * field nobody wrote down.
 */
const DESCRIBED_WITHOUT_LISTING: Record<
  Semantics["name"],
  (declared: readonly IntentInputField[], path: readonly string[]) => boolean
> = {
  rest: (declared, path) =>
    path[0] === "body" && declared.some((field) => field.path[0] === "body"),
  "function-call": LISTS_EVERYTHING,
  "message-bus": LISTS_EVERYTHING,
  storage: LISTS_EVERYTHING,
  "unit-invocation": LISTS_EVERYTHING,
  "graphql-resolver": LISTS_EVERYTHING,
  "graphql-operation": LISTS_EVERYTHING,
  "runtime-config": LISTS_EVERYTHING,
  metric: LISTS_EVERYTHING,
};

function unreadFinding(
  pairing: Pairing,
  field: IntentInputField,
): IntentFinding {
  const needsIt = field.required ? " and needs it" : "";
  return {
    kind: "unreadInputField",
    severity: field.required ? "warning" : "info",
    boundary: pairing.boundary,
    intent: { name: pairing.intent.name },
    code: pairing.code,
    message: `Intent "${pairing.intent.name}" says ${pairing.boundary} receives ${formatPath(field.path)}${needsIt}; ${pairing.impl.identity.name} never reads it.`,
  };
}

/** One finding per path, so a field read in three branches is one read. */
function undeclaredFindings(
  pairing: Pairing,
  undeclared: string[][],
): IntentFinding[] {
  const said = new Set<string>();
  const findings: IntentFinding[] = [];
  for (const path of undeclared) {
    const spelled = formatPath(path);
    if (said.has(spelled)) {
      continue;
    }
    said.add(spelled);
    findings.push({
      kind: "undeclaredInputRead",
      severity: "info",
      boundary: pairing.boundary,
      intent: { name: pairing.intent.name },
      code: pairing.code,
      message: `${pairing.impl.identity.name} reads ${spelled} off what it was handed at ${pairing.boundary}; intent "${pairing.intent.name}" does not declare it under receives.`,
    });
  }
  return findings;
}
