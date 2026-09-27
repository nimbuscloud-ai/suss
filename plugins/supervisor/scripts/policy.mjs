/**
 * What the hooks pass on to the agent, and when.
 *
 * An agent acts on everything it is told, so after an edit the hook
 * tells it less than a CI run would. It passes on a finding the edit
 * introduced when the finding is an error, or a warning at a boundary
 * the edit changed. Everything else new waits for the report at the end
 * of the turn. A finding that was there before the edit is never passed
 * on, because the agent did not cause it.
 */

/** @typedef {import("./types.js").SinceFinding} SinceFinding */
/** @typedef {import("./types.js").SinceReport} SinceReport */
/** @typedef {import("./types.js").EditResult} EditResult */
/** @typedef {import("./types.js").IntentVerdicts} IntentVerdicts */

/**
 * Kinds whose other half is usually the agent's next edit: a field
 * declared before the code that reads it, or a producer written before
 * its consumer. They wait for the end of the turn.
 */
export const WAIT_FOR_STOP = new Set([
  "boundaryFieldUnused",
  "contractOperationUnimplemented",
  "messageBusProducerOrphan",
  "messageBusConsumerOrphan",
  "messageBusUnused",
]);

/**
 * Whether a finding still counts once `.sussignore` has had its say. A
 * rule that marks or hides a finding means somebody accepted it; a rule
 * that downgrades it leaves it counting at the lower severity.
 *
 * @param {SinceFinding} finding
 */
export function stillCounts(finding) {
  return (
    finding.suppressed === undefined ||
    finding.suppressed.effect === "downgrade"
  );
}

/** @param {SinceFinding} finding */
function passedOnAfterEdit(finding) {
  if (WAIT_FOR_STOP.has(finding.kind)) {
    return false;
  }
  if (finding.severity === "error") {
    return true;
  }
  return finding.severity === "warning" && finding.atChangedBoundary;
}

/**
 * What the hook tells the agent about one edit, from `suss check --since`
 * run against the summaries from before the edit.
 *
 * @param {SinceReport} report
 * @param {number} covers
 * @returns {EditResult}
 */
export function editResult(report, covers) {
  return {
    covers,
    changed: report.changedBoundaries,
    blocking: report.findings.filter(
      (finding) => stillCounts(finding) && passedOnAfterEdit(finding),
    ),
    resolved: report.resolved.filter(stillCounts),
    notes: [],
  };
}

/** @param {EditResult} result */
export function saysAnything(result) {
  return (
    result.changed.filter(hasName).length +
      result.blocking.length +
      result.resolved.length +
      result.notes.length >
    0
  );
}

/**
 * Whether a changed boundary is one the agent and the developer can
 * name. A call between two functions in the project has no name, and
 * the agent already knows which functions it edited. A suss older than
 * the `label` field gives no way to tell, so its boundaries all count.
 *
 * @param {import("./types.js").ChangedBoundary} boundary
 */
export function hasName(boundary) {
  return boundary.label !== null;
}

/**
 * Several results delivered together, oldest first, as one. A finding
 * an earlier edit introduced and a later one resolved is dropped from
 * both lists, since there is nothing left to act on.
 *
 * @param {EditResult[]} results
 * @returns {EditResult}
 */
export function mergeResults(results) {
  const blocking = results.flatMap((result) => result.blocking);
  const resolved = results.flatMap((result) => result.resolved);
  const cameAndWent = new Set(
    blocking
      .map((finding) => finding.identity)
      .filter((identity) =>
        resolved.some((gone) => gone.identity === identity),
      ),
  );
  const changed = new Map();
  for (const boundary of results.flatMap((result) => result.changed)) {
    changed.set(boundary.key, boundary);
  }
  return {
    covers: Math.max(0, ...results.map((result) => result.covers)),
    changed: [...changed.values()],
    blocking: blocking.filter((finding) => !cameAndWent.has(finding.identity)),
    resolved: resolved.filter((finding) => !cameAndWent.has(finding.identity)),
    notes: results.flatMap((result) => result.notes),
  };
}

/**
 * What the change list stops the agent on, as keys for the stop record.
 * A list the agent wrote wrong blocks, since the agent can fix it. A
 * check suss itself could not run never blocks, since the agent cannot.
 *
 * @type {{ [K in IntentVerdicts["kind"]]: (intent: Extract<IntentVerdicts, { kind: K }>) => string[] }}
 */
const BLOCKED_ON = {
  checked: (intent) => [
    ...intent.check.entries
      .filter((entry) => entry.verdict === "notDone")
      .map((entry) => `not done: ${entry.said}`),
    ...intent.check.notAsked.map((change) => `not asked: ${change.identity}`),
  ],
  unreadable: (intent) => [`unreadable: ${intent.why}`],
  failed: () => [],
};

/**
 * Each entry not done, each boundary changed where nobody asked and no
 * `explained` line keeps the change, and a list suss could not read.
 * Each blocks once, like a finding.
 *
 * @param {IntentVerdicts | null} intent
 * @param {Set<string>} alreadyBlocked
 * @returns {string[]} what the stop blocks on, as keys for the record
 */
export function blocksOnIntent(intent, alreadyBlocked) {
  if (intent === null) {
    return [];
  }
  // The table is typed per kind, and a lookup by a runtime kind loses
  // that narrowing, so the cast happens once here.
  const keysOf = /** @type {(intent: IntentVerdicts) => string[]} */ (
    BLOCKED_ON[intent.kind]
  );
  return keysOf(intent).filter((key) => !alreadyBlocked.has(key));
}

/**
 * The new errors a stop blocks on: each one once, so the agent is asked
 * about a finding at most one time and the loop always ends.
 *
 * @param {SinceFinding[]} findings
 * @param {Set<string>} alreadyBlocked
 */
export function blocksStop(findings, alreadyBlocked) {
  return findings.filter(
    (finding) =>
      finding.severity === "error" &&
      stillCounts(finding) &&
      !alreadyBlocked.has(finding.identity),
  );
}
