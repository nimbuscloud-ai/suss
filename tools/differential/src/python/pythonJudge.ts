// pythonJudge.ts: adjudicate Python extraction claims against the
// running app.
//
// The verdicts carry over from the handler differential, adapted to
// what v0 Python summaries claim, which is boundary declarations
// rather than condition-gated transitions:
//
// - falseClaim: a summary names a method and path the running app
//   does not serve, or declares a literal status a well-formed probe
//   contradicts. The claim asserted something about the app and was
//   wrong.
// - uncovered: the app serves a route no summary claims, no pathless
//   summary owns by name, and no generated intent classifies as a
//   documented abstention. Observed behavior unaccounted for.
//
// Abstention is never a finding. A summary whose binding names no
// path (or a route discovery declines entirely, the flask-restx
// non-literal-path shape) counts toward the abstention rate, the
// cost metric the run reports rather than hides.

import type { BehavioralSummary, RestSemantics } from "@suss/behavioral-ir";
import type { ObservedEndpoint } from "./pythonObserve.js";
import type { PyRouteIntent } from "./pythonProgram.js";

/** One path-and-status claim read off a summary's boundary binding and declared transition. */
export interface PyClaim {
  name: string;
  method: string;
  path: string;
  status: number | null;
}

export interface PyFinding {
  verdict: "falseClaim" | "uncovered" | "harnessFailure";
  detail: string;
}

export interface PyJudgment {
  findings: PyFinding[];
  intentsTotal: number;
  claimedIntents: number;
  abstainedIntents: number;
}

function restSemanticsOf(summary: BehavioralSummary): RestSemantics | null {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || binding === undefined) {
    return null;
  }
  return binding.semantics.name === "rest" ? binding.semantics : null;
}

function declaredStatus(summary: BehavioralSummary): number | null {
  for (const transition of summary.transitions) {
    if (transition.output.type !== "response") {
      continue;
    }
    const statusCode = transition.output.statusCode;
    if (
      statusCode !== null &&
      statusCode.type === "literal" &&
      typeof statusCode.value === "number"
    ) {
      return statusCode.value;
    }
  }
  return null;
}

/** Split a program's summaries into path claims and the names that abstained from one. */
export function readSummaryClaims(summaries: BehavioralSummary[]): {
  claims: PyClaim[];
  abstainedNames: Set<string>;
} {
  const claims: PyClaim[] = [];
  const abstainedNames = new Set<string>();
  for (const summary of summaries) {
    const semantics = restSemanticsOf(summary);
    if (semantics === null) {
      continue;
    }
    if (semantics.path === null || semantics.method === null) {
      abstainedNames.add(summary.identity.name);
      continue;
    }
    claims.push({
      name: summary.identity.name,
      method: semantics.method,
      path: semantics.path,
      status: declaredStatus(summary),
    });
  }
  return { claims, abstainedNames };
}

const endpointKey = (method: string, path: string): string =>
  `${method} ${path}`;

export interface JudgePythonInput {
  intents: PyRouteIntent[];
  summaries: BehavioralSummary[];
  endpoints: ObservedEndpoint[];
  /** The observer's per-program import or probe failure, when it had one. */
  observationError: string | null;
}

export function judgePythonProgram(input: JudgePythonInput): PyJudgment {
  const findings: PyFinding[] = [];
  const { claims, abstainedNames } = readSummaryClaims(input.summaries);
  const claimedNames = new Set(claims.map((claim) => claim.name));
  const counts = {
    intentsTotal: input.intents.length,
    claimedIntents: input.intents.filter((intent) =>
      claimedNames.has(intent.name),
    ).length,
  };

  if (input.observationError !== null) {
    return {
      findings: [
        {
          verdict: "harnessFailure",
          detail: `the generated app did not come up:\n${input.observationError}`,
        },
      ],
      ...counts,
      abstainedIntents: counts.intentsTotal - counts.claimedIntents,
    };
  }

  const observedByKey = new Map<string, ObservedEndpoint>();
  for (const endpoint of input.endpoints) {
    observedByKey.set(endpointKey(endpoint.method, endpoint.path), endpoint);
  }
  const intentByName = new Map(
    input.intents.map((intent) => [intent.name, intent]),
  );

  for (const claim of claims) {
    const observed = observedByKey.get(endpointKey(claim.method, claim.path));
    if (observed === undefined) {
      findings.push({
        verdict: "falseClaim",
        detail: `${claim.name} claims ${claim.method} ${claim.path}, but the running app serves no route there`,
      });
      continue;
    }
    if (claim.status !== null && observed.status !== claim.status) {
      findings.push({
        verdict: "falseClaim",
        detail: `${claim.name} declares status ${claim.status} at ${claim.method} ${claim.path}, but a well-formed request answered ${observed.status}`,
      });
    }
  }

  const claimedKeys = new Set(
    claims.map((claim) => endpointKey(claim.method, claim.path)),
  );
  for (const endpoint of input.endpoints) {
    if (claimedKeys.has(endpointKey(endpoint.method, endpoint.path))) {
      continue;
    }
    if (abstainedNames.has(endpoint.unit)) {
      continue;
    }
    const intent = intentByName.get(endpoint.unit);
    if (intent === undefined) {
      findings.push({
        verdict: "harnessFailure",
        detail: `the app serves ${endpoint.method} ${endpoint.path} through "${endpoint.unit}", which no generated intent names: a renderer bug, not a finding`,
      });
      continue;
    }
    if (intent.expectation === "abstain") {
      continue;
    }
    findings.push({
      verdict: "uncovered",
      detail: `the app serves ${endpoint.method} ${endpoint.path} through "${endpoint.unit}", but no summary claims it and none abstains over it`,
    });
  }

  // Renderer and runtime must agree on what is served, or a finding
  // could be an artifact of the generator's own bookkeeping.
  for (const intent of input.intents) {
    for (const served of intent.servedPaths) {
      if (!observedByKey.has(endpointKey(intent.method, served))) {
        findings.push({
          verdict: "harnessFailure",
          detail: `the generator expected ${intent.method} ${served} ("${intent.name}") to be served and the app does not serve it: a renderer bug, not a finding`,
        });
      }
    }
  }

  return {
    findings,
    ...counts,
    abstainedIntents: counts.intentsTotal - counts.claimedIntents,
  };
}
