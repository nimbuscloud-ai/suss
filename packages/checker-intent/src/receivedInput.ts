/**
 * The `receives` block of a boundary intent against the paths the unit
 * reads off the value it was handed.
 *
 * Two questions, both one-sided the way every intent finding is. A
 * declared field nothing reads is `unreadInputField`, at warning when
 * the author said the boundary needs it. A read of something the block
 * leaves out is `undeclaredInputRead`, at info, because a handler often
 * reads a field for logging that no author would declare.
 *
 * A doc with no block produces neither, since a block that is not there
 * says nothing about the input. The read set can also be too short to
 * compare, and every stand-down `boundaryInputReads` gives is silent.
 */

import { boundaryInputReads, formatPath } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  BoundaryIntentSummary,
  IntentFinding,
  IntentInputField,
} from "@suss/intent-ir";

/** Which intent, which unit, and how the rest of this pairing writes them. */
interface Pairing {
  intent: BoundaryIntentSummary;
  impl: BehavioralSummary;
  /** The boundary key, as every other finding on this pairing writes it. */
  boundary: string;
  /** The matched code summary, as `${file}::${name}`. */
  code: string;
}

/**
 * Whether two paths are talking about the same field. A read of
 * `provider` covers a declared `provider.identity`, and a read of
 * `provider.identity` covers a declared `provider`, so the relation is
 * the same in both directions and both findings ask it.
 */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function checkReceivesBlock(pairing: Pairing): IntentFinding[] {
  const declared = pairing.intent.receives;
  if (declared.length === 0) {
    return [];
  }
  // The intent's own boundary says which protocol this is, and pairing
  // already settled that the code agrees, so the document is the side
  // to ask rather than an implementation whose binding could be null.
  const result = boundaryInputReads(pairing.impl, pairing.intent.boundary);
  if (!result.read) {
    return [];
  }

  const read = result.reads.paths;
  const unread = declared.filter(
    (field) => !read.some((path) => overlaps(path, field.path)),
  );
  const undeclared = read.filter(
    (path) => !declared.some((field) => overlaps(path, field.path)),
  );

  return [
    ...unread.map((field) => unreadFinding(pairing, field)),
    ...undeclaredFindings(pairing, undeclared),
  ];
}

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
