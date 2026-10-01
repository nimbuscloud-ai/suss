import {
  failureDeliveryFor,
  redirectDeliveryFor,
  statusAccessorsFor,
  successAccessorsFor,
} from "../contract/declaredContract.js";
import { catchIsUncertain } from "../contract/partlyRead.js";
import { predicatesMatch } from "../match.js";
import { consumerDiscriminatesByContent } from "./contentDiscrimination.js";
import {
  type DeclaredStatusRange,
  extractResponseStatus,
  extractResponseStatusRange,
  hasOpaqueStatus,
  isSuccessStatus,
  makeBoundary,
  makeSide,
  refLooksLikeStatus,
  type StatusAccessors,
  statusesNamedIn,
} from "./responseMatch.js";
import {
  branchHandlesStatus,
  branchStatusRanges,
  consumerHandlesStatus,
  fallthroughGuards,
  guardsForBranch,
} from "./statusRanges.js";

import type {
  BehavioralSummary,
  Finding,
  Predicate,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";

/**
 * The redirects a client that follows redirects never hands back. A 300
 * or a 304 still reaches the caller, because there is no single place to
 * go next.
 */
const FOLLOWED_REDIRECTS: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/**
 * Whether the consumer has anything at all for a status the provider
 * can send. Four things count, and the README beside this file says why
 * each one does: a branch that admits the status, a fall-through over
 * the 2xx class, a guard on a body field only the failing status
 * returns, and a client that throws rather than returning a response.
 */
export function coverageOf(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): (status: number) => boolean {
  const handles = consumerHandlesStatus(consumer);
  const accessors = statusAccessorsFor(consumer);
  const successAccessors = successAccessorsFor(consumer);
  // A branch whose guards never mention the status runs on a success
  // whatever else it tests, the same as a fall-through does.
  const runsOnSuccess = consumer.transitions.some(
    (ct) =>
      ct.isDefault ||
      ct.conditions.every(
        (p) => !mentionsStatus(p, accessors, successAccessors),
      ),
  );
  const discriminatesByContent = consumerDiscriminatesByContent(
    provider,
    consumer,
  );
  // A client that throws on failure sends it to this consumer's catch,
  // or out of the function to a caller this pair does not include.
  // Neither path drops the status in a branch written for a success.
  const throwsFailuresElsewhere = failureDeliveryFor(consumer) === "exception";

  return (status) => {
    if (isSuccessStatus(status)) {
      return handles(status) || runsOnSuccess;
    }
    return (
      handles(status) ||
      discriminatesByContent(status) ||
      throwsFailuresElsewhere
    );
  };
}

export function checkProviderCoverage(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): Finding[] {
  // The caller handles the status of a response it is handed, and this
  // pair does not include that caller.
  if (handsResponseToCaller(consumer)) {
    return [];
  }

  const findings: Finding[] = [];
  const boundary = makeBoundary(provider, consumer);
  const statusAccessors = statusAccessorsFor(consumer);
  const successAccessors = successAccessorsFor(consumer);

  const covers = coverageOf(provider, consumer);
  const followsRedirects = redirectDeliveryFor(consumer) === "followed";

  const providerByStatus = new Map<number, Transition[]>();

  for (const pt of provider.transitions) {
    // The provider may never send it, so a consumer is not asked to handle it.
    if (catchIsUncertain(pt)) {
      continue;
    }

    if (hasOpaqueStatus(pt)) {
      findings.push({
        kind: "lowConfidence",
        boundary,
        provider: makeSide(provider, pt.id),
        consumer: makeSide(consumer),
        description: `One of the provider's statuses could not be read, so coverage cannot be confirmed`,
        severity: "info",
      });
      continue;
    }

    const status = extractResponseStatus(pt);
    if (status == null) {
      const range = extractResponseStatusRange(pt);
      // A range is one response that may arrive with any status in it,
      // so covering any member covers the range, and an uncovered range
      // gets one finding.
      if (range !== null && !rangeIsCovered(range, covers)) {
        findings.push({
          kind: "unhandledProviderCase",
          boundary,
          provider: makeSide(provider, pt.id),
          consumer: makeSide(consumer),
          description: `Provider produces statuses in the ${range.spec} range but no consumer branch handles any of them`,
          severity: "warning",
        });
      }
      continue;
    }

    // The client goes on to the next URL, so the caller never sees this one.
    if (followsRedirects && FOLLOWED_REDIRECTS.has(status)) {
      continue;
    }

    if (!covers(status)) {
      findings.push({
        kind: "unhandledProviderCase",
        boundary,
        provider: makeSide(provider, pt.id),
        consumer: makeSide(consumer),
        description: `Provider produces status ${status} but no consumer branch handles it`,
        // Whether the missing branch is a defect depends on intent the
        // repository does not state, so a person judges it (#471).
        severity: "warning",
      });
      continue;
    }

    if (!providerByStatus.has(status)) {
      providerByStatus.set(status, []);
    }
    providerByStatus.get(status)?.push(pt);
  }

  // When the provider returns one status under several conditions, such
  // as two 200s, check whether the consumer tells them apart. One that
  // never looks at the response has no way to and no reason to.
  const looksAtResponse = consumer.transitions.some(
    (ct) =>
      ct.expectedInput != null ||
      ct.conditions.some((p) =>
        mentionsStatus(p, statusAccessors, successAccessors),
      ),
  );
  for (const [status, providerTransitions] of looksAtResponse
    ? providerByStatus
    : []) {
    if (providerTransitions.length <= 1) {
      continue;
    }

    const consumerForStatus = consumer.transitions.filter(
      (ct) =>
        (ct.isDefault && isSuccessStatus(status)) ||
        branchHandlesStatus(
          ct.conditions,
          guardsForBranch(ct, statusAccessors, successAccessors),
          status,
        ),
    );

    const consumerNonStatusPredicates = consumerForStatus.flatMap((ct) =>
      getNonStatusConditions(ct, statusAccessors, successAccessors),
    );

    // A consumer with no condition beyond the status treats every
    // sub-case the same way.
    if (consumerNonStatusPredicates.length === 0) {
      const conditionalProviderTransitions = providerTransitions.filter(
        (pt) => !pt.isDefault && pt.conditions.length > 0,
      );

      if (conditionalProviderTransitions.length > 0) {
        for (const pt of conditionalProviderTransitions) {
          findings.push({
            kind: "unhandledProviderCase",
            boundary,
            provider: makeSide(provider, pt.id),
            consumer: makeSide(consumer),
            description: `Provider returns status ${status} in ${providerTransitions.length} different situations, and the consumer treats them all the same`,
            severity: "warning",
          });
        }
      }
      continue;
    }

    for (const pt of providerTransitions) {
      if (pt.isDefault || pt.conditions.length === 0) {
        continue;
      }

      const ptNonStatus = getNonStatusConditions(
        pt,
        statusAccessors,
        successAccessors,
      );
      if (ptNonStatus.length === 0) {
        continue;
      }

      const matched = ptNonStatus.some((provPred) =>
        consumerNonStatusPredicates.some(
          (consPred) => predicatesMatch(provPred, consPred) === "match",
        ),
      );

      if (!matched) {
        // An opaque or unresolved predicate on either side cannot be compared.
        const hasOpaque = ptNonStatus.some((provPred) =>
          consumerNonStatusPredicates.some(
            (consPred) => predicatesMatch(provPred, consPred) === "unknown",
          ),
        );

        if (hasOpaque) {
          findings.push({
            kind: "lowConfidence",
            boundary,
            provider: makeSide(provider, pt.id),
            consumer: makeSide(consumer),
            description: `Provider returns status ${status} under a condition that could not be compared with the consumer's branches`,
            severity: "info",
          });
        }
        // Structured predicates that do not match are expected. Provider
        // conditions test server state and consumer conditions test response
        // fields, and checkBodyCompatibility compares the fields.
      }
    }
  }

  return findings;
}

/**
 * Whether the consumer returns the response object itself, as a thin
 * wrapper such as `setup() { return fetch(url) }` does. Client libraries
 * call that object `Response`, or a generic such as `AxiosResponse<T>`,
 * and a body type such as `UserResponse` is left out.
 */
function handsResponseToCaller(consumer: BehavioralSummary): boolean {
  return consumer.transitions.some(
    (ct) =>
      ct.output.type === "return" &&
      ct.output.value !== null &&
      shapeHasResponse(ct.output.value),
  );
}

const RESPONSE_OBJECT = /^(\w+\.)*Response$|^\w*Response<.+>$/;

function shapeHasResponse(shape: TypeShape): boolean {
  if (shape.type === "ref") {
    return RESPONSE_OBJECT.test(withoutPromise(shape.name));
  }

  if (shape.type === "record") {
    return Object.values(shape.properties).some(shapeHasResponse);
  }

  if (shape.type === "union") {
    return shape.variants.some(shapeHasResponse);
  }
  return false;
}

function withoutPromise(name: string): string {
  const inner = /^Promise<(.+)>$/.exec(name.trim());
  return inner === null ? name.trim() : withoutPromise(inner[1] ?? "");
}

/** Whether the consumer covers at least one status a declared range admits. */
function rangeIsCovered(
  range: DeclaredStatusRange,
  covers: (status: number) => boolean,
): boolean {
  for (let status = range.min; status <= range.max; status++) {
    if (covers(status)) {
      return true;
    }
  }
  return false;
}

/**
 * The conditions on a transition that test something other than the
 * status. These are what tell the sub-cases of one status apart.
 */
function getNonStatusConditions(
  t: Transition,
  accessors: StatusAccessors,
  successAccessors: StatusAccessors,
): Predicate[] {
  return t.conditions.filter(
    (p) => !isStatusPredicate(p, accessors, successAccessors),
  );
}

/** Whether `p` says anything about the status, by range or by one number. */
function mentionsStatus(
  p: Predicate,
  accessors: StatusAccessors,
  successAccessors: StatusAccessors,
): boolean {
  return (
    isStatusPredicate(p, accessors, successAccessors) ||
    statusesNamedIn([p], accessors).length > 0
  );
}

/**
 * Whether `p` tests the response status, as opposed to what came back
 * in the body. A `!res.ok` guard arrives as a compound of two
 * comparisons, so the range reader is asked as well as the two direct
 * cases below.
 */
function isStatusPredicate(
  p: Predicate,
  accessors: StatusAccessors,
  successAccessors: StatusAccessors,
): boolean {
  if (p.type === "comparison") {
    return (
      refLooksLikeStatus(p.left, accessors) ||
      refLooksLikeStatus(p.right, accessors)
    );
  }
  if (p.type === "negation") {
    return isStatusPredicate(p.operand, accessors, successAccessors);
  }
  return (
    branchStatusRanges([p], fallthroughGuards(accessors, successAccessors)) !==
    null
  );
}
