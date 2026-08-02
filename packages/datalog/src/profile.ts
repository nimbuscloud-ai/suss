// Measuring where evaluation spends its time.
//
// Asking "which rule is expensive" needs numbers the engine is the only
// thing positioned to give: a rule's cost is spread across joins that no
// caller can see from outside. A CPU profile answers this at the level of
// `unify` and `lookup`, which says how the engine works but not which rule
// asked for the work.
//
// Nothing here runs unless a caller wraps its evaluation in
// `profileEvaluation`. The engine checks whether any scope is open once
// per rule attempt and once per round, never per tuple, and the
// allocating part sits inside that branch, so an unprofiled run does the
// work it did before.

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
  /** How many times the rule was evaluated, over all rounds and deltas. */
  attempts: number;
}

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
}

// Every open scope, outermost first. A charge goes to all of them, so a
// caller profiling a whole extraction and a caller profiling one pass
// inside it both get a complete picture.
const open: Collector[] = [];

/** Whether anything is listening. The engine's hot path checks this. */
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
): void {
  const existing = into.get(key);
  if (existing === undefined) {
    into.set(key, { head, body, ms, derived, attempts: 1 });
    return;
  }
  existing.ms += ms;
  existing.derived += derived;
  existing.attempts += 1;
}

/**
 * Charge `ms` and `derived` tuples to one rule. Called per rule attempt.
 * `ruleSet` names the rule set the rule belongs to, so the same relation
 * derived by two rule sets does not blur into one line.
 */
export function chargeRule(
  ruleSet: string,
  head: string,
  body: string[],
  ms: number,
  derived: number,
): void {
  const key = ruleKey(head, body);
  for (const collector of open) {
    addCost(collector.rules, key, head, body, ms, derived);
    addCost(setIn(collector, ruleSet).rules, key, head, body, ms, derived);
  }
}

/** Note that a caller asked for a fixpoint of `ruleSet`. */
export function chargeEvaluation(ruleSet: string): void {
  for (const collector of open) {
    collector.evaluations += 1;
    setIn(collector, ruleSet).evaluations += 1;
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
  // No guard for "nobody is listening" here. The engine asks whether any
  // scope is open before it walks its relations, and a second check would
  // be a branch no test can reach.
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
 * evaluates rules on the same thread meanwhile is charged here too. One
 * extraction at a time is the case this is built for.
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

const byCost = (a: RuleCost, b: RuleCost): number => b.ms - a.ms;

function summarise(mine: Collector): EvaluationProfile {
  return {
    wallMs: performance.now() - mine.startedAt,
    datalogMs: totalMs(mine.rules.values()),
    rounds: mine.rounds,
    evaluations: mine.evaluations,
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
    return `    ${ms} ${share(r.ms, datalogMs)} ${derived} tuples  ${r.attempts} attempts  ${ruleKey(r.head, r.body)}`;
  });
}

/** Render a profile as the table a human reads in a terminal. */
export function formatProfile(profile: EvaluationProfile): string {
  const lines: string[] = [];
  lines.push(
    `datalog: ${profile.datalogMs.toFixed(0)}ms (${share(profile.datalogMs, profile.wallMs).trim()} of ${profile.wallMs.toFixed(0)}ms wall), ${profile.evaluations} evaluations, ${profile.rounds} rounds`,
  );

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
