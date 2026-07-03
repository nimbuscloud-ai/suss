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
//
// Severity conventions:
//   error   — the code fails a declared structural commitment
//             (unimplementedBoundary, uncoveredOutcome,
//             outcomeShapeMismatch). Intent is a deliberately authored
//             artifact; code that doesn't satisfy it is a defect, not a
//             style concern.
//   warning — the intent itself can't be checked (unkeyableBoundary).
//             Nothing is known to be wrong, but the author isn't getting
//             the coverage they declared — surfaced, never silent.
//   info    — the code exceeds the declaration (undeclaredOutcome).
//             Possibly missing intent, possibly deliberate.
// Findings against `source: "inferred"` (not-yet-curated) intent should
// downgrade; that lands with the provenance-aware pass.

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
import type { BoundaryBinding } from "@suss/ir-core";

export type { IntentFinding } from "@suss/intent-ir";

/** A code transition's terminal, reduced to the dimensions intent compares. */
interface CodeOutcome {
  kind: "response" | "return" | "throw";
  status: number | null;
  body: TypeShape | null;
  errorType: string | null;
}

/** A boundary intent that was paired and compared against code. */
export interface CheckedIntent {
  /** The intent doc's `name`. */
  intent: string;
  /** The boundary key it paired on. */
  boundary: string;
  /** Implementations compared, as `${file}::${name}`. Empty when none. */
  implementations: string[];
}

/** An intent doc that was loaded but not compared, and why. */
export interface UncheckedIntent {
  /** The intent doc's `name` (boundary) or `title` (prd). */
  intent: string;
  reason: "prd" | "unkeyable";
  /** Human-readable explanation, render-ready. */
  detail: string;
}

/**
 * The full result of an intent-agreement pass. Mirrors the behavioural
 * checker's shape philosophy (`checkAll` → findings + pairs +
 * unmatched): findings are what to fix; checked / unchecked are the
 * coverage accounting — which declared intent was actually compared.
 * Callers render or gate on this without knowing which doc kinds the
 * checker can handle; when PRD scenario coverage ships, PRDs move from
 * `unchecked` to `checked` with no caller changes.
 */
export interface CheckIntentResult {
  findings: IntentFinding[];
  checked: CheckedIntent[];
  unchecked: UncheckedIntent[];
}

/**
 * Pair every boundary intent against the code summaries sharing its
 * boundary key and report where the code fails to satisfy the declared
 * intent. Docs this pass can't compare (PRDs — scenario coverage is a
 * separate pass — and unkeyable boundaries) are reported in
 * `unchecked`, never silently dropped.
 */
export function checkIntentAgreement(
  intents: IntentSummary[],
  code: BehavioralSummary[],
): CheckIntentResult {
  const findings: IntentFinding[] = [];
  const checked: CheckedIntent[] = [];
  const unchecked: UncheckedIntent[] = [];
  const codeByBoundary = indexCodeByBoundary(code);

  for (const intent of intents) {
    if (intent.kind !== "boundary") {
      unchecked.push({
        intent: intent.title,
        reason: "prd",
        detail: "PRD scenario coverage is not checked yet",
      });
      continue;
    }
    const key = boundaryKey(intent.boundary);
    if (key === null) {
      // The intent is well-formed but its boundary can't be keyed for
      // pairing (e.g. function-call without package + exportPath). The
      // author declared coverage they aren't getting — a warning
      // finding for gating plus an unchecked entry for accounting.
      findings.push({
        kind: "unkeyableBoundary",
        severity: "warning",
        boundary: unkeyedBoundaryLabel(intent.boundary),
        intent: { name: intent.name },
        message: `Intent "${intent.name}" has a ${intent.boundary.semantics.name} boundary that can't be keyed for pairing (function-call boundaries need package + exportPath); it was not checked against code.`,
      });
      unchecked.push({
        intent: intent.name,
        reason: "unkeyable",
        detail: "boundary can't be keyed for pairing against code",
      });
      continue;
    }
    const impls = codeByBoundary.get(key) ?? [];
    if (impls.length === 0) {
      findings.push({
        kind: "unimplementedBoundary",
        severity: "error",
        boundary: key,
        intent: { name: intent.name },
        message: `Intent "${intent.name}" declares boundary ${key} with ${intent.outcomes.length} outcome(s); no code produces this boundary.`,
      });
      // The comparison ran — finding no implementation IS the result.
      checked.push({ intent: intent.name, boundary: key, implementations: [] });
      continue;
    }
    checked.push({
      intent: intent.name,
      boundary: key,
      implementations: impls.map(codeRef),
    });
    for (const impl of impls) {
      findings.push(...compareIntentToImpl(intent, impl, key));
    }
  }

  return { findings, checked, unchecked };
}

function codeRef(impl: BehavioralSummary): string {
  return `${impl.location.file}::${impl.identity.name}`;
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
  const ref = codeRef(impl);
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
        code: ref,
        message: `Intent "${intent.name}" declares ${describeOutcome(outcome)} at ${boundary}; ${impl.identity.name} has no transition that produces it.`,
      });
      continue;
    }
    const declaredBody = outcome.body;
    if (declaredBody === null) {
      continue;
    }
    // Intent outcomes may share a status (two 200 outcomes with
    // different bodies), so outcome↔transition pairing is many-to-many.
    // A declared body is satisfied when SOME matching code outcome
    // produces a conforming (or unknown) shape; comparing only one
    // arbitrary match would report false mismatches whenever branches
    // share a status.
    const bodied = matches.filter(
      (m): m is CodeOutcome & { body: TypeShape } => m.body !== null,
    );
    if (bodied.length === 0) {
      continue;
    }
    const verdicts = bodied.map((m) => bodyShapesMatch(m.body, declaredBody));
    if (verdicts.some((v) => v !== "nomatch")) {
      continue;
    }
    findings.push({
      kind: "outcomeShapeMismatch",
      severity: "error",
      boundary,
      intent: { name: intent.name, outcomeId: outcome.id },
      code: ref,
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
      code: ref,
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

/**
 * Best-effort label for a boundary that has no key — enough for the
 * reader of an unkeyableBoundary finding to locate the intent doc's
 * boundary block, without pretending to be a pairing key.
 */
function unkeyedBoundaryLabel(binding: BoundaryBinding): string {
  const semantics = binding.semantics;
  if (semantics.name === "function-call") {
    const target = semantics.module ?? semantics.package ?? "?";
    return `fn:${target}::${semantics.exportName ?? "?"}`;
  }
  return semantics.name;
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
