// @suss/checker-intent — pair team-authored intent against derived code.
//
// Separate from @suss/checker (the behavioural peer checker) on purpose:
// the inputs differ (IntentSummary vs BehavioralSummary), the output
// differs (IntentFinding — one-sided coverage, not a peer mismatch), and
// the two evolve independently. Shared comparison primitives
// (boundaryKey, bodyShapesMatch) live in @suss/ir-core so neither
// checker depends on the other.
//
// v0 checks system intent (kind: boundary). PRD outcome intent
// (kind: prd) — scenario / link coverage — is a separate pass.

import { bodyShapesMatch, boundaryKey } from "@suss/ir-core";

import type {
  BehavioralSummary,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  BoundaryIntentSummary,
  IntentFinding,
  IntentOutcome,
  IntentSummary,
} from "@suss/intent-ir";

export type { IntentFinding } from "@suss/intent-ir";

/** A code transition's terminal, reduced to the dimensions intent compares. */
interface CodeOutcome {
  kind: "response" | "return" | "throw";
  status: number | null;
  body: TypeShape | null;
  errorType: string | null;
}

/**
 * Pair every boundary intent against the code summaries sharing its
 * boundary key and report where the code fails to satisfy the declared
 * intent. PRD docs are skipped (scenario coverage is a separate pass).
 */
export function checkIntentAgreement(
  intents: IntentSummary[],
  code: BehavioralSummary[],
): IntentFinding[] {
  const findings: IntentFinding[] = [];
  const codeByBoundary = indexCodeByBoundary(code);

  for (const intent of intents) {
    if (intent.kind !== "boundary") {
      continue;
    }
    const key = boundaryKey(intent.boundary);
    if (key === null) {
      continue; // Boundary not keyable (e.g. function-call without package).
    }
    const impls = codeByBoundary.get(key);
    if (impls === undefined || impls.length === 0) {
      findings.push({
        kind: "unimplementedBoundary",
        severity: "error",
        boundary: key,
        intent: { name: intent.name },
        message: `Intent "${intent.name}" declares boundary ${key} with ${intent.outcomes.length} outcome(s); no code produces this boundary.`,
      });
      continue;
    }
    for (const impl of impls) {
      findings.push(...compareIntentToImpl(intent, impl, key));
    }
  }

  return findings;
}

function indexCodeByBoundary(
  code: BehavioralSummary[],
): Map<string, BehavioralSummary[]> {
  const byKey = new Map<string, BehavioralSummary[]>();
  for (const summary of code) {
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      continue;
    }
    const key = boundaryKey(binding);
    if (key === null) {
      continue;
    }
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [summary]);
    } else {
      bucket.push(summary);
    }
  }
  return byKey;
}

function compareIntentToImpl(
  intent: BoundaryIntentSummary,
  impl: BehavioralSummary,
  boundary: string,
): IntentFinding[] {
  const findings: IntentFinding[] = [];
  const codeRef = `${impl.location.file}::${impl.identity.name}`;
  const codeOutcomes = impl.transitions
    .map(toCodeOutcome)
    .filter((o): o is CodeOutcome => o !== null);

  for (const outcome of intent.outcomes) {
    const matches = codeOutcomes.filter((co) => outcomeMatches(outcome, co));
    if (matches.length === 0) {
      findings.push({
        kind: "uncoveredOutcome",
        severity: "error",
        boundary,
        intent: { name: intent.name, outcomeId: outcome.id },
        code: codeRef,
        message: `Intent "${intent.name}" declares ${describeOutcome(outcome)} at ${boundary}; ${impl.identity.name} has no transition that produces it.`,
      });
      continue;
    }
    if (outcome.body === null) {
      continue;
    }
    const withBody = matches.find((m) => m.body !== null);
    if (withBody?.body == null) {
      continue;
    }
    const verdict = bodyShapesMatch(withBody.body, outcome.body);
    if (verdict === "match" || verdict === "unknown") {
      continue;
    }
    findings.push({
      kind: "outcomeShapeMismatch",
      severity: "error",
      boundary,
      intent: { name: intent.name, outcomeId: outcome.id },
      code: codeRef,
      message: `Body shape for ${describeOutcome(outcome)} at ${boundary} disagrees with intent "${intent.name}": ${impl.identity.name} produces an incompatible shape.`,
    });
  }

  // Code produces a REST status the intent never declares. Limited to
  // REST status codes — function-call returns are too numerous to treat
  // each undeclared one as exceeding the intent.
  const declared = new Set(
    intent.outcomes
      .filter((o) => o.kind === "response" && o.status !== null)
      .map((o) => o.status),
  );
  for (const co of codeOutcomes) {
    if (
      co.kind !== "response" ||
      co.status === null ||
      declared.has(co.status)
    ) {
      continue;
    }
    findings.push({
      kind: "undeclaredOutcome",
      severity: "info",
      boundary,
      intent: { name: intent.name },
      code: codeRef,
      message: `${impl.identity.name} produces status ${co.status} at ${boundary}; intent "${intent.name}" does not declare it.`,
    });
  }

  return findings;
}

function toCodeOutcome(t: Transition): CodeOutcome | null {
  const output = t.output;
  if (output.type === "response") {
    const status =
      output.statusCode !== null && output.statusCode.type === "literal"
        ? Number(output.statusCode.value)
        : null;
    return {
      kind: "response",
      status: status !== null && Number.isFinite(status) ? status : null,
      body: output.body ?? null,
      errorType: null,
    };
  }
  if (output.type === "return") {
    return {
      kind: "return",
      status: null,
      body: output.value,
      errorType: null,
    };
  }
  if (output.type === "throw") {
    return {
      kind: "throw",
      status: null,
      body: null,
      errorType: output.exceptionType,
    };
  }
  return null;
}

function outcomeMatches(intent: IntentOutcome, code: CodeOutcome): boolean {
  if (intent.kind !== code.kind) {
    return false;
  }
  if (intent.kind === "response") {
    return intent.status === code.status;
  }
  if (intent.kind === "throw") {
    // An intent that names no error type matches any throw; a named type
    // must match exactly (or the code's type is unknown).
    return (
      intent.errorType === null ||
      code.errorType === null ||
      intent.errorType === code.errorType
    );
  }
  return true; // return — any code return matches; body compared separately.
}

function describeOutcome(outcome: IntentOutcome): string {
  if (outcome.kind === "response") {
    return `status ${outcome.status}`;
  }
  if (outcome.kind === "throw") {
    return outcome.errorType !== null
      ? `throw ${outcome.errorType}`
      : "a thrown error";
  }
  return "a return value";
}
