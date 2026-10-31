/**
 * A rule compiled for the join. Every variable and constant in the rule
 * gets a numbered slot, and the join keeps its bindings in one array of
 * those slots. For each set of body literals a branch has matched, a
 * step plan says which columns of every other literal are fixed and by
 * which slot, so the join looks that up instead of working it out again
 * at every step.
 *
 * Which slots have a value depends only on which literals have matched,
 * because a match binds every variable in its literal and nothing else
 * binds one. So a branch that backs out has nothing to undo. A slot
 * written further down counts as empty again, and the next match
 * overwrites it.
 */

import type { Atom, Literal, Rule, Tuple } from "./index.js";

/** What reading one literal involves once the literals in a step's mask have matched. */
export interface LiteralStep {
  negated: boolean;
  arity: number;
  /** The columns a constant or a bound variable fixes, lowest first, and the slot with each value. */
  fixedColumns: readonly number[];
  fixedSlots: readonly number[];
  /** The fixed columns below 31 as a bitmask, the key of the index over several columns. */
  combinedMask: number;
  combinedSlots: readonly number[];
  /** Filled from `combinedSlots` right before each lookup. */
  combinedValues: Atom[];
  /** The first column a bound variable fixes, or -1. A read is noted there before any constant's column. */
  noteColumn: number;
  noteSlot: number;
  /** Columns a match has to agree with already, and the slot each is compared to. */
  checkColumns: readonly number[];
  checkSlots: readonly number[];
  /** Columns whose value a match writes into an empty slot. */
  writeColumns: readonly number[];
  writeSlots: readonly number[];
  /** Columns with a variable this same literal wrote further left. */
  repeatColumns: readonly number[];
  repeatSlots: readonly number[];
}

/** What a branch reads next once the literals in `taken` have matched. */
export interface StepPlan {
  taken: number;
  /** Per slot, whether it has a value here. */
  bound: readonly boolean[];
  /** Per body position, how to read that literal from here, or undefined once it is taken. */
  literals: readonly (LiteralStep | undefined)[];
  /**
   * The literals the join weighs next, in body order: negated ones with
   * every variable bound, and positive ones with a column fixed.
   */
  candidates: readonly number[];
  /** The first untaken positive literal, read whole when no candidate is, or -1. */
  scanWhole: number;
  /** The step after taking each literal, filled in the first time a branch gets there. */
  following: (StepPlan | undefined)[];
}

export interface JoinPlan {
  rule: Rule;
  /** A number of its own, so a database can keep each plan's relations in an array. */
  id: number;
  /** The body positions of the rule's positive literals, in written order. */
  positives: readonly number[];
  /** The mask with every body literal taken. */
  whole: number;
  /** Every slot, with each constant already in place, copied for each tagged join. */
  initialSlots: readonly (Atom | undefined)[];
  /**
   * The slots an untagged join works in. Nothing it calls runs caller
   * code, so no other join of this rule can start while one is running,
   * and constant slots are never written, so it needs no fresh copy.
   */
  slots: (Atom | undefined)[];
  /** Per body literal, the slot of each of its terms. */
  termSlots: readonly (readonly number[])[];
  headSlots: readonly number[];
  /** The first head variable no positive literal binds, which a derivation reports. */
  unboundInHead: string | null;
  start: StepPlan;
  steps: Map<number, StepPlan>;
}

const plans = new WeakMap<Rule, JoinPlan>();

let plansCompiled = 0;

/** The plan for a rule, compiled the first time a join runs it. */
export function joinPlanOf(rule: Rule): JoinPlan {
  const known = plans.get(rule);
  if (known !== undefined) {
    return known;
  }
  const plan = compile(rule);
  plans.set(rule, plan);
  return plan;
}

function compile(rule: Rule): JoinPlan {
  const variables = new Map<string, number>();
  const constants = new Map<Atom, number>();
  const initialSlots: (Atom | undefined)[] = [];
  const slotOf = (term: Literal["terms"][number]): number => {
    if (term.type === "variable") {
      let slot = variables.get(term.name);
      if (slot === undefined) {
        slot = initialSlots.length;
        variables.set(term.name, slot);
        initialSlots.push(undefined);
      }
      return slot;
    }
    let slot = constants.get(term.value);
    if (slot === undefined) {
      slot = initialSlots.length;
      constants.set(term.value, slot);
      initialSlots.push(term.value);
    }
    return slot;
  };
  const termSlots = rule.body.map((literal) => literal.terms.map(slotOf));
  const headSlots = rule.head.terms.map(slotOf);
  const boundByBody = new Set<string>();
  for (const literal of rule.body) {
    if (!literal.negated) {
      for (const term of literal.terms) {
        if (term.type === "variable") {
          boundByBody.add(term.name);
        }
      }
    }
  }
  const unbound = rule.head.terms.find(
    (term) => term.type === "variable" && !boundByBody.has(term.name),
  );
  const plan: JoinPlan = {
    rule,
    id: plansCompiled++,
    positives: rule.body
      .map((literal, index) => (literal.negated ? -1 : index))
      .filter((index) => index !== -1),
    whole: 2 ** rule.body.length - 1,
    initialSlots,
    slots: initialSlots.slice(),
    termSlots,
    headSlots,
    unboundInHead: unbound?.type === "variable" ? unbound.name : null,
    start: undefined as unknown as StepPlan,
    steps: new Map(),
  };
  plan.start = stepAt(plan, 0);
  return plan;
}

/** The step after a branch at `at` takes the literal at `index`. */
export function followingStep(
  plan: JoinPlan,
  at: StepPlan,
  index: number,
): StepPlan {
  let next = at.following[index];
  if (next === undefined) {
    next = stepAt(plan, at.taken | (1 << index));
    at.following[index] = next;
  }
  return next;
}

function stepAt(plan: JoinPlan, taken: number): StepPlan {
  const known = plan.steps.get(taken);
  if (known !== undefined) {
    return known;
  }
  const body = plan.rule.body;
  const bound = plan.initialSlots.map((value) => value !== undefined);
  body.forEach((literal, index) => {
    if (!literal.negated && taken & (1 << index)) {
      for (const slot of plan.termSlots[index]) {
        bound[slot] = true;
      }
    }
  });
  const literals = body.map((literal, index) =>
    taken & (1 << index)
      ? undefined
      : literalStep(literal, plan.termSlots[index], bound),
  );
  const candidates: number[] = [];
  let scanWhole = -1;
  literals.forEach((step, index) => {
    if (step === undefined) {
      return;
    }
    if (!step.negated && scanWhole === -1) {
      scanWhole = index;
    }
    const ready = step.negated
      ? step.fixedColumns.length === step.arity
      : step.fixedColumns.length > 0;
    if (ready) {
      candidates.push(index);
    }
  });
  const step: StepPlan = {
    taken,
    bound,
    literals,
    candidates,
    scanWhole,
    following: new Array(body.length).fill(undefined),
  };
  plan.steps.set(taken, step);
  return step;
}

function literalStep(
  literal: Literal,
  slots: readonly number[],
  bound: readonly boolean[],
): LiteralStep {
  const step = {
    negated: literal.negated,
    arity: slots.length,
    fixedColumns: [] as number[],
    fixedSlots: [] as number[],
    combinedMask: 0,
    combinedSlots: [] as number[],
    combinedValues: [] as Atom[],
    noteColumn: -1,
    noteSlot: -1,
    checkColumns: [] as number[],
    checkSlots: [] as number[],
    writeColumns: [] as number[],
    writeSlots: [] as number[],
    repeatColumns: [] as number[],
    repeatSlots: [] as number[],
  };
  const written = new Set<number>();
  slots.forEach((slot, column) => {
    if (!bound[slot]) {
      const [columns, into] = written.has(slot)
        ? [step.repeatColumns, step.repeatSlots]
        : [step.writeColumns, step.writeSlots];
      columns.push(column);
      into.push(slot);
      written.add(slot);
      return;
    }
    step.fixedColumns.push(column);
    step.fixedSlots.push(slot);
    step.checkColumns.push(column);
    step.checkSlots.push(slot);
    if (column < 31) {
      step.combinedMask |= 1 << column;
      step.combinedSlots.push(slot);
    }
    if (step.noteColumn === -1 && literal.terms[column]?.type === "variable") {
      step.noteColumn = column;
      step.noteSlot = slot;
    }
  });
  return step;
}

/**
 * Match a tuple against a literal, writing the values of the variables
 * it binds into their slots. A tuple that fails can leave some of those
 * slots written, and nothing reads them before the next match does.
 */
export function unify(
  step: LiteralStep,
  tuple: Tuple,
  values: (Atom | undefined)[],
): boolean {
  if (tuple.length !== step.arity) {
    return false;
  }
  const checks = step.checkColumns;
  const checkSlots = step.checkSlots;
  for (let k = 0; k < checks.length; k++) {
    if (values[checkSlots[k] as number] !== tuple[checks[k] as number]) {
      return false;
    }
  }
  const writes = step.writeColumns;
  const writeSlots = step.writeSlots;
  for (let k = 0; k < writes.length; k++) {
    values[writeSlots[k] as number] = tuple[writes[k] as number];
  }
  const repeats = step.repeatColumns;
  const repeatSlots = step.repeatSlots;
  for (let k = 0; k < repeats.length; k++) {
    if (values[repeatSlots[k] as number] !== tuple[repeats[k] as number]) {
      return false;
    }
  }
  return true;
}

/**
 * The tuple a body literal or the head gives under the current slots.
 * A derived fact stays in the database for the whole run, and `map`
 * sizes its array exactly, where an array grown by `push` keeps room
 * for about seventeen atoms.
 */
function tupleIn(
  slots: readonly number[],
  values: readonly (Atom | undefined)[],
): Tuple {
  return slots.map((slot) => values[slot] as Atom);
}

export function headTuple(
  plan: JoinPlan,
  values: readonly (Atom | undefined)[],
): Tuple {
  if (plan.unboundInHead !== null) {
    throw new Error(
      `unbound variable "${plan.unboundInHead}" in head of "${plan.rule.head.relation}"`,
    );
  }
  return tupleIn(plan.headSlots, values);
}

/** A negated literal's tuple, for a literal the step lists as a candidate. */
export function groundNegated(
  plan: JoinPlan,
  index: number,
  values: readonly (Atom | undefined)[],
): Tuple {
  return tupleIn(plan.termSlots[index] as readonly number[], values);
}

/**
 * The error for a branch left with only negated literals, each with a
 * variable no positive literal binds. The message gives the first such
 * variable of the first literal left.
 */
export function unboundNegated(plan: JoinPlan, at: StepPlan): Error {
  const index = at.literals.findIndex((step) => step !== undefined);
  const literal = plan.rule.body[index] as Literal;
  const column = (plan.termSlots[index] as readonly number[]).findIndex(
    (slot) => !at.bound[slot],
  );
  const term = literal.terms[column] as { name: string };
  return new Error(
    `unbound variable "${term.name}" in negated literal "${literal.relation}": ` +
      "negated literals may only use variables bound by earlier positive literals",
  );
}
