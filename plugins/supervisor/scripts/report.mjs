/**
 * The text the hooks hand to the agent and the developer.
 *
 * Claude Code cuts any one hook message at 10,000 characters and puts
 * the rest in a file nobody is asked to read, so every list here stops
 * well short of that and says how much it left out.
 */

/** @typedef {import("./types.js").SinceFinding} SinceFinding */
/** @typedef {import("./types.js").EditResult} EditResult */
/** @typedef {import("./types.js").ChangedBoundary} ChangedBoundary */
/** @typedef {import("./types.js").RunFinding} RunFinding */

const FINDINGS_LISTED = 12;
const BOUNDARIES_LISTED = 6;
const CATALOG = "https://suss.sh/reference/findings";

/**
 * What the agent reads after an edit. `subject` says which edits the
 * result covers: this one, or earlier ones whose result arrived late.
 *
 * @param {EditResult} result
 * @param {string} subject
 */
export function renderEditReport(result, subject) {
  const lines = [headlineOf(result, subject)];
  for (const finding of result.blocking.slice(0, FINDINGS_LISTED)) {
    lines.push("", ...renderFinding(finding));
  }

  if (result.blocking.length > FINDINGS_LISTED) {
    lines.push(
      "",
      `${result.blocking.length - FINDINGS_LISTED} more like these. Run \`suss check\` to see them all.`,
    );
  }
  return [...lines, ...result.notes.map((note) => `suss: ${note}`)].join("\n");
}

/**
 * @param {EditResult} result
 * @param {string} subject
 */
function headlineOf(result, subject) {
  const parts = [];
  if (result.changed.length > 0) {
    parts.push(`${subject} changed ${listOfBoundaries(result.changed)}`);
  }

  if (result.blocking.length > 0) {
    const count = result.blocking.length;
    parts.push(
      `introduced ${count === 1 ? "a finding" : `${count} findings`} to deal with before moving on`,
    );
  }

  if (result.resolved.length > 0) {
    parts.push(`resolved ${result.resolved.map(shortName).join(", ")}`);
  }
  if (parts.length === 0) {
    return `suss: ${subject} changed no boundary.`;
  }
  return `suss: ${joinClauses(parts)}.`;
}

/**
 * One finding in full: what it says, both sides, and how to accept it
 * when it is intended.
 *
 * @param {SinceFinding} finding
 */
export function renderFinding(finding) {
  return [
    `[${finding.severity.toUpperCase()}] ${shortName(finding)}`,
    `  ${oneLine(finding.description)}`,
    `  provider: ${sideOf(finding.provider)}`,
    `  consumer: ${sideOf(finding.consumer)}`,
    ...howToAccept(finding),
    `  When this kind of finding is expected: ${CATALOG}#${finding.kind.toLowerCase()}`,
  ];
}

/** @param {SinceFinding} finding */
function howToAccept(finding) {
  if (finding.rule === undefined) {
    return [
      "  Fix it in the code. No .sussignore rule can accept this finding alone, because it points at no transition.",
    ];
  }
  return [
    "  Fix it in the code. If the behavior is intended, add this rule to .sussignore.yml with the reason, and tell the developer:",
    ...renderRule(finding.rule).map((line) => `    ${line}`),
  ];
}

/**
 * A `.sussignore` rule as YAML, ready to paste under `rules:`.
 *
 * @param {NonNullable<SinceFinding["rule"]>} rule
 */
export function renderRule(rule) {
  const lines = [`- kind: ${rule.kind}`];
  if (rule.boundary !== undefined) {
    lines.push(`  boundary: ${JSON.stringify(rule.boundary)}`);
  }

  for (const side of /** @type {const} */ (["provider", "consumer"])) {
    const transitionId = rule[side]?.transitionId;
    if (transitionId !== undefined) {
      lines.push(
        `  ${side}: { transitionId: ${JSON.stringify(transitionId)} }`,
      );
    }
  }
  lines.push("  reason: <why this is intended>");
  return lines;
}

/**
 * What the developer reads when the agent stops, or the agent reads when
 * a new error keeps it from stopping.
 *
 * @param {{
 *   since: string,
 *   diffs: string[],
 *   added: SinceFinding[],
 *   resolved: SinceFinding[],
 *   blocking: SinceFinding[],
 *   run: RunFinding[],
 *   caveats: string[],
 * }} report
 */
export function renderStopReport(report) {
  const lines = [...stopHeadline(report.blocking, report.since)];
  for (const diff of report.diffs) {
    lines.push("", diff.trimEnd());
  }
  lines.push(
    ...findingList(`New findings since ${report.since}:`, report.added),
    ...findingList("Resolved:", report.resolved),
  );
  for (const finding of report.run) {
    lines.push(
      "",
      `${finding.kind}: ${finding.description}`,
      `  ${finding.remedy}`,
    );
  }

  for (const caveat of report.caveats) {
    lines.push("", caveat);
  }
  return lines.join("\n");
}

/**
 * @param {SinceFinding[]} blocking
 * @param {string} since
 */
function stopHeadline(blocking, since) {
  if (blocking.length === 0) {
    return [`suss: what changed since ${since}.`];
  }
  const one = blocking.length === 1;
  const lines = [
    `suss: this turn introduced ${one ? "an error" : `${blocking.length} errors`}. Fix ${one ? "it" : "them"} before finishing, or accept ${one ? "it" : "each one"} with the rule shown and tell the developer why.`,
  ];
  for (const finding of blocking) {
    lines.push("", ...renderFinding(finding));
  }
  lines.push("", `What changed since ${since}:`);
  return lines;
}

/**
 * @param {string} heading
 * @param {SinceFinding[]} findings
 */
function findingList(heading, findings) {
  if (findings.length === 0) {
    return [];
  }
  const lines = ["", heading];
  for (const finding of findings.slice(0, FINDINGS_LISTED)) {
    lines.push(
      `  [${finding.severity.toUpperCase()}] ${shortName(finding)}: ${oneLine(finding.description)}`,
    );
  }
  if (findings.length > FINDINGS_LISTED) {
    lines.push(`  and ${findings.length - FINDINGS_LISTED} more.`);
  }
  return lines;
}

/** @param {SinceFinding} finding */
function shortName(finding) {
  return `${finding.kind} at ${finding.boundaryKey}`;
}

/** @param {string} text */
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** @param {SinceFinding["provider"]} side */
function sideOf(side) {
  return `${side.summary} (${side.location.file}:${side.location.range.start})`;
}

/** @param {ChangedBoundary[]} changed */
function listOfBoundaries(changed) {
  const named = changed.slice(0, BOUNDARIES_LISTED).map((b) => b.key);
  const left = changed.length - named.length;
  return left > 0
    ? `${named.join(", ")} and ${left} more boundaries`
    : joinClauses(named);
}

/**
 * "a", "a and b", or "a, b and c".
 *
 * @param {string[]} parts
 */
function joinClauses(parts) {
  if (parts.length <= 1) {
    return parts.join("");
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
