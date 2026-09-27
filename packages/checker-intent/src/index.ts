/**
 * Compares the intent a team wrote with the summaries derived from code.
 *
 * This is kept apart from @suss/checker because the inputs and outputs
 * differ: one side is an `IntentSummary`, and a finding says the code
 * does not do what the team declared. It takes only the call facts from
 * @suss/checker, to see whether a test reaches what a scenario is about.
 *
 * A boundary intent is paired with the code at its boundary key. A PRD
 * has its scenario links resolved and its covering tests checked. Which
 * severity each finding gets, and why a finding against inferred intent
 * drops a level, is in the package design notes.
 */

import {
  BOUNDARY_ROLE,
  boundaryCalls,
  boundaryGuardsOf,
  deploymentOf,
  goesThroughRelation,
  groundBinding,
  relationsOf,
  summaryRef,
  withDeclaredDelivery,
  wrappersAround,
} from "@suss/behavioral-ir";
import {
  applySuppressionsToFindings,
  bodyShapesMatch,
  boundaryKey,
  displayLabel,
  EVERY_FIELD,
  nameReference,
  namesBoundary,
  pairingKey,
  ruleBoundaryMatchesKey,
  semanticsAgree,
} from "@suss/ir-core";

import { checkCoveringTests } from "./coveringTests.js";
import { checkReceivesBlock } from "./receivedInput.js";

import type {
  BehavioralSummary,
  BoundaryCall,
  BoundaryGuard,
  Deployment,
  Interaction,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  BoundaryIntentSummary,
  IntentCondition,
  IntentEffect,
  IntentFinding,
  IntentFindingSeverity,
  IntentOutcome,
  IntentSource,
  IntentSummary,
  PrdSummary,
} from "@suss/intent-ir";
import type {
  BoundaryBinding,
  EffectRelation,
  Relation,
  Semantics,
  SuppressionRule,
} from "@suss/ir-core";
import type { CoveringTestClaim, CoveringTestLookup } from "./coveringTests.js";

export type { IntentFinding } from "@suss/intent-ir";
export type {
  CoveringTestLookup,
  FoundSubject,
  FoundTest,
} from "./coveringTests.js";

/** A code transition's terminal, reduced to the dimensions intent compares. */
interface CodeOutcome {
  kind: "response" | "return" | "throw";
  status: number | null;
  body: TypeShape | null;
  errorType: string | null;
  /** What the transition that ends this way did at other boundaries. */
  effects: CodeEffect[];
  /** The boundaries the branch leading here turned on. */
  turnsOn: BoundaryGuard[];
  /** The line the transition starts on, for a finding about one transition. */
  line: number;
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
  /**
   * Scenarios whose every covering test exists, runs and reaches its
   * subject. Zero when the check was given no way to look tests up.
   */
  covered: number;
  /** Scenarios with neither a link nor a covering test. */
  unlinked: number;
}

/**
 * A declared intent that was compared, either a boundary intent paired
 * against code or a PRD whose scenario links were resolved. Discriminated
 * on `kind`, so a caller renders both from one list.
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
 * The result of an intent-agreement pass, laid out like the behavioural
 * checker's `checkAll` result. `findings` are what to fix. `checked`
 * lists every declared intent that was compared, boundary intents and
 * PRDs alike. `unchecked` lists intent that could not be compared at
 * all, such as an unkeyable boundary, so nothing is dropped silently.
 */
export interface CheckIntentResult {
  findings: IntentFinding[];
  checked: CheckedIntent[];
  unchecked: UncheckedIntent[];
}

/**
 * Compare every loaded intent doc against what's known. Boundary intents
 * pair against the code summaries sharing their boundary key; PRDs resolve
 * each scenario's link against the loaded boundary intents, and check the
 * tests it lists under `coveredBy` through `tests`. Without `tests`, those
 * scenarios count as backed and their tests go unchecked. An unkeyable
 * boundary is reported in `unchecked`, never silently dropped.
 *
 * Findings against `source: "inferred"` intent are downgraded one severity
 * level: the intent describes what the code did when the inference ran, so
 * a divergence is most likely a code change since, not an authoring error.
 * Curation (`"inferred, curated"`) restores full severity.
 */
export function checkIntentAgreement(
  intents: IntentSummary[],
  code: BehavioralSummary[],
  tests?: CoveringTestLookup,
): CheckIntentResult {
  const findings: IntentFinding[] = [];
  const checked: CheckedIntent[] = [];
  const unchecked: UncheckedIntent[] = [];
  const claims: ScenarioClaim[] = [];
  const codeByBoundary = indexCodeByBoundary(code);
  const boundaryByName = indexBoundaryIntentsByName(intents);
  // The drafter fills in deploy-time names, so this pass has to fill in
  // the same ones. The drafter and the behavioural checker both use
  // `deploymentOf` for it.
  const deploymentOfUnit = deploymentOf(code);
  const wrappersOfUnit = wrappersAround(code);

  for (const intent of intents) {
    if (intent.kind === "prd") {
      const result = checkPrdCoverage(intent, boundaryByName);
      findings.push(...withProvenance(result.findings, intent.source));
      checked.push(result.checked);
      claims.push(...result.claims);
      continue;
    }
    const result = checkBoundaryIntent(
      intent,
      codeByBoundary,
      deploymentOfUnit,
      wrappersOfUnit,
    );
    findings.push(...withProvenance(result.findings, intent.source));
    checked.push(...result.checked);
    unchecked.push(...result.unchecked);
  }
  if (tests !== undefined) {
    findings.push(...checkScenarioTests(claims, tests));
  }
  findings.push(...checkOutcomesDescribed(intents));

  return { findings, checked, unchecked };
}

/** A covering test to check, and the PRD count it adds to. */
interface ScenarioClaim {
  claim: CoveringTestClaim;
  checked: CheckedPrd;
  /** The scenario's position in its PRD, which groups a scenario's tests. */
  scenario: number;
}

/**
 * Every covering test in every PRD, checked together so the reach
 * question runs once. A scenario counts as covered when each test it
 * lists passes.
 */
function checkScenarioTests(
  claims: readonly ScenarioClaim[],
  tests: CoveringTestLookup,
): IntentFinding[] {
  const verdicts = checkCoveringTests(
    claims.map((one) => one.claim),
    tests,
  );
  const failed = new Set<string>();
  const findings: IntentFinding[] = [];
  for (const [at, verdict] of verdicts.entries()) {
    if (verdict.kind === "finding") {
      const { claim, checked, scenario } = claims[at];
      failed.add(`${checked.intent}\u0000${scenario}`);
      findings.push(...withProvenance([verdict.finding], claim.prd.source));
    }
  }

  const counted = new Set<string>();
  for (const { checked, scenario } of claims) {
    const key = `${checked.intent}\u0000${scenario}`;
    if (!failed.has(key) && !counted.has(key)) {
      counted.add(key);
      checked.covered += 1;
    }
  }
  return findings;
}

/**
 * The coverage question from the outcome's side: which declared
 * behaviour has no scenario explaining why it is there. A product
 * reader asks this of the same two documents the scenario pass reads.
 *
 * It stays quiet until at least one PRD is loaded, because before that
 * every outcome would be reported.
 */
function checkOutcomesDescribed(intents: IntentSummary[]): IntentFinding[] {
  const prds = intents.filter((intent) => intent.kind === "prd");
  if (prds.length === 0) {
    return [];
  }
  const linked = new Set(
    prds.flatMap((prd) => prd.scenarios.flatMap((scenario) => scenario.link)),
  );
  const findings: IntentFinding[] = [];
  for (const intent of intents) {
    if (intent.kind !== "boundary") {
      continue;
    }
    for (const outcome of intent.outcomes) {
      if (linked.has(`${intent.name}.${outcome.id}`)) {
        continue;
      }
      findings.push(
        ...withProvenance(
          [
            {
              kind: "undescribedOutcome",
              severity: "info",
              boundary: boundaryKey(intent.boundary) ?? intent.name,
              intent: { name: intent.name, outcomeId: outcome.id },
              message: `Intent "${intent.name}" declares ${outcome.id} and no PRD scenario says why it is there.`,
            },
          ],
          intent.source,
        ),
      );
    }
  }
  return findings;
}

interface IntentPassResult {
  findings: IntentFinding[];
  checked: CheckedIntent[];
  unchecked: UncheckedIntent[];
}

function checkBoundaryIntent(
  intent: BoundaryIntentSummary,
  codeByBoundary: Map<string, BehavioralSummary[]>,
  deploymentOfUnit: (code: BehavioralSummary) => Deployment,
  wrappersOfUnit: (code: BehavioralSummary) => BehavioralSummary[],
): IntentPassResult {
  const key = pairingKey(intent.boundary);
  if (key === null) {
    // The boundary cannot be keyed, as with a function call that has no
    // package and export path. The author expects a check that is not
    // happening, so this gets a warning and an unchecked entry.
    return {
      findings: [
        {
          kind: "unkeyableBoundary",
          severity: "warning",
          boundary: displayLabel(intent.boundary),
          intent: { name: intent.name },
          message: `Intent "${intent.name}" has a ${intent.boundary.semantics.name} boundary that can't be keyed for pairing (${whatWouldKeyIt(intent.boundary.semantics.name)}); it was not checked against code.`,
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
  // Bucket on the pairing key, settle the rest with semanticsAgree:
  // the same two steps pairSummaries takes, so a "*" route satisfies a
  // method-named intent here exactly when the two would pair (#122).
  const label = boundaryKey(intent.boundary) ?? key;
  const impls = (codeByBoundary.get(key) ?? []).filter((impl) => {
    const binding = impl.identity.boundaryBinding;
    return (
      binding !== null &&
      semanticsAgree(binding.semantics, intent.boundary.semantics)
    );
  });
  if (impls.length === 0) {
    return {
      findings: [
        {
          kind: "unimplementedBoundary",
          severity: "error",
          boundary: label,
          intent: { name: intent.name },
          message: `Intent "${intent.name}" declares boundary ${label} with ${intent.outcomes.length} outcome(s); no code produces this boundary.`,
        },
      ],
      // The comparison ran, and finding no implementation is its result.
      checked: [
        {
          kind: "boundary",
          intent: intent.name,
          boundary: label,
          implementations: [],
        },
      ],
      unchecked: [],
    };
  }
  const findings: IntentFinding[] = [];
  for (const impl of impls) {
    findings.push(
      ...compareIntentToImpl(
        intent,
        impl,
        label,
        deploymentOfUnit(impl),
        wrappersOfUnit(impl),
      ),
    );
  }
  return {
    findings,
    checked: [
      {
        kind: "boundary",
        intent: intent.name,
        boundary: label,
        implementations: impls.map(codeRef),
      },
    ],
    unchecked: [],
  };
}

function codeRef(impl: BehavioralSummary): string {
  return summaryRef(impl);
}

/**
 * Resolve every scenario's structured link against the loaded boundary
 * intents, and hand back the tests scenarios list for the caller to
 * check together. Emits a warning per scenario with neither, and per
 * dangling or ambiguous link, since each is a gap the author has to
 * fix. The pass stops at resolving links, and the design notes say why.
 */
function checkPrdCoverage(
  prd: PrdSummary,
  boundaryByName: Map<string, BoundaryIntentSummary[]>,
): { findings: IntentFinding[]; checked: CheckedPrd; claims: ScenarioClaim[] } {
  const findings: IntentFinding[] = [];
  const claims: ScenarioClaim[] = [];
  const checked: CheckedPrd = {
    kind: "prd",
    intent: prd.title,
    scenarios: prd.scenarios.length,
    resolved: 0,
    covered: 0,
    unlinked: 0,
  };
  const fallbackSubjects = linkedBoundaryKeys(prd, boundaryByName);

  prd.scenarios.forEach((scenario, index) => {
    const label = scenarioLabel(scenario.title, index);
    for (const spelled of scenario.coveredBy) {
      claims.push({
        claim: {
          prd,
          scenarioTitle: scenario.title,
          label,
          spelled,
          subjects:
            scenario.about.length > 0 ? scenario.about : fallbackSubjects,
        },
        checked,
        scenario: index,
      });
    }

    if (scenario.link.length === 0 && scenario.coveredBy.length === 0) {
      checked.unlinked += 1;
      findings.push({
        kind: "unlinkedScenario",
        severity: "warning",
        boundary: prdBoundaryLabel(prd),
        intent: { name: prd.title },
        ...(scenario.title !== null
          ? { scenario: { title: scenario.title } }
          : {}),
        message: `Scenario ${label} in PRD "${prd.title}" has neither a link to a boundary outcome nor a covering test, so nothing checks it; add a link, or list the test that covers it under coveredBy.`,
      });
      return;
    }
    if (scenario.link.length === 0) {
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
      checked.resolved += 1;
    }
  });

  return { findings, checked, claims };
}

/**
 * The boundary keys the PRD's links resolve to, which is what a covering
 * test with no `about` has to reach one of. A link that does not resolve
 * adds nothing, and its own finding says why.
 */
function linkedBoundaryKeys(
  prd: PrdSummary,
  boundaryByName: Map<string, BoundaryIntentSummary[]>,
): string[] {
  const keys = new Set<string>();
  for (const ref of prd.scenarios.flatMap((scenario) => scenario.link)) {
    const matches = boundaryByName.get(ref.split(".")[0]) ?? [];
    const key = matches.length === 1 ? boundaryKey(matches[0].boundary) : null;
    if (key !== null) {
      keys.add(key);
    }
  }
  return [...keys];
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
      // The intent resolved, so the finding is keyed on its boundary,
      // where a narrow .sussignore rule can match it.
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
 * Apply .sussignore rules to intent findings, through the same pipeline
 * in @suss/ir-core that the behavioural checker's `applySuppressions`
 * uses. A rule's `kind` matches the finding kind, and its `boundary`
 * matches the finding's boundary key, exactly for `fn:` and `gql:` keys
 * and path-normalized for REST. A rule's `scenario` matches the title
 * of the PRD scenario the finding is about. A rule that gives
 * `consumer` or `provider` never matches, since an intent finding has
 * neither side.
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

      if (
        rule.scenario !== undefined &&
        rule.scenario !== finding.scenario?.title
      ) {
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
  // A queue consumer's own summary says nothing about which queue
  // delivers to it, so without this it lands under no key at all and an
  // intent doc for that boundary pairs with nothing.
  for (const summary of withDeclaredDelivery(code)) {
    // Intent declares what a boundary provides. A client calling the same
    // route is a caller, and comparing outcomes against its returns
    // would report every declared outcome as uncovered.
    if (BOUNDARY_ROLE[summary.kind] !== "provider") {
      continue;
    }
    // A manifest only says a queue exists. Compared against it, the
    // intent would look unimplemented, though the handler beside it in
    // the same run implements it.
    if (summary.confidence.source === "declared") {
      continue;
    }
    const binding = summary.identity.boundaryBinding;
    if (binding === null) {
      continue;
    }
    const key = pairingKey(binding);
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
  deployment: Deployment,
  wrappers: readonly BehavioralSummary[],
): IntentFinding[] {
  const findings: IntentFinding[] = [];
  const ref = codeRef(impl);
  const calls = boundaryCalls(impl);
  const codeOutcomes = impl.transitions
    .map((t) => toCodeOutcome(t, calls, deployment))
    .filter((o): o is CodeOutcome => o !== null);
  const everyEffect = impl.transitions.flatMap((t) =>
    codeEffectsOf(t, deployment),
  );
  // Declared boundaries the unit never touches at all, and undeclared
  // ones it touches instead: the raw material for a renamedBoundary
  // pairing once every outcome has been walked.
  const vanished: VanishedBoundaryUse[] = [];
  const undeclared: UndeclaredBoundaryUse[] = [];

  for (const outcome of intent.outcomes) {
    // An outcome that says only what it resulted in has no terminal to
    // narrow by, so its effects are checked against the whole unit.
    const reached =
      outcome.kind === "effect"
        ? everyEffect
        : codeOutcomes
            .filter((co) => outcomeMatches(outcome, co))
            .flatMap((co) => co.effects);
    for (const effect of outcome.effects) {
      if (reached.some((made) => effectMatches(effect, made))) {
        continue;
      }
      const finding: IntentFinding = {
        kind: "uncoveredOutcome",
        severity: "error",
        boundary,
        intent: { name: intent.name, outcomeId: outcome.id },
        code: ref,
        message: `Intent "${intent.name}" declares that ${outcome.id} results in ${describeEffect(effect)} at ${boundary}; no transition of ${impl.identity.name} does that.${unsettledNote(reached, effect, deployment)}`,
      };
      findings.push(finding);
      if (neverTouchesBoundary(effect.names, everyEffect)) {
        vanished.push({
          finding,
          boundary: effect.names,
          does: effect.does,
          kind: "effect",
          effect,
          reached,
        });
      }
    }
    if (outcome.kind === "effect") {
      continue;
    }
    const ending = codeOutcomes.filter((co) => outcomeMatches(outcome, co));
    if (ending.length === 0) {
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
    // A `when` clause that says which boundary the branch read is the
    // one part of the condition this pass can settle, so a declared
    // outcome narrows to the branches that turn on what it said.
    const stated = boundaryClauses(outcome);
    const matches =
      stated.length === 0
        ? ending
        : ending.filter((co) =>
            stated.every((c) => conditionMet(c, co.turnsOn)),
          );
    if (matches.length === 0) {
      const unmet = stated.find(
        (c) => !ending.some((co) => conditionMet(c, co.turnsOn)),
      );
      const finding: IntentFinding = {
        kind: "uncoveredOutcome",
        severity: "error",
        boundary,
        intent: { name: intent.name, outcomeId: outcome.id },
        code: ref,
        message: unmetConditionMessage(
          intent,
          outcome,
          boundary,
          impl,
          unmet,
          everyEffect,
        ),
      };
      findings.push(finding);
      if (
        unmet !== undefined &&
        neverTouchesBoundary(unmet.at.names, everyEffect)
      ) {
        vanished.push({
          finding,
          boundary: unmet.at.names,
          does: unmet.at.does,
          kind: "condition",
          unmet,
          ending,
        });
      }
      continue;
    }
    const declaredBody = outcome.body;
    if (declaredBody === null) {
      continue;
    }
    // Two outcomes can share a status with different bodies, so a
    // declared body is satisfied when any matching code outcome has a
    // conforming or unknown shape.
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
    // Two catch arms that both return 500 are one undeclared status.
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

  const always = checkAlwaysEffects(
    intent,
    impl,
    boundary,
    codeOutcomes,
    everyEffect,
    deployment,
  );
  findings.push(...always.findings);
  vanished.push(...always.vanished);

  // An intent listing three writes on a unit doing four has one nobody
  // wrote down, the same open-specification case an undeclared status
  // is, so it gets the same severity.
  const declaredEffects = [
    ...intent.outcomes.flatMap((o) => o.effects),
    ...intent.always.map((a) => a.effect),
  ];
  const said = new Set<string>();
  for (const made of everyEffect) {
    const spelled = `${made.does} ${made.label}`;
    if (
      said.has(spelled) ||
      declaredEffects.some((effect) => effectMatches(effect, made))
    ) {
      continue;
    }
    said.add(spelled);
    const finding: IntentFinding = {
      kind: "undeclaredOutcome",
      severity: "info",
      boundary,
      intent: { name: intent.name },
      code: ref,
      message: `${impl.identity.name} ${spelled} at ${boundary}; intent "${intent.name}" does not declare it.`,
    };
    findings.push(finding);
    undeclared.push({ finding, boundary: made.label, does: made.does });
  }

  findings.push(
    ...checkReceivesBlock({ intent, impl, wrappers, boundary, code: ref }),
  );

  return foldRenamedBoundaries(
    intent,
    impl,
    boundary,
    ref,
    findings,
    vanished,
    undeclared,
  );
}

/** Whether the unit makes no effect at all against a boundary, in any transition. */
function neverTouchesBoundary(
  names: string,
  everyEffect: CodeEffect[],
): boolean {
  return everyEffect.every((made) => !namesBoundary(names, made.binding));
}

/**
 * A clause naming a boundary the unit never touches anywhere gets a
 * message that says so, since the branch conditions cannot be the
 * reason. Otherwise the branch is produced under a different condition.
 */
function unmetConditionMessage(
  intent: BoundaryIntentSummary,
  outcome: IntentOutcome,
  boundary: string,
  impl: BehavioralSummary,
  unmet: (IntentCondition & { at: IntentEffect }) | undefined,
  everyEffect: CodeEffect[],
): string {
  const declared = `Intent "${intent.name}" declares ${describeOutcome(outcome)} at ${boundary} when ${unmet?.said ?? outcome.when}`;
  if (
    unmet !== undefined &&
    neverTouchesBoundary(unmet.at.names, everyEffect)
  ) {
    return `${declared}; ${impl.identity.name} never ${unmet.at.does} ${unmet.at.names}.`;
  }
  return `${declared}; ${impl.identity.name} produces it on a different condition.`;
}

/** A declared effect boundary the unit never touches, that a rename could explain, with what `satisfiedBy` needs to check a candidate against it. */
type VanishedBoundaryUse =
  | {
      finding: IntentFinding;
      /** The boundary as the intent doc wrote it. */
      boundary: string;
      does: Relation;
      kind: "effect";
      effect: IntentEffect;
      reached: CodeEffect[];
    }
  | {
      finding: IntentFinding;
      boundary: string;
      does: Relation;
      kind: "condition";
      unmet: IntentCondition & { at: IntentEffect };
      ending: CodeOutcome[];
    };

/** Whether a candidate boundary would satisfy this specific declared use. */
function satisfiedBy(use: VanishedBoundaryUse, candidate: string): boolean {
  if (use.kind === "effect") {
    return use.reached.some((made) =>
      effectMatches({ ...use.effect, names: candidate }, made),
    );
  }
  return use.ending.some((co) =>
    conditionMet(
      { ...use.unmet, at: { ...use.unmet.at, names: candidate } },
      co.turnsOn,
    ),
  );
}

/** A boundary the code touches that the intent never declares, that could be the renamed counterpart. */
interface UndeclaredBoundaryUse {
  finding: IntentFinding;
  /** The boundary as the code writes it. */
  boundary: string;
  does: Relation;
}

/**
 * Fold a declared boundary the unit never touches together with an
 * undeclared one of the same storage system it touches instead, into
 * one `renamedBoundary` finding, when the pairing is unambiguous.
 * Everything the two produced (the uncovered-outcome and condition
 * findings for the vanished boundary, the undeclared-effect findings
 * for the one that appeared) is replaced by the one finding; anything
 * left unpaired stays as it was, since a reader can act on those
 * directly.
 */
function foldRenamedBoundaries(
  intent: BoundaryIntentSummary,
  impl: BehavioralSummary,
  boundary: string,
  ref: string,
  findings: IntentFinding[],
  vanished: VanishedBoundaryUse[],
  undeclared: UndeclaredBoundaryUse[],
): IntentFinding[] {
  const vanishedByBoundary = groupByBoundary(vanished);
  const undeclaredByBoundary = groupByBoundary(undeclared);
  const pairings = matchRenamedBoundaries(
    vanishedByBoundary,
    undeclaredByBoundary,
  );
  if (pairings.length === 0) {
    return findings;
  }

  const explained = new Set<IntentFinding>();
  const renamed: IntentFinding[] = [];
  for (const pairing of pairings) {
    for (const use of pairing.vanishedUses) {
      explained.add(use.finding);
    }
    for (const use of pairing.undeclaredUses) {
      explained.add(use.finding);
    }
    renamed.push({
      kind: "renamedBoundary",
      severity: "error",
      boundary,
      intent: { name: intent.name },
      code: ref,
      message: `Intent "${intent.name}" declares ${pairing.from}; ${impl.identity.name} ${joinVerbs(pairing.does)} ${pairing.to} instead, with the same outcomes. If the store was renamed, update the intent.`,
    });
  }

  return [...findings.filter((finding) => !explained.has(finding)), ...renamed];
}

/** One boundary that vanished, paired with the one that appeared in its place, and the uses on both sides the one finding replaces. */
interface RenamedBoundaryPairing {
  from: string;
  to: string;
  does: Set<Relation>;
  vanishedUses: VanishedBoundaryUse[];
  undeclaredUses: UndeclaredBoundaryUse[];
}

/**
 * Which vanished boundaries pair unambiguously with which undeclared
 * ones: the two boundaries share a system prefix, their verbs match
 * exactly, the undeclared boundary satisfies every declared use the
 * vanished one had, and each side has exactly one candidate on the
 * other.
 */
function matchRenamedBoundaries(
  vanishedByBoundary: Map<string, VanishedBoundaryUse[]>,
  undeclaredByBoundary: Map<string, UndeclaredBoundaryUse[]>,
): RenamedBoundaryPairing[] {
  const candidatesFor = new Map<string, RenamedBoundaryPairing[]>();
  const candidateCountAgainst = new Map<string, number>();

  for (const [from, uses] of vanishedByBoundary) {
    // Reads and writes are how a store is touched. A queue channel or
    // a deployed unit is addressed by name, and a callee swap is a
    // defect the individual findings already describe.
    const verbs = new Set(uses.map((use) => use.does));
    if (!isStorageVerbs(verbs)) {
      continue;
    }
    for (const [to, madeUses] of undeclaredByBoundary) {
      if (!sameSystem(from, to)) {
        continue;
      }
      if (!sameVerbs(verbs, new Set(madeUses.map((use) => use.does)))) {
        continue;
      }
      if (!uses.every((use) => satisfiedBy(use, to))) {
        continue;
      }
      pushCandidate(candidatesFor, from, {
        from,
        to,
        does: verbs,
        vanishedUses: uses,
        undeclaredUses: madeUses,
      });
      incrementCount(candidateCountAgainst, to);
    }
  }

  const pairings: RenamedBoundaryPairing[] = [];
  for (const [, candidates] of candidatesFor) {
    if (candidates.length !== 1) {
      continue;
    }
    const [pairing] = candidates;
    if (candidateCountAgainst.get(pairing.to) !== 1) {
      continue;
    }
    pairings.push(pairing);
  }
  return pairings;
}

function pushCandidate<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
    return;
  }
  existing.push(value);
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Whether every verb in the set is a store access. */
function isStorageVerbs(verbs: Set<Relation>): boolean {
  return [...verbs].every((verb) => verb === "reads" || verb === "writes");
}

function sameVerbs(a: Set<Relation>, b: Set<Relation>): boolean {
  return a.size === b.size && [...a].every((verb) => b.has(verb));
}

/** Whether two boundary labels pick out the same storage system, and are not the same boundary. */
function sameSystem(a: string, b: string): boolean {
  return a !== b && systemPrefix(a) === systemPrefix(b);
}

function systemPrefix(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(0, colon + 1);
}

function joinVerbs(verbs: Set<Relation>): string {
  const list = [...verbs];
  if (list.length < 2) {
    return list.join("");
  }
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function groupByBoundary<T extends { boundary: string }>(
  items: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const bucket = groups.get(item.boundary);
    if (bucket === undefined) {
      groups.set(item.boundary, [item]);
      continue;
    }
    bucket.push(item);
  }
  return groups;
}

/**
 * What this run could not settle, for a declared effect nothing
 * matched. A callee or a store the code reaches through a variable is
 * a name only once a deployment says what the variable is, so a
 * document that names one is unverified here rather than wrong, and
 * the sentence says which input would settle it.
 */
function unsettledNote(
  reached: CodeEffect[],
  declared: IntentEffect,
  deployment: Deployment,
): string {
  const variables = new Set<string>();
  for (const made of reached) {
    const reference = nameReference(made.binding);
    const variable =
      reference === null ? null : deployment.variableFor(reference);
    if (made.does === declared.does && variable !== null) {
      variables.add(variable);
    }
  }
  if (variables.size === 0) {
    return "";
  }

  const named = [...variables].sort().join(", ");
  return ` The code says which one through ${named}, and nothing in this run says what that is set to. Read the deployment that sets it in and check again.`;
}

/**
 * Whether an effect the code makes is the one the intent declared. The
 * boundary is resolved with `namesBoundary`, the matcher that resolves
 * what somebody types at `suss ask`, so a document and a question that
 * spell a store the same way pick out the same one.
 */
export function effectMatches(
  declared: IntentEffect,
  made: CodeEffect,
): boolean {
  return (
    declared.does === made.does &&
    namesBoundary(declared.names, made.binding) &&
    statesAll(declared.fields, made.fields) &&
    statesAll(declared.by, made.by)
  );
}

/**
 * Whether the access covers every column the intent stated. An access
 * that states none is unread rather than empty: no pack parses a
 * DynamoDB UpdateExpression, so calling that a mismatch would report
 * working code for a gap in extraction. One that asked for all of them
 * covers whatever the intent stated.
 */
function statesAll(declared: string[], made: string[]): boolean {
  if (
    declared.length === 0 ||
    made.length === 0 ||
    made.includes(EVERY_FIELD)
  ) {
    return true;
  }
  return declared.every((one) => made.includes(one));
}

/**
 * Whether the branch reaching an outcome turns on what the intent's
 * `when` said. The boundary resolves through `namesBoundary`, the same
 * matcher a declared effect and `suss ask` use, and `finds` has to
 * agree when the clause states it.
 *
 * Only a clause that says which boundary gets here; the rest are prose
 * to this pass, and the README says so.
 */
function conditionMet(
  declared: IntentCondition & { at: IntentEffect },
  turnsOn: BoundaryGuard[],
): boolean {
  return turnsOn.some(
    (guard) =>
      guard.does === declared.at.does &&
      namesBoundary(declared.at.names, guard.binding) &&
      (declared.finds === null || declared.finds === guard.polarity),
  );
}

function toCodeOutcome(
  t: Transition,
  calls: Map<string, BoundaryCall>,
  deployment: Deployment,
): CodeOutcome | null {
  const ending = endingOf(t);
  if (ending === null) {
    return null;
  }
  return {
    ...ending,
    effects: codeEffectsOf(t, deployment),
    turnsOn: boundaryGuardsOf(t, calls).map((guard) => ({
      ...guard,
      binding: groundBinding(guard.binding, deployment),
    })),
    line: t.location.start,
  };
}

/** A `when` clause that says which boundary the branch read. */
type BoundaryClause = IntentCondition & { at: IntentEffect };

/** The clauses of an outcome's `when` this pass can settle against a branch. */
function boundaryClauses(outcome: IntentOutcome): BoundaryClause[] {
  return outcome.conditions.filter((c): c is BoundaryClause => c.at !== null);
}

/**
 * Whether a code transition produces a declared outcome: it ends the
 * way the outcome says, and its branch turns on every boundary the
 * outcome's `when` mentions. An outcome that states only its effects
 * has no ending to narrow by, so every transition produces it.
 */
function producesOutcome(outcome: IntentOutcome, co: CodeOutcome): boolean {
  if (outcome.kind === "effect") {
    return true;
  }
  return (
    outcomeMatches(outcome, co) &&
    boundaryClauses(outcome).every((c) => conditionMet(c, co.turnsOn))
  );
}

/**
 * The `always` block, one transition at a time. Each transition that
 * produces a declared outcome has to have every `always` effect, unless
 * an outcome it produces is listed under `except`. A transition that
 * does not produce any declared outcome is left to `undeclaredOutcome`.
 */
function checkAlwaysEffects(
  intent: BoundaryIntentSummary,
  impl: BehavioralSummary,
  boundary: string,
  codeOutcomes: CodeOutcome[],
  everyEffect: CodeEffect[],
  deployment: Deployment,
): { findings: IntentFinding[]; vanished: VanishedBoundaryUse[] } {
  const findings: IntentFinding[] = [];
  const vanished: VanishedBoundaryUse[] = [];
  if (intent.always.length === 0) {
    return { findings, vanished };
  }

  for (const co of codeOutcomes) {
    const produced = intent.outcomes.filter((o) => producesOutcome(o, co));
    if (produced.length === 0) {
      continue;
    }

    for (const always of intent.always) {
      // When the code could be producing two outcomes, one exempt, the
      // checker cannot tell which, and reporting it would be a guess.
      if (produced.some((o) => always.except.includes(o.id))) {
        continue;
      }

      if (co.effects.some((made) => effectMatches(always.effect, made))) {
        continue;
      }
      const outcome = produced.find((o) => o.kind !== "effect") ?? produced[0];
      const finding: IntentFinding = {
        kind: "pathWithoutEffect",
        severity: "error",
        boundary,
        intent: { name: intent.name, outcomeId: outcome.id },
        code: codeRef(impl),
        message: `Intent "${intent.name}" says every outcome results in ${describeEffect(always.effect)} at ${boundary}; the transition of ${impl.identity.name} at line ${co.line}, which produces ${describeProduced(outcome)}, does not. Add the effect on that path, or list ${outcome.id} under except.${unsettledNote(co.effects, always.effect, deployment)}`,
      };
      findings.push(finding);
      if (neverTouchesBoundary(always.effect.names, everyEffect)) {
        vanished.push({
          finding,
          boundary: always.effect.names,
          does: always.effect.does,
          kind: "effect",
          effect: always.effect,
          reached: co.effects,
        });
      }
    }
  }
  return { findings, vanished };
}

/** How a transition ends, in the terms intent states an ending in. */
export type CodeEnding = Pick<
  CodeOutcome,
  "kind" | "status" | "body" | "errorType"
>;

/**
 * How a transition ends, or null for an ending intent has no word for,
 * such as a render. A status the code computes has no literal, so it
 * comes back null and matches no declared status.
 */
export function endingOf(t: Transition): CodeEnding | null {
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

/** One verb and one boundary this transition reaches. */
export interface CodeEffect {
  does: Relation;
  binding: BoundaryBinding;
  /** How a report writes that boundary, for a message about it. */
  label: string;
  /** The columns the access states, empty when it states none. */
  fields: string[];
  /** What the access picks the item out by, empty when it states none. */
  by: string[];
}

/** Every verb and boundary the transition reaches, grounded against the deployment. */
export function codeEffectsOf(
  t: Transition,
  deployment: Deployment,
): CodeEffect[] {
  const reached: CodeEffect[] = [];
  for (const effect of t.effects) {
    if (effect.type !== "interaction") {
      continue;
    }
    // The container an access written under a relation reaches comes
    // from the provider's contract, which this pass never loads.
    if (goesThroughRelation(effect.interaction)) {
      continue;
    }
    // The drafter writes the grounded name, so the code side has to be
    // read the same way or a document suss wrote would not match the
    // code it was written from.
    const binding = groundBinding(effect.binding, deployment);
    const label = displayLabel(binding);
    const touched = accessDetail(effect.interaction);
    for (const does of relationsOf(effect.interaction)) {
      reached.push({ does, binding, label, ...touched });
    }
  }
  return reached;
}

/**
 * The fields an access states: a storage access's columns and key, or
 * the variable a config read takes, which is a field of the runtime's
 * contract. Nothing for any other class.
 */
export function accessDetail(interaction: Interaction): {
  fields: string[];
  by: string[];
} {
  if (interaction.class === "config-read") {
    return { fields: [interaction.name], by: [] };
  }

  if (interaction.class !== "storage-access") {
    return { fields: [], by: [] };
  }
  return {
    fields: interaction.fields,
    by: interaction.selector ?? [],
  };
}

/** Whether the code ends the way the intent says. The body is compared elsewhere. */
export function outcomeMatches(
  intent: Pick<IntentOutcome, "kind" | "status" | "errorType">,
  code: CodeEnding,
): boolean {
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
  return true; // any return matches, and the body is compared separately
}

/**
 * What each protocol needs before an intent doc written against one of
 * its boundaries can be paired, in the doc author's terms. The
 * drafter gives the same reason for a boundary it could not write.
 */
export function whatWouldKeyIt(protocol: Semantics["name"]): string {
  return WHAT_KEYS[protocol];
}

const WHAT_KEYS: Record<Semantics["name"], string> = {
  rest: "a REST boundary needs a method and a path",
  "function-call":
    "a function-call boundary needs package + exportPath, or module + exportName where the module is one suss.json lists",
  "message-bus": "a message-bus boundary needs a channel",
  storage:
    "a store has no key at all: write it as `- writes: <store>` on an outcome of the boundary that touches it instead",
  "graphql-resolver": "a resolver needs a type name and a field name",
  "graphql-operation": "an operation pairs by document rather than by key",
  "runtime-config":
    "a runtime-config boundary needs a deployment target and an instance name",
  metric: "a metric needs a system and a type",
  "unit-invocation":
    "an invoked unit needs a deployment target and the name the platform knows it by",
};

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

/** An outcome's id, and how it ends when it states an ending. */
function describeProduced(outcome: IntentOutcome): string {
  if (outcome.kind === "effect") {
    return outcome.id;
  }
  return `${outcome.id} (${describeOutcome(outcome)})`;
}

function describeEffect(effect: IntentEffect): string {
  const detail = [
    effect.fields.length > 0 ? `of ${effect.fields.join(", ")}` : null,
    effect.by.length > 0 ? `by ${effect.by.join(", ")}` : null,
  ].filter((part) => part !== null);
  return [EFFECT_PHRASE[effect.does], effect.names, ...detail].join(" ");
}

const EFFECT_PHRASE: Record<EffectRelation, string> = {
  reads: "a read of",
  writes: "a write to",
  invokes: "an invoke of",
};
