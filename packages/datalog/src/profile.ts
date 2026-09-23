/**
 * Per-rule timing and row counts for an evaluation. A rule's cost is
 * spread across joins no caller can see, and a CPU profile stops at
 * `unify` and `lookup` without saying which rule asked for the work, so
 * the engine records these itself.
 *
 * Nothing here runs unless a caller wraps its evaluation in
 * `profileEvaluation`. The engine checks whether a scope is open once
 * per rule attempt and once per round, never per tuple, and allocates
 * only inside that branch, so an unprofiled run pays one check per rule.
 */

/** What one rule cost, summed over every attempt across every round. */
export interface RuleCost {
  /** The relation this rule derives. */
  head: string;
  /** The body relations, in order, so a rule is recognisable in a report. */
  body: string[];
  /** Wall time spent evaluating this rule. */
  ms: number;
  /** Tuples this rule added that no earlier derivation had reached. */
  derived: number;
  /**
   * Rows the join read for this rule. A rule that examines a hundred
   * thousand rows to derive a dozen tuples is doing a walk somebody
   * meant to be a lookup, and `derived` alone never shows that.
   */
  examined: number;
  /** How many times the rule was evaluated, over all rounds and deltas. */
  attempts: number;
}

/** A question the engine gave up on, and how much it had read by then. */
export interface AbandonedQuestion {
  /** What the caller was asking, in whatever words the caller uses. */
  question: string;
  examined: number;
}

/**
 * How a caller that asks one question at a time got on. `skipped` counts
 * the questions it never asked because the run's row budget was spent.
 */
export interface QuestionTally {
  asked: number;
  abandoned: number;
  skipped: number;
}

/** How one question ended, for the tally. */
export type QuestionOutcome = keyof Omit<QuestionTally, "asked">;

/**
 * How big a relation grew. `derived` separates the relations rules
 * concluded from the base facts an adapter emitted, because "derive fewer
 * tuples" is advice about the first kind and meaningless about the second.
 */
export interface RelationSize {
  relation: string;
  tuples: number;
  derived: boolean;
}

/**
 * What one rule set cost. A run evaluates several over several databases,
 * and somebody comparing two changes wants to know which of them moved,
 * so the totals are kept apart as well as summed.
 */
export interface RuleSetCost {
  /** The relations this rule set derives, which is how to tell them apart. */
  derives: string[];
  ms: number;
  evaluations: number;
  rounds: number;
  rules: RuleCost[];
}

export interface EvaluationProfile {
  /** Wall time for everything the profiled scope did, datalog or not. */
  wallMs: number;
  /** Wall time inside rule evaluation, which is the engine's own cost. */
  datalogMs: number;
  /** Semi-naive rounds, summed over strata. The seed round counts as one. */
  rounds: number;
  /**
   * How many times a caller asked for a fixpoint. A caller that queries
   * as it goes evaluates once per query, and each of those re-joins the
   * whole relation against a small delta, so this number rising with
   * corpus size is worth more attention than the rule table.
   */
  evaluations: number;
  /** Rows every join read, summed over every rule set. */
  examined: number;
  /**
   * The most rows any one `evaluate` call read. A caller that asks a
   * question at a time sizes a per-question budget off this, where the
   * total only says how many questions it asked.
   */
  largestEvaluation: number;
  /** Every question abandoned on its budget, in the order they were given up. */
  abandoned: AbandonedQuestion[];
  /** How many questions a one-at-a-time caller asked, and how they went. */
  questions: QuestionTally;
  /** Final tuple count per relation, largest first. */
  relations: RelationSize[];
  /** Per-rule cost across every rule set, most expensive first. */
  rules: RuleCost[];
  /** The same time, split by the rule set that spent it. */
  ruleSets: RuleSetCost[];
}

interface RuleSetCollector {
  derives: Set<string>;
  evaluations: number;
  rounds: number;
  rules: Map<string, RuleCost>;
}

interface Collector {
  startedAt: number;
  rounds: number;
  evaluations: number;
  rules: Map<string, RuleCost>;
  relations: Map<string, number>;
  derivedRelations: Set<string>;
  ruleSets: Map<string, RuleSetCollector>;
  abandoned: AbandonedQuestion[];
  largestEvaluation: number;
  questions: QuestionTally;
}

// Every open scope, outermost first. A charge goes to all of them, so a
// caller profiling a whole extraction and a caller profiling one pass
// inside it both get a complete picture.
const open: Collector[] = [];

/** Whether any profiling scope is open. The engine's hot path checks this. */
export const isProfiling = (): boolean => open.length > 0;

const ruleKey = (head: string, body: string[]): string =>
  `${head} <- ${body.join(", ")}`;

function addCost(
  into: Map<string, RuleCost>,
  key: string,
  head: string,
  body: string[],
  ms: number,
  derived: number,
  examined: number,
): void {
  const existing = into.get(key);
  if (existing === undefined) {
    into.set(key, { head, body, ms, derived, examined, attempts: 1 });
    return;
  }
  existing.ms += ms;
  existing.derived += derived;
  existing.examined += examined;
  existing.attempts += 1;
}

/**
 * Charge `ms`, `derived` tuples and `examined` rows to one rule. Called
 * per rule attempt. `ruleSet` says which rule set the rule belongs to, so
 * the same relation derived by two rule sets does not blur into one line.
 */
export function chargeRule(
  ruleSet: string,
  head: string,
  body: string[],
  ms: number,
  derived: number,
  examined: number,
): void {
  const key = ruleKey(head, body);
  for (const collector of open) {
    addCost(collector.rules, key, head, body, ms, derived, examined);
    addCost(
      setIn(collector, ruleSet).rules,
      key,
      head,
      body,
      ms,
      derived,
      examined,
    );
  }
}

/**
 * Note that a question was given up on. A caller reading this in a
 * profile is looking at the reason an answer came back empty, so the
 * question is recorded in the caller's own words.
 */
export function chargeAbandoned(question: string, examined: number): void {
  for (const collector of open) {
    collector.abandoned.push({ question, examined });
  }
}

/**
 * Count one question from a caller. Pass `outcome` when the question was
 * abandoned part way or skipped, and leave it out when it was answered.
 */
export function chargeQuestion(outcome?: QuestionOutcome): void {
  for (const collector of open) {
    collector.questions.asked += 1;
    if (outcome !== undefined) {
      collector.questions[outcome] += 1;
    }
  }
}

/** Note that a caller asked for a fixpoint of `ruleSet`. */
export function chargeEvaluation(ruleSet: string): void {
  for (const collector of open) {
    collector.evaluations += 1;
    setIn(collector, ruleSet).evaluations += 1;
  }
}

/** Note how many rows one finished or abandoned evaluation read. */
export function chargeEvaluationRows(examined: number): void {
  for (const collector of open) {
    if (examined > collector.largestEvaluation) {
      collector.largestEvaluation = examined;
    }
  }
}

/** Note that another semi-naive round ran. */
export function chargeRound(ruleSet: string): void {
  for (const collector of open) {
    collector.rounds += 1;
    setIn(collector, ruleSet).rounds += 1;
  }
}

function setIn(collector: Collector, ruleSet: string): RuleSetCollector {
  const existing = collector.ruleSets.get(ruleSet);
  if (existing !== undefined) {
    return existing;
  }
  const created: RuleSetCollector = {
    derives: new Set(ruleSet.split(", ")),
    evaluations: 0,
    rounds: 0,
    rules: new Map(),
  };
  collector.ruleSets.set(ruleSet, created);
  return created;
}

/**
 * Record how big each relation ended up. Reported once per `evaluate`, at
 * the end. A run evaluates several rule sets over several databases and the
 * same relation can appear in more than one, so the largest wins: the
 * question being asked is how many tuples a relation grows to, and a
 * smaller database's copy does not make the big one cheaper.
 */
export function chargeRelationSizes(
  entries: Iterable<[string, number]>,
  derivedRelations: Iterable<string>,
): void {
  // No check for an open scope here. The engine checks before it walks
  // its relations, and a second check would be a branch no test reaches.
  const sizes = [...entries];
  const derived = [...derivedRelations];
  for (const collector of open) {
    for (const [relation, tuples] of sizes) {
      const seen = collector.relations.get(relation) ?? 0;
      if (tuples > seen) {
        collector.relations.set(relation, tuples);
      }
    }
    for (const relation of derived) {
      collector.derivedRelations.add(relation);
    }
  }
}

/**
 * Run `fn` with evaluation profiling on, and hand back what it returned
 * alongside the numbers. Nested calls share the outer collector, so a
 * caller that profiles a whole extraction gets one profile covering every
 * `evaluate` inside it rather than a profile per call.
 */
export function profileEvaluation<T>(fn: () => T): {
  result: T;
  profile: EvaluationProfile;
} {
  const mine = openScope();
  try {
    return { result: fn(), profile: summarise(mine) };
  } finally {
    closeScope(mine);
  }
}

/**
 * The async twin, for callers whose extraction is a promise. The scope
 * stays open across every await inside `fn`, so anything else that
 * evaluates rules on the same thread meanwhile is charged here too. This
 * is built for the case of one extraction at a time.
 */
export async function profileEvaluationAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; profile: EvaluationProfile }> {
  const mine = openScope();
  try {
    return { result: await fn(), profile: summarise(mine) };
  } finally {
    closeScope(mine);
  }
}

function openScope(): Collector {
  const mine: Collector = {
    startedAt: performance.now(),
    rounds: 0,
    evaluations: 0,
    rules: new Map(),
    relations: new Map(),
    derivedRelations: new Set(),
    ruleSets: new Map(),
    abandoned: [],
    largestEvaluation: 0,
    questions: { asked: 0, abandoned: 0, skipped: 0 },
  };
  open.push(mine);
  return mine;
}

function closeScope(mine: Collector): void {
  const at = open.lastIndexOf(mine);
  if (at !== -1) {
    open.splice(at, 1);
  }
}

const totalMs = (rules: Iterable<RuleCost>): number => {
  let ms = 0;
  for (const cost of rules) {
    ms += cost.ms;
  }
  return ms;
};

const totalExamined = (rules: Iterable<RuleCost>): number => {
  let rows = 0;
  for (const cost of rules) {
    rows += cost.examined;
  }
  return rows;
};

const byCost = (a: RuleCost, b: RuleCost): number => b.ms - a.ms;

function summarise(mine: Collector): EvaluationProfile {
  return {
    wallMs: performance.now() - mine.startedAt,
    datalogMs: totalMs(mine.rules.values()),
    rounds: mine.rounds,
    evaluations: mine.evaluations,
    examined: totalExamined(mine.rules.values()),
    largestEvaluation: mine.largestEvaluation,
    abandoned: [...mine.abandoned],
    questions: { ...mine.questions },
    relations: [...mine.relations]
      .map(([relation, tuples]) => ({
        relation,
        tuples,
        derived: mine.derivedRelations.has(relation),
      }))
      .sort((a, b) => b.tuples - a.tuples),
    rules: [...mine.rules.values()].sort(byCost),
    ruleSets: [...mine.ruleSets.values()]
      .map((set) => ({
        derives: [...set.derives],
        ms: totalMs(set.rules.values()),
        evaluations: set.evaluations,
        rounds: set.rounds,
        rules: [...set.rules.values()].sort(byCost),
      }))
      .sort((a, b) => b.ms - a.ms),
  };
}

const share = (part: number, whole: number): string =>
  `${whole === 0 ? "0.0" : ((part / whole) * 100).toFixed(1)}%`.padStart(6);

function ruleLines(rules: RuleCost[], datalogMs: number): string[] {
  return rules.slice(0, 20).map((r) => {
    const ms = `${r.ms.toFixed(0)}ms`.padStart(8);
    const derived = String(r.derived).padStart(7);
    const examined = String(r.examined).padStart(9);
    return `    ${ms} ${share(r.ms, datalogMs)} ${derived} tuples ${examined} rows read  ${r.attempts} attempts  ${ruleKey(r.head, r.body)}`;
  });
}

/** Render a profile as the table a human reads in a terminal. */
export function formatProfile(profile: EvaluationProfile): string {
  const lines: string[] = [];
  lines.push(
    `datalog: ${profile.datalogMs.toFixed(0)}ms (${share(profile.datalogMs, profile.wallMs).trim()} of ${profile.wallMs.toFixed(0)}ms wall), ${profile.evaluations} evaluations, ${profile.rounds} rounds, ${profile.examined} rows read (${profile.largestEvaluation} in the biggest evaluation)`,
  );

  const { asked, abandoned, skipped } = profile.questions;
  if (asked > 0) {
    lines.push(
      `  ${asked} questions under a site: ${abandoned} given up part way, ${skipped} never put once the run's rows were spent`,
    );
  }

  for (const given of profile.abandoned) {
    lines.push(
      `  gave up on ${given.question} after reading ${given.examined} rows`,
    );
  }

  const derivedTuples = profile.relations
    .filter((r) => r.derived)
    .reduce((sum, r) => sum + r.tuples, 0);
  lines.push("  tuples by relation (d = derived by a rule):");
  for (const { relation, tuples, derived } of profile.relations.slice(0, 20)) {
    const mark = derived ? "d" : " ";
    const of = derived ? share(tuples, derivedTuples) : "     -";
    lines.push(`    ${mark} ${String(tuples).padStart(8)} ${of}  ${relation}`);
  }

  lines.push("  time by rule:");
  lines.push(...ruleLines(profile.rules, profile.datalogMs));

  if (profile.ruleSets.length > 1) {
    lines.push("  by rule set:");
    for (const set of profile.ruleSets) {
      lines.push(
        `    ${`${set.ms.toFixed(0)}ms`.padStart(8)} ${share(set.ms, profile.datalogMs)}  ${set.evaluations} evaluations, ${set.rounds} rounds  ${set.derives.join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}
