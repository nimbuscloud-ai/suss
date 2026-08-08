// @suss/checker-intent: pair team-authored intent against derived code.
//
// Separate from @suss/checker (the behavioural peer checker) on purpose:
// the inputs differ (IntentSummary vs BehavioralSummary), the output
// differs (IntentFinding: one-sided coverage, not a peer mismatch), and
// the two evolve independently. Shared comparison primitives
// (boundaryKey, bodyShapesMatch) live in @suss/ir-core so neither
// checker depends on the other.
//
// Two passes over the loaded intent docs:
//   - System intent (kind: boundary) pairs against derived code.
//   - Outcome intent (kind: prd) resolves each scenario's link against the
//     loaded boundary intents (scenario coverage).
//
// Severity conventions:
//   error: the code fails a declared structural commitment
//             (unimplementedBoundary, uncoveredOutcome,
//             outcomeShapeMismatch). Intent is a deliberately authored
//             artifact; code that doesn't satisfy it is a defect, not a
//             style concern.
//   warning: the intent itself can't be checked (unkeyableBoundary), or a
//             scenario refers to an outcome no system intent declares
//             (danglingScenarioLink / ambiguousScenarioLink: a planning
//             gap). Surfaced for the author, never silent.
//   info: the code exceeds the declaration (undeclaredOutcome), or a
//             scenario isn't linked yet (unlinkedScenario). A valid
//             pending / deliberate state, not a defect.
// Findings against `source: "inferred"` (not-yet-curated) intent are
// downgraded one level by `withProvenance`; curation restores full severity.

import { BOUNDARY_ROLE, summaryRef } from "@suss/behavioral-ir";
import {
  applySuppressionsToFindings,
  bodyShapesMatch,
  boundaryKey,
  ruleBoundaryMatchesKey,
} from "@suss/ir-core";

import type {
  BehavioralSummary,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  BoundaryIntentSummary,
  IntentFinding,
  IntentFindingSeverity,
  IntentOutcome,
  IntentSource,
  IntentSummary,
  PrdSummary,
} from "@suss/intent-ir";
import type { BoundaryBinding, SuppressionRule } from "@suss/ir-core";

export type { IntentFinding } from "@suss/intent-ir";

/** A code transition's terminal, reduced to the dimensions intent compares. */
interface CodeOutcome {
  kind: "response" | "return" | "throw";
  status: number | null;
  body: TypeShape | null;
  errorType: string | null;
}

/** A boundary intent that was paired and compared against code. */
export interface CheckedBoundaryIntent {
  kind: "boundary";
  /** The intent doc's `name`. */
  intent: string;
  /** The boundary key it paired on. */
  boundary: string;
  /** Implementations compared, as `${file}::${name}`. Empty when none. */
  implementations: string[];
}

/** A PRD whose scenario links were resolved against the loaded system intents. */
export interface CheckedPrd {
  kind: "prd";
  /** The PRD doc's `title`. */
  intent: string;
  /** Total scenarios walked. */
  scenarios: number;
  /** Scenarios whose every link resolved to a declared outcome (had >=1 link). */
  resolved: number;
  /** Scenarios carrying no structured link (a valid pending state). */
  unlinked: number;
}

/**
 * A declared intent that was compared, either a boundary intent paired
 * against code or a PRD whose scenario links were resolved. Discriminated
 * on `kind` so callers render both without a parallel structure; when a
 * third doc kind (workflow) ships it extends this union.
 */
export type CheckedIntent = CheckedBoundaryIntent | CheckedPrd;

/** An intent doc that was loaded but not compared, and why. */
export interface UncheckedIntent {
  /** The intent doc's `name` (boundary) or `title` (prd). */
  intent: string;
  reason: "unkeyable";
  /** Human-readable explanation, render-ready. */
  detail: string;
}

/**
 * The full result of an intent-agreement pass. Mirrors the behavioural
 * checker's shape philosophy (`checkAll` → findings + pairs +
 * unmatched): findings are what to fix; checked / unchecked are the
 * coverage accounting: which declared intent was actually compared.
 * Callers render or gate on this without knowing which doc kinds the
 * checker compared: boundary intents and PRDs both land in `checked`
 * (a discriminated union). `unchecked` is reserved for intent that
 * couldn't be compared at all (an unkeyable boundary), never silently
 * dropped.
 */
export interface CheckIntentResult {
  findings: IntentFinding[];
  checked: CheckedIntent[];
  unchecked: UncheckedIntent[];
}

/**
 * Compare every loaded intent doc against what's known. Boundary intents
 * pair against the code summaries sharing their boundary key; PRDs resolve
 * each scenario's link against the loaded boundary intents (coverage). An
 * intent that can't be compared (an unkeyable boundary) is reported in
 * `unchecked`, never silently dropped.
 *
 * Findings against `source: "inferred"` intent are downgraded one severity
 * level: the intent describes what the code did when the inference ran, so
 * a divergence is most likely a code change since, not an authoring error.
 * Curation (`"inferred, curated"`) restores full severity.
 */
export function checkIntentAgreement(
  intents: IntentSummary[],
  code: BehavioralSummary[],
): CheckIntentResult {
  const findings: IntentFinding[] = [];
  const checked: CheckedIntent[] = [];
  const unchecked: UncheckedIntent[] = [];
  const codeByBoundary = indexCodeByBoundary(code);
  const boundaryByName = indexBoundaryIntentsByName(intents);

  for (const intent of intents) {
    if (intent.kind === "prd") {
      const result = checkPrdCoverage(intent, boundaryByName);
      findings.push(...withProvenance(result.findings, intent.source));
      checked.push(result.checked);
      continue;
    }
    const result = checkBoundaryIntent(intent, codeByBoundary);
    findings.push(...withProvenance(result.findings, intent.source));
    checked.push(...result.checked);
    unchecked.push(...result.unchecked);
  }

  return { findings, checked, unchecked };
}

interface IntentPassResult {
  findings: IntentFinding[];
  checked: CheckedIntent[];
  unchecked: UncheckedIntent[];
}

function checkBoundaryIntent(
  intent: BoundaryIntentSummary,
  codeByBoundary: Map<string, BehavioralSummary[]>,
): IntentPassResult {
  const key = boundaryKey(intent.boundary);
  if (key === null) {
    // The intent is well-formed but its boundary can't be keyed for
    // pairing (e.g. function-call without package + exportPath). The
    // author declared coverage they aren't getting, a warning finding
    // for gating plus an unchecked entry for accounting.
    return {
      findings: [
        {
          kind: "unkeyableBoundary",
          severity: "warning",
          boundary: unkeyedBoundaryLabel(intent.boundary),
          intent: { name: intent.name },
          message: `Intent "${intent.name}" has a ${intent.boundary.semantics.name} boundary that can't be keyed for pairing (function-call boundaries need package + exportPath); it was not checked against code.`,
        },
      ],
      checked: [],
      unchecked: [
        {
          intent: intent.name,
          reason: "unkeyable",
          detail: "boundary can't be keyed for pairing against code",
        },
      ],
    };
  }
  const impls = codeByBoundary.get(key) ?? [];
  if (impls.length === 0) {
    return {
      findings: [
        {
          kind: "unimplementedBoundary",
          severity: "error",
          boundary: key,
          intent: { name: intent.name },
          message: `Intent "${intent.name}" declares boundary ${key} with ${intent.outcomes.length} outcome(s); no code produces this boundary.`,
        },
      ],
      // The comparison ran: finding no implementation IS the result.
      checked: [
        {
          kind: "boundary",
          intent: intent.name,
          boundary: key,
          implementations: [],
        },
      ],
      unchecked: [],
    };
  }
  const findings: IntentFinding[] = [];
  for (const impl of impls) {
    findings.push(...compareIntentToImpl(intent, impl, key));
  }
  return {
    findings,
    checked: [
      {
        kind: "boundary",
        intent: intent.name,
        boundary: key,
        implementations: impls.map(codeRef),
      },
    ],
    unchecked: [],
  };
}

function codeRef(impl: BehavioralSummary): string {
  return summaryRef(impl);
}

// ---------------------------------------------------------------------------
// PRD scenario coverage (kind: prd)
// ---------------------------------------------------------------------------
//
// A PRD scenario carries `when` / `expect` (human terms) plus an optional
// structured `link`: a list of `<intent-name>.<outcome-id>` refs into the
// loaded boundary intents. Coverage resolves each ref against those intents
// (the "PRD → system intent" hop of the checking pipeline). It deliberately
// stops at resolution: whether the code implements a linked outcome is the
// boundary pass's job (uncoveredOutcome / unimplementedBoundary), so the two
// hops stay independently useful and a PRD can be checked before any code
// exists.

/**
 * Resolve every scenario's structured link against the loaded boundary
 * intents. Emits one finding per unlinked scenario (info, a valid pending
 * state) and per dangling / ambiguous link (warning, a planning gap the
 * author must fix). A scenario whose links all resolve produces nothing.
 */
function checkPrdCoverage(
  prd: PrdSummary,
  boundaryByName: Map<string, BoundaryIntentSummary[]>,
): { findings: IntentFinding[]; checked: CheckedPrd } {
  const findings: IntentFinding[] = [];
  let resolved = 0;
  let unlinked = 0;

  prd.scenarios.forEach((scenario, index) => {
    const label = scenarioLabel(scenario.title, index);
    if (scenario.link.length === 0) {
      unlinked += 1;
      findings.push({
        kind: "unlinkedScenario",
        severity: "info",
        boundary: prdBoundaryLabel(prd),
        intent: { name: prd.title },
        ...(scenario.title !== null
          ? { scenario: { title: scenario.title } }
          : {}),
        message: `Scenario ${label} in PRD "${prd.title}" has no structured link to a system-intent outcome; it reads on its own, but its coverage can't be checked until a link is added.`,
      });
      return;
    }
    let allResolved = true;
    for (const ref of scenario.link) {
      const finding = resolveScenarioLink(
        prd,
        scenario.title,
        label,
        ref,
        boundaryByName,
      );
      if (finding !== null) {
        findings.push(finding);
        allResolved = false;
      }
    }
    if (allResolved) {
      resolved += 1;
    }
  });

  return {
    findings,
    checked: {
      kind: "prd",
      intent: prd.title,
      scenarios: prd.scenarios.length,
      resolved,
      unlinked,
    },
  };
}

/**
 * Resolve a single `<intent-name>.<outcome-id>` ref. Returns a finding when
 * resolution fails, or null when the ref points at a declared outcome. Splits on
 * the first `.`: intent names and outcome ids are identifiers, so the first
 * segment is the name and the remainder the outcome id.
 */
function resolveScenarioLink(
  prd: PrdSummary,
  scenarioTitle: string | null,
  label: string,
  ref: string,
  boundaryByName: Map<string, BoundaryIntentSummary[]>,
): IntentFinding | null {
  const dot = ref.indexOf(".");
  const name = dot >= 0 ? ref.slice(0, dot) : ref;
  const outcomeId = dot >= 0 ? ref.slice(dot + 1) : "";
  const scenarioRef = {
    ...(scenarioTitle !== null ? { title: scenarioTitle } : {}),
    link: ref,
  };
  const matches = boundaryByName.get(name) ?? [];
  if (matches.length === 0) {
    return {
      kind: "danglingScenarioLink",
      severity: "warning",
      boundary: prdBoundaryLabel(prd),
      intent: { name: prd.title },
      scenario: scenarioRef,
      message: `Scenario ${label} in PRD "${prd.title}" links to "${ref}", but no boundary intent named "${name}" is loaded.`,
    };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguousScenarioLink",
      severity: "warning",
      boundary: prdBoundaryLabel(prd),
      intent: { name: prd.title },
      scenario: scenarioRef,
      message: `Scenario ${label} in PRD "${prd.title}" links to "${ref}", but ${matches.length} boundary intents are named "${name}"; rename them so the link resolves to one.`,
    };
  }
  const target = matches[0];
  if (outcomeId === "" || !target.outcomes.some((o) => o.id === outcomeId)) {
    const known = target.outcomes.map((o) => o.id).join(", ");
    return {
      kind: "danglingScenarioLink",
      severity: "warning",
      // The intent resolved even though the outcome didn't, key on its
      // boundary so a narrow .sussignore rule can target this finding.
      boundary: boundaryKey(target.boundary) ?? prdBoundaryLabel(prd),
      intent: { name: prd.title },
      scenario: scenarioRef,
      message: `Scenario ${label} in PRD "${prd.title}" links to "${ref}", but boundary intent "${name}" declares no outcome "${outcomeId}" (known outcomes: ${known}).`,
    };
  }
  return null;
}

function scenarioLabel(title: string | null, index: number): string {
  return title !== null ? `"${title}"` : `#${index + 1}`;
}

/**
 * Boundary label for a PRD finding that has no resolved boundary (unlinked,
 * ambiguous, or a link whose intent name doesn't resolve). Verbatim-matchable
 * by a .sussignore `boundary` discriminator, like `fn:` / `gql:` keys.
 */
function prdBoundaryLabel(prd: PrdSummary): string {
  return `prd:${prd.title}`;
}

function indexBoundaryIntentsByName(
  intents: IntentSummary[],
): Map<string, BoundaryIntentSummary[]> {
  const byName = new Map<string, BoundaryIntentSummary[]>();
  for (const intent of intents) {
    if (intent.kind !== "boundary") {
      continue;
    }
    const bucket = byName.get(intent.name);
    if (bucket === undefined) {
      byName.set(intent.name, [intent]);
    } else {
      bucket.push(intent);
    }
  }
  return byName;
}

// ---------------------------------------------------------------------------
// Provenance-aware severity
// ---------------------------------------------------------------------------

const SEVERITY_DOWNGRADE: Record<IntentFindingSeverity, IntentFindingSeverity> =
  {
    error: "warning",
    warning: "info",
    info: "info",
  };

/**
 * Downgrade findings emitted against not-yet-curated inferred intent one
 * severity level. `"author"` and `"inferred, curated"` intent fire at full
 * severity; only bare `"inferred"` is softened.
 */
function withProvenance(
  findings: IntentFinding[],
  source: IntentSource,
): IntentFinding[] {
  if (source !== "inferred") {
    return findings;
  }
  return findings.map((f) => ({
    ...f,
    severity: SEVERITY_DOWNGRADE[f.severity],
  }));
}

/**
 * Apply .sussignore rules to intent findings, using the shared
 * pipeline from @suss/ir-core (same rule shape and semantics as the
 * behavioural checker's `applySuppressions`). Rule discriminators map
 * as: `kind` → the intent finding kind; `boundary` → the finding's
 * boundary key (exact for `fn:` / `gql:` keys, path-normalized for
 * REST). A rule that specifies `consumer` or `provider` never matches
 * an intent finding: it has neither side.
 */
export function applyIntentSuppressions(
  findings: IntentFinding[],
  rules: SuppressionRule[],
  opts: { keepHidden?: boolean } = {},
): IntentFinding[] {
  return applySuppressionsToFindings(
    findings,
    rules,
    (rule, finding) => {
      if (rule.consumer !== undefined || rule.provider !== undefined) {
        return false;
      }
      return (
        rule.boundary === undefined ||
        ruleBoundaryMatchesKey(rule.boundary, finding.boundary)
      );
    },
    opts,
  );
}

function indexCodeByBoundary(
  code: BehavioralSummary[],
): Map<string, BehavioralSummary[]> {
  const byKey = new Map<string, BehavioralSummary[]>();
  for (const summary of code) {
    // Intent declares what a boundary PROVIDES. A consumer at the same
    // key (a client calling GET /users/{id}) is a caller, not an
    // implementation: comparing intent outcomes against its
    // return/render transitions would report every declared outcome as
    // uncovered. Same role split the behavioural checker's pairing uses.
    if (BOUNDARY_ROLE[summary.kind] !== "provider") {
      continue;
    }
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
  // REST status codes: function-call returns are too numerous to treat
  // each undeclared one as exceeding the intent.
  const declared = new Set(
    intent.outcomes
      .filter((o) => o.kind === "response" && o.status !== null)
      .map((o) => o.status),
  );
  const undeclaredStatuses = new Set<number>();
  for (const co of codeOutcomes) {
    if (
      co.kind !== "response" ||
      co.status === null ||
      declared.has(co.status)
    ) {
      continue;
    }
    // One finding per undeclared status, several branches producing
    // the same status (two catch arms both returning 500) are one
    // deviation from the declaration, not many.
    undeclaredStatuses.add(co.status);
  }
  for (const status of undeclaredStatuses) {
    findings.push({
      kind: "undeclaredOutcome",
      severity: "info",
      boundary,
      intent: { name: intent.name },
      code: ref,
      message: `${impl.identity.name} produces status ${status} at ${boundary}; intent "${intent.name}" does not declare it.`,
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
    // An intent that gives no error type matches any throw; a named type
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
 * Best-effort label for a boundary that has no key, enough for the
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
