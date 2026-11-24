/**
 * The evaluator: the abstract value of one expression at the place it
 * is written. The engine runs the statements of the enclosing function
 * or module up to that expression, keeping a local heap so that a push
 * through an alias is seen by every name bound to the same array, then
 * evaluates the expression against that state. A name declared outside
 * the function is read at the point the function is written, and a name
 * declared in another file is read through the lowering's resolution. A
 * call is inlined when its callee is a project function whose body has
 * no loop, under a depth cap; a library call is looked up in the
 * lowering's rows; any other call is a hole. A sound evaluator gives a
 * hole wherever its value would not cover every run, and DESIGN.md lists
 * what it gives up to keep to that.
 */

import {
  type Callee,
  type Element,
  expressionBodyOf,
  type Field,
  type ForkTest,
  type FunctionBody,
  type FunctionShape,
  type Literal,
  type Lowering,
  type Parameter,
  type Row,
  type Site,
  statementsOf,
} from "./language.js";
import { join, joinAll, sameValue, widen } from "./lattice.js";
import {
  concat,
  constant,
  deferred,
  force,
  hole,
  type Item,
  text,
  unbounded,
  type Value,
} from "./value.js";

const INLINE_DEPTH_CAP = 3;
const STATEMENT_BUDGET = 20_000;

/**
 * Whether an outer read passes the allocation site to the lowering.
 *
 * A read of a receiver's own state depends on which instance reads it,
 * so it goes to the lowering with the site. An unfilled parameter does
 * not depend on the site. The site tells which instance the method was
 * called on and nothing about what a caller passed, so the value is the
 * same under every site. Passing the site would repeat one lookup for
 * every caller of a wrapper method.
 */
const UNDER_SITE = "under site";
const CONTEXT_FREE = "context free";
type OuterAsk = typeof UNDER_SITE | typeof CONTEXT_FREE;

/**
 * Whether an outer read is about a name or member read, or about a
 * call. A read that nothing wrote gets the value its declared type
 * allows. A call stays a hole whatever its return type is. When a call
 * returns a hole, the engine treats the arrays and records passed to it
 * as escaped, and a typed return value would lose that.
 */
const A_READ = "read";
const A_CALL = "call";
type OuterShape = typeof A_READ | typeof A_CALL;

/** Whether `valueAt` reads the expression a caller asked about, or one an outer read reached. */
const TARGET = "target";
const ELSEWHERE = "elsewhere";
type Reading = typeof TARGET | typeof ELSEWHERE;

interface State {
  readonly bindings: Map<string, Value>;
  readonly heap: Map<number, Value>;
  /** Parameters no call site filled; a read of one goes to the lowering. */
  readonly parameters: Set<string>;
  /**
   * The first allocation the function this state runs made. A caller may
   * still refer to anything made before it, through a name of its own.
   */
  readonly madeFrom: number;
  /**
   * Set on the state a run that takes arms builds for the function the
   * evaluated expression is written in, and nowhere else, so a fork in an
   * inlined call or an outer read is joined as it always is.
   */
  picks: Picks | null;
}

/** What a run that takes arms knows on the way to its target. */
interface Picks {
  /** The arm each key took on the way: the path entered it, or a guard left only it. */
  readonly decided: Map<string, number>;
  /** The names the conditions of those keys read. */
  readonly reads: Set<string>;
  /** Whether the run is inside an arm of a fork it left open. */
  inOpen: boolean;
  /** The key of the taken fork whose arm the run is in, or null. */
  under: string | null;
}

/**
 * A branch or `?:` a run met without settling its condition or taking
 * an arm of it, in the function the evaluated expression is written in.
 */
export interface Fork<N> {
  readonly at: N;
  readonly key: string;
  readonly arms: number;
  /** Whether the key's arm 0 is this fork's arm 1, as for `if (!x)` under the key `x`. */
  readonly negated: boolean;
  /** The key of the taken fork whose arm this one is in, or null at the top of the function. */
  readonly under: string | null;
}

/** What `forksIn` met. */
export interface ForksMet<N> {
  readonly forks: readonly Fork<N>[];
  /** False when an arm the run took returned or threw before the target. */
  readonly reached: boolean;
  /** True when the run used up its statement budget, so it may have skipped a fork. */
  readonly exhausted: boolean;
}

/** The arm a run takes at one fork, and the key a fork inside that arm is reported under. */
interface Taken {
  readonly arm: number;
  readonly picks: Picks;
  readonly under: string | null;
}

/** One run that takes arms: the arms it was given and the forks it met. */
interface ForkRun<N> {
  readonly arms: ReadonlyMap<string, number>;
  readonly met: Map<string, Fork<N>>;
  reached: boolean;
}

interface AllocatedByDeferredCall {
  readonly content: Value;
  /** The number of the deferred call whose content this is. */
  readonly madeBy: number;
}

interface Outcome {
  readonly returns: Value[];
  readonly completes: boolean;
}

/** A call's arguments: the positional ones in order and the keyword ones by name. */
interface Arguments {
  readonly positional: Value[];
  readonly named: Map<string, Value>;
  /**
   * False when a spread left the positions unknown, so an argument after
   * it may land on a different parameter than its index says.
   */
  readonly placed: boolean;
}

export interface EvaluateOptions<N = unknown> {
  /** Values for parameters of the enclosing function, from a call site. */
  readonly bindings?: ReadonlyMap<string, Value>;
  /**
   * The allocation site where the receiver behind this expression was
   * created. The lowering needs it for a name whose value depends on
   * which instance reads it.
   */
  readonly site?: string;
  /**
   * Values to take for some expressions instead of reading them. A
   * caller that needs to know which of several constructions a value
   * came from gives each construction a token of its own here. None of
   * the run is memoized, and the result comes back with nothing in it
   * left lazy.
   */
  readonly given?: ReadonlyMap<N, Value>;
  /**
   * The arm to take at each fork in the function the expression is
   * written in whose condition does not settle, by the fork's key from
   * `Lowering.forkTest`. The function's own statements are not memoized
   * in that run.
   */
  readonly arms?: ReadonlyMap<string, number>;
}

export interface EvaluatorOptions {
  /** How many statements one `evaluate` call may run before it stops. */
  readonly statementBudget?: number;
  /**
   * Give back a hole wherever the value would not cover every run, as the
   * header describes. A run that uses up its statement budget is a hole
   * too, since the statements it skipped could have returned anything.
   */
  readonly sound?: boolean;
}

export class Evaluator<N extends object> {
  private nextAllocation = 0;
  private statements = 0;
  /** The allocation site the current `evaluate` call is running under. */
  private underSite: string | undefined;
  /** The current call's `given` values, keyed by `idOf`. */
  private givenById: ReadonlyMap<unknown, Value> | undefined;
  private readonly statementBudget: number;
  private readonly sound: boolean;
  /** Whether the current `evaluate` call ran out of statements. */
  private exhausted = false;
  private readonly stateAfterStatement = new Map<unknown, State>();
  private readonly outerByNode = new Map<unknown, Value>();
  private readonly writtenByNode = new Map<unknown, Value>();
  /**
   * What each allocation a deferred call made contained when the call
   * returned, and which deferred call that was. A read can force the
   * call in one state and follow its `ref` in another that was copied
   * before the call ran, such as the state the memo kept after the
   * call's statement. That state's heap has no entry for the allocation,
   * and nothing in it has written to the allocation since, so this is
   * its content there.
   */
  private readonly allocatedByDeferredCalls = new Map<
    number,
    AllocatedByDeferredCall
  >();
  /** How many calls have been deferred, which numbers each one in the order it was made. */
  private deferredCalls = 0;
  private readonly computing = new Set<unknown>();
  /** The run that takes arms, while one is running. */
  private forkRun: ForkRun<N> | undefined;
  /** What each fork tests, by `idOf`, worked out once. */
  private readonly forkTests = new Map<unknown, ForkTest | null>();
  private readonly methodRows: ReadonlyMap<
    string,
    readonly Extract<Row, { kind: "method" }>[]
  >;
  private readonly calleeRows: ReadonlyMap<
    string,
    readonly Extract<Row, { kind: "callee" }>[]
  >;
  private readonly operatorRows: ReadonlyMap<
    string,
    Extract<Row, { kind: "operator" }>
  >;

  constructor(
    private readonly lowering: Lowering<N>,
    options: EvaluatorOptions = {},
  ) {
    this.statementBudget = options.statementBudget ?? STATEMENT_BUDGET;
    this.sound = options.sound ?? false;
    this.methodRows = groupBy(
      lowering.rows.filter((row) => row.kind === "method"),
      (row) => row.method,
    );
    this.calleeRows = groupBy(
      lowering.rows.filter((row) => row.kind === "callee"),
      (row) => row.origin.name,
    );
    this.operatorRows = new Map(
      lowering.rows
        .filter((row) => row.kind === "operator")
        .map((row) => [`${row.operator}/${row.arity}`, row]),
    );
  }

  private idOf(node: N): unknown {
    return this.lowering.idOf === undefined ? node : this.lowering.idOf(node);
  }

  /**
   * Whether this run may write to the memos. Every caller shares the
   * memos, and a value computed with a call site's bindings or under an
   * allocation site is true for one caller only.
   */
  private remembers(
    bindings: ReadonlyMap<string, Value> | null = null,
  ): boolean {
    return (
      bindings === null &&
      this.underSite === undefined &&
      this.givenById === undefined
    );
  }

  private same(a: N, b: N): boolean {
    return this.idOf(a) === this.idOf(b);
  }

  /**
   * The value of an expression where it is written. A value computed
   * under an allocation site is true only for that site, so it is forced
   * before the site is cleared and none of it goes into the memos.
   */
  evaluate(node: N, options: EvaluateOptions<N> = {}): Value {
    this.statements = 0;
    this.exhausted = false;
    // A run takes its arms as it goes, so what it leaves lazy comes out
    // the same when the caller forces it later.
    const { arms } = options;
    return arms === undefined
      ? this.runOf(node, options)
      : this.takingArms(newForkRun(arms), () => this.runOf(node, options));
  }

  private runOf(node: N, options: EvaluateOptions<N>): Value {
    if (this.sound) {
      return this.withinBudget(() =>
        forcedThrough(this.evaluateUnderSite(node, options)),
      );
    }
    if (options.given === undefined) {
      return this.evaluateUnderSite(node, options);
    }
    return this.withGiven(options.given, () =>
      forcedThrough(this.evaluateUnderSite(node, options)),
    );
  }

  /**
   * The forks that evaluating each of `nodes` under `options.arms` met
   * and left open, at the top of the function the nodes are written in
   * or directly inside an arm it took. A caller that wants one value per
   * arm reads them, picks an arm of one, and asks again.
   */
  forksIn(nodes: readonly N[], options: EvaluateOptions<N> = {}): ForksMet<N> {
    const run = newForkRun<N>(options.arms ?? new Map());
    let exhausted = false;
    for (const node of nodes) {
      this.statements = 0;
      this.exhausted = false;
      this.takingArms(run, () => this.runOf(node, options));
      exhausted = exhausted || this.exhausted;
    }
    return { forks: [...run.met.values()], reached: run.reached, exhausted };
  }

  private takingArms<T>(run: ForkRun<N>, compute: () => T): T {
    const previous = this.forkRun;
    this.forkRun = run;
    try {
      return compute();
    } finally {
      this.forkRun = previous;
    }
  }

  /**
   * A sound run that used up its budget skipped statements, so its value
   * is a hole, and the states it remembered on the way may be missing
   * those statements too.
   */
  private withinBudget(run: () => Value): Value {
    const value = run();
    if (!this.exhausted) {
      return value;
    }
    this.stateAfterStatement.clear();
    return hole("value");
  }

  /**
   * What a call gives each parameter of the function it calls, bound
   * the way an inlined call binds them: by keyword, by position, off a
   * destructured argument, or from a default. `options.bindings` fills
   * the parameters of the function the call is written in. Null when
   * the lowering cannot see the body of the function the call runs.
   */
  argumentsAt(
    call: N,
    options: EvaluateOptions<N> = {},
  ): ReadonlyMap<string, Value> | null {
    this.statements = 0;
    const shape = this.lowering.expression(call);
    const fn = this.lowering.callable(call);
    const callee = fn === null ? null : this.lowering.functionOf(fn);
    if (shape.kind !== "call" || callee === null) {
      return null;
    }
    return this.withGiven(options.given, () => {
      const site = this.lowering.siteOf(call);
      const outer =
        options.bindings === undefined || options.bindings.size === 0
          ? null
          : options.bindings;
      const state = site === null ? emptyState() : this.stateAt(site, outer, 0);
      const args = this.argumentsOf(shape.args, state, 0);
      const inner: State = {
        bindings: new Map(),
        heap: state.heap,
        parameters: new Set(),
        madeFrom: this.nextAllocation,
        picks: null,
      };
      this.bindParameters(callee, args, inner, 0);
      const bound = new Map<string, Value>();
      for (const [name, value] of inner.bindings) {
        bound.set(name, forcedThrough(this.materialize(value, inner)));
      }
      return bound;
    });
  }

  private withGiven<T>(
    given: ReadonlyMap<N, Value> | undefined,
    run: () => T,
  ): T {
    if (given === undefined) {
      return run();
    }
    const previous = this.givenById;
    this.givenById = new Map(
      [...given].map(([node, value]) => [this.idOf(node), value]),
    );
    try {
      return run();
    } finally {
      this.givenById = previous;
    }
  }

  private evaluateUnderSite(node: N, options: EvaluateOptions<N>): Value {
    if (options.site === undefined) {
      return this.valueAt(node, options, TARGET);
    }
    this.underSite = options.site;
    try {
      return force(this.valueAt(node, options, TARGET));
    } finally {
      this.underSite = undefined;
    }
  }

  /**
   * The value of `node` where it is written. Only the run a caller asked
   * for takes arms, and an outer read that comes back here does not.
   */
  private valueAt(
    node: N,
    options: EvaluateOptions<N> = {},
    reading: Reading = ELSEWHERE,
  ): Value {
    const shape = this.lowering.expression(node);
    if (shape.kind === "literal") {
      // A literal has the same value wherever it is written, so the
      // statements before it are skipped. Most values callers ask for
      // are literals.
      return literalValue(shape.value);
    }
    const site = this.lowering.siteOf(node);
    const picking = reading === TARGET && this.forkRun !== undefined;
    const state =
      site === null
        ? emptyState()
        : this.stateAt(site, options.bindings ?? null, 0, picking);
    return this.materialize(this.expression(node, state, 0), state);
  }

  private stateAt(
    site: Site<N>,
    bindings: ReadonlyMap<string, Value> | null,
    depth: number,
    picking = false,
  ): State {
    const shape = this.lowering.functionOf(site.root);
    const state = emptyState();
    if (picking) {
      state.picks = emptyPicks();
    }
    for (const { name } of shape?.parameters ?? []) {
      const supplied = bindings?.get(name);
      if (supplied === undefined) {
        state.parameters.add(name);
      } else {
        state.bindings.set(name, supplied);
      }
    }
    const body = shape === null ? [] : statementsOf(shape.body);
    // The memo keeps this function's states with every arm joined.
    const memo =
      !picking && this.remembers(bindings) ? this.stateAfterStatement : null;
    return this.runPath(body, site.path, state, site.root, depth, memo);
  }

  /**
   * The state before the last statement of `path`, having run every
   * statement that comes before it at each level of nesting.
   */
  private runPath(
    body: readonly N[],
    path: readonly N[],
    state: State,
    root: N,
    depth: number,
    memo: Map<unknown, State> | null,
  ): State {
    const [target, ...rest] = path;
    if (target === undefined) {
      return state;
    }
    const at = body.findIndex((stmt) => this.same(stmt, target));
    if (at === -1) {
      return state;
    }
    let current = state;
    let from = 0;
    if (memo !== null) {
      for (let i = at - 1; i >= 0; i--) {
        const stmt = body[i];
        const remembered =
          stmt === undefined ? undefined : memo.get(this.idOf(stmt));
        if (remembered !== undefined) {
          current = cloneState(remembered);
          from = i + 1;
          break;
        }
      }
    }
    for (let i = from; i < at; i++) {
      const stmt = body[i];
      if (stmt === undefined) {
        continue;
      }
      const outcome = this.execute(stmt, current, root, depth);
      memo?.set(this.idOf(stmt), cloneState(current));
      if (!outcome.completes) {
        this.notReached(current);
        break;
      }
    }
    if (rest.length === 0) {
      return current;
    }
    return this.descend(target, rest, current, root, depth, memo);
  }

  /** A run that takes arms and ended before its target cannot make the request its arms pick. */
  private notReached(state: State): void {
    if (state.picks !== null && this.forkRun !== undefined) {
      this.forkRun.reached = false;
    }
  }

  /**
   * Runs into the arm, loop body or block of `stmt` that contains the
   * rest of the path. The memo is passed down, because the state before
   * a nested statement depends only on the path to it, the same as at
   * the top level.
   */
  private descend(
    stmt: N,
    rest: readonly N[],
    state: State,
    root: N,
    depth: number,
    memo: Map<unknown, State> | null,
  ): State {
    const shape = this.lowering.statement(stmt);
    const next = rest[0];
    if (next === undefined) {
      return state;
    }
    if (shape.kind === "branch") {
      const index = shape.arms.findIndex((candidate) =>
        candidate.some((stmt) => this.same(stmt, next)),
      );
      const arm = shape.arms[index];
      if (arm !== undefined) {
        this.decide(stmt, index, shape.arms.length, state);
      }
      return arm === undefined
        ? state
        : this.runPath(arm, rest, state, root, depth, memo);
    }
    if (shape.kind === "loop") {
      const after = loopPass(state);
      this.run(shape.body, after, root, depth);
      const entry = this.afterLoop(state, after);
      return this.runPath(shape.body, rest, entry, root, depth, memo);
    }
    if (shape.kind === "block") {
      return this.runPath(shape.body, rest, state, root, depth, memo);
    }
    if (this.sound) {
      // Whatever the opaque statement ran before the target is unknown.
      const inside = cloneState(state);
      this.widenHeap(inside);
      return inside;
    }
    return state;
  }

  private run(
    body: readonly N[],
    state: State,
    root: N,
    depth: number,
  ): Outcome {
    const returns: Value[] = [];
    for (const stmt of body) {
      const outcome = this.execute(stmt, state, root, depth);
      returns.push(...outcome.returns);
      if (!outcome.completes) {
        return { returns, completes: false };
      }
    }
    return { returns, completes: true };
  }

  private execute(stmt: N, state: State, root: N, depth: number): Outcome {
    if (++this.statements > this.statementBudget) {
      this.exhausted = true;
      return { returns: [], completes: false };
    }
    const shape = this.lowering.statement(stmt);
    const completes: Outcome = { returns: [], completes: true };
    if (shape.kind === "declare") {
      for (const binding of shape.bindings) {
        const value =
          binding.value === null
            ? hole(binding.name)
            : named(this.expression(binding.value, state, depth), binding.name);
        state.bindings.set(
          binding.name,
          this.unlessNestedWrite(root, binding.name, value, state),
        );
      }
      return completes;
    }
    if (shape.kind === "assign") {
      this.assign(
        shape.target,
        shape.operator,
        shape.value,
        state,
        root,
        depth,
      );
      return completes;
    }
    if (shape.kind === "expression") {
      this.expression(shape.value, state, depth);
      return completes;
    }
    if (shape.kind === "branch") {
      return this.branch(stmt, shape.condition, shape.arms, state, root, depth);
    }
    if (shape.kind === "loop") {
      const after = loopPass(state);
      const outcome = this.run(shape.body, after, root, depth);
      replaceState(state, this.afterLoop(state, after));
      return { returns: outcome.returns, completes: true };
    }
    if (shape.kind === "return") {
      return {
        returns: [
          shape.value === null
            ? constant(undefined)
            : this.expression(shape.value, state, depth),
        ],
        completes: false,
      };
    }
    if (shape.kind === "throw") {
      return { returns: [], completes: false };
    }
    if (shape.kind === "block") {
      return this.run(shape.body, state, root, depth);
    }
    if (this.sound) {
      // The lowering could not say what this statement does, so it may
      // have returned anything and changed any object.
      this.widenHeap(state);
      return { returns: [hole("value")], completes: true };
    }
    return completes;
  }

  /**
   * A name some nested function writes to is unknown from its
   * declaration on, since that function can run at any point after. A
   * sound run reads only a name the lowering says is written once.
   */
  private unlessNestedWrite(
    root: N,
    name: string,
    value: Value,
    state: State,
  ): Value {
    if (this.sound) {
      return this.lowering.writtenOnce?.(root, name) === true
        ? value
        : hole(name);
    }
    if (!this.lowering.mutatedInNestedFunction(root, name)) {
      return value;
    }
    return named(widenAway(force(this.materialize(value, state))), name);
  }

  /**
   * The state after a loop that ran some unknown number of times. A sound
   * run keeps only what the body left as it was: a name the body bound
   * again is a hole, and an object the body changed is widened.
   */
  private afterLoop(before: State, after: State): State {
    if (!this.sound) {
      return widenState(before, after, this.allocatedByDeferredCalls);
    }
    return combineStates(
      before,
      after,
      (left, right) => (sameValue(left, right) ? left : hole("value")),
      this.allocatedByDeferredCalls,
      (left, right) => (sameValue(left, right) ? left : widenAway(right)),
    );
  }

  /** Every object this state can reach, widened, since code nobody can see may have changed it. */
  private widenHeap(state: State): void {
    for (const [id, content] of state.heap) {
      state.heap.set(id, widenAway(content));
    }
  }

  private branch(
    stmt: N,
    condition: N | null,
    arms: readonly (readonly N[])[],
    state: State,
    root: N,
    depth: number,
  ): Outcome {
    const settled =
      condition === null
        ? null
        : this.truthOf(this.expression(condition, state, depth), state);
    if (settled !== null && arms.length === 2) {
      const arm = arms[settled ? 0 : 1] ?? [];
      return this.run(arm, state, root, depth);
    }
    const taken = this.armTaken(stmt, arms.length, state);
    if (taken !== null) {
      const arm = arms[taken.arm] ?? [];
      return this.underTaken(taken, () => this.run(arm, state, root, depth));
    }
    const returns: Value[] = [];
    const completing: State[] = [];
    const completingArms: number[] = [];
    const ended: State[] = [];
    arms.forEach((arm, index) => {
      const armState = openArm(state);
      const outcome = this.run(arm, armState, root, depth);
      returns.push(...outcome.returns);
      (outcome.completes ? completing : ended).push(armState);
      if (outcome.completes) {
        completingArms.push(index);
      }
    });
    const [first, ...rest] = completing;
    const joined =
      first === undefined
        ? state
        : rest.reduce((acc, other) => this.joinedStates(acc, other), first);
    if (this.sound) {
      this.keepWhatArmsReturned(joined, ended);
    }
    if (first === undefined) {
      return { returns, completes: false };
    }
    replaceState(state, joined);
    if (state.picks !== null) {
      const differ = rest.some((other) => !sameState(first, other));
      this.leftOpen(stmt, arms.length, completingArms, differ, state);
    }
    return { returns, completes: true };
  }

  /**
   * The arm a run that takes arms takes at a fork: the one the caller
   * picked for its key, or the one the path to the target already fixed.
   * Null when the run does not take arms here.
   */
  private armTaken(fork: N, count: number, state: State): Taken | null {
    const picks = state.picks;
    const run = this.forkRun;
    const test =
      picks === null || run === undefined ? null : this.forkTestOf(fork);
    if (picks === null || run === undefined || test === null) {
      return null;
    }
    const picked = run.arms.get(test.key);
    const keyArm = picked ?? picks.decided.get(test.key);
    if (keyArm === undefined) {
      return null;
    }
    // An arm the path already fixed is part of where the run is, and
    // the forks in it sit where the fork itself does.
    return {
      arm: ownArm(test, keyArm, count),
      picks,
      under: picked === undefined ? picks.under : test.key,
    };
  }

  /** Runs both arms of a `?:` the run left open, where no fork is reported. */
  private inOpenArms<T>(state: State, run: () => T): T {
    const picks = state.picks;
    if (picks === null) {
      return run();
    }
    const outer = picks.inOpen;
    picks.inOpen = true;
    try {
      return run();
    } finally {
      picks.inOpen = outer;
    }
  }

  /** Runs an arm the run took, with the forks met in it reported as being under its key. */
  private underTaken<T>({ picks, under }: Taken, run: () => T): T {
    const outer = picks.under;
    picks.under = under;
    try {
      return run();
    } finally {
      picks.under = outer;
    }
  }

  /**
   * Fixes a fork's key to the arm the run went into, on the path to the
   * target or past a guard whose other arms return. A later fork with
   * that key takes the same arm.
   */
  private decide(fork: N, arm: number, count: number, state: State): void {
    const picks = state.picks;
    const test =
      picks === null || this.forkRun === undefined
        ? null
        : this.forkTestOf(fork);
    if (picks === null || test === null) {
      return;
    }
    picks.decided.set(test.key, ownArm(test, arm, count));
    for (const name of test.reads) {
      picks.reads.add(name);
    }
  }

  /**
   * After a branch the run left open: one completing arm is a guard,
   * which fixes the key; two or more that left the state different are a
   * fork the caller may pick an arm of.
   */
  private leftOpen(
    fork: N,
    count: number,
    completingArms: readonly number[],
    differ: boolean,
    state: State,
  ): void {
    const [only] = completingArms;
    if (completingArms.length === 1 && only !== undefined) {
      this.decide(fork, only, count, state);
      return;
    }
    if (differ) {
      this.report(fork, count, state);
    }
  }

  /**
   * Lists a fork the run left open at the top of the function, or right
   * inside an arm it took. A fork whose condition reads a name an
   * earlier condition decided is not listed, since its arms may depend
   * on that one in a way the keys do not show.
   */
  private report(fork: N, count: number, state: State): void {
    const picks = state.picks;
    const run = this.forkRun;
    const test =
      picks === null || run === undefined || picks.inOpen
        ? null
        : this.forkTestOf(fork);
    if (
      picks === null ||
      run === undefined ||
      test === null ||
      run.met.has(test.key) ||
      test.reads.some((name) => picks.reads.has(name))
    ) {
      return;
    }
    run.met.set(test.key, {
      at: fork,
      key: test.key,
      arms: count,
      negated: test.negated,
      under: picks.under,
    });
  }

  private forkTestOf(fork: N): ForkTest | null {
    const id = this.idOf(fork);
    const known = this.forkTests.get(id);
    if (known !== undefined) {
      return known;
    }
    const root = this.lowering.siteOf(fork)?.root ?? null;
    const test =
      root === null ? null : (this.lowering.forkTest?.(fork, root) ?? null);
    this.forkTests.set(id, test);
    return test;
  }

  /**
   * An arm that returned leaves behind the objects its return refers to,
   * as that arm left them. A sound run joins them into the state after
   * the branch, so reading a returned object reads every version of it.
   */
  private keepWhatArmsReturned(target: State, ended: readonly State[]): void {
    for (const arm of ended) {
      for (const [id, content] of arm.heap) {
        const kept = target.heap.get(id);
        target.heap.set(
          id,
          kept === undefined || sameValue(kept, content)
            ? content
            : join(kept, content),
        );
      }
    }
  }

  /** Whether a condition is true, by the language's rule, with an object read through its reference. */
  private truthOf(value: Value, state: State): boolean | null {
    return this.lowering.truthiness(this.contentOf(value, state));
  }

  /** The state where two arms meet. */
  private joinedStates(a: State, b: State): State {
    const joined = joinStates(a, b, this.allocatedByDeferredCalls);
    if (!this.sound) {
      return joined;
    }
    for (const [name, left] of a.bindings) {
      const right = b.bindings.get(name);
      if (right !== undefined) {
        joined.bindings.set(name, this.joinedValues(left, right, joined));
      }
    }
    return joined;
  }

  /**
   * Where two values meet. A plain run joins them. A sound run that meets
   * two objects nothing else refers to makes the first one both. Two
   * objects something else refers to become a copy of both, and both
   * are widened, since a later write through that other name would not
   * reach the copy. `bindingsLive` is false where the function's own
   * names end, at its return.
   */
  private joinedValues(
    left: Value,
    right: Value,
    state: State,
    bindingsLive = true,
  ): Value {
    const a = force(left);
    const b = force(right);
    if (!this.sound || sameValue(a, b)) {
      return join(a, b);
    }
    if (a.kind !== "ref" && b.kind !== "ref") {
      return join(a, b);
    }
    const joined = join(this.contentOf(a, state), this.contentOf(b, state));
    if (
      a.kind === "ref" &&
      b.kind === "ref" &&
      !this.referredElsewhere(a.id, state, bindingsLive) &&
      !this.referredElsewhere(b.id, state, bindingsLive)
    ) {
      state.heap.set(a.id, joined);
      return a;
    }
    this.escape(a, state);
    this.escape(b, state);
    return join(this.contentOf(a, state), this.contentOf(b, state));
  }

  /**
   * Whether anything but the value being joined may refer to an
   * allocation: a caller, for one made before this function ran, or a
   * name or another object in this state.
   */
  private referredElsewhere(
    id: number,
    state: State,
    bindingsLive: boolean,
  ): boolean {
    if (id < state.madeFrom) {
      return true;
    }
    const refersHere = (value: Value): boolean => {
      const forced = force(value);
      return forced.kind === "ref" && forced.id === id;
    };
    if (bindingsLive && [...state.bindings.values()].some(refersHere)) {
      return true;
    }
    return [...state.heap].some(
      ([other, content]) =>
        other !== id && valuesInside(content).some(refersHere),
    );
  }

  private assign(
    target: N,
    operator: string | null,
    valueNode: N,
    state: State,
    root: N,
    depth: number,
  ): void {
    const written = this.expression(valueNode, state, depth);
    const shape = this.lowering.expression(target);
    if (shape.kind === "name") {
      const value =
        operator === null
          ? named(written, shape.text)
          : this.operator(
              operator,
              [this.expression(target, state, depth), written],
              state,
            );
      state.bindings.set(
        shape.text,
        this.unlessNestedWrite(root, shape.text, value, state),
      );
      return;
    }
    if (shape.kind === "member") {
      this.writeField(shape.object, shape.name, written, state, depth);
      return;
    }
    if (shape.kind === "element") {
      const index = force(this.expression(shape.index, state, depth));
      const name =
        index.kind === "constant" && index.options.length === 1
          ? String(index.options[0])
          : null;
      this.writeField(shape.object, name, written, state, depth);
      return;
    }
    this.escape(written, state);
    this.widenHeapWhenSound(state);
  }

  /** A write to something the engine cannot follow, which a sound run takes to have changed any object. */
  private widenHeapWhenSound(state: State): void {
    if (this.sound) {
      this.widenHeap(state);
    }
  }

  /** A write to `object.name`. A null name is an index that did not evaluate to one value. */
  private writeField(
    object: N,
    name: string | null,
    written: Value,
    state: State,
    depth: number,
  ): void {
    const target = force(this.expression(object, state, depth));
    if (target.kind !== "ref") {
      this.escape(written, state);
      this.widenHeapWhenSound(state);
      return;
    }
    const content = this.allocationIn(state, target.id) ?? hole("value");
    if (content.kind === "record") {
      const fields = new Map(content.fields);
      if (name === null) {
        state.heap.set(target.id, { ...content, fields, open: true });
        return;
      }
      fields.set(name, { value: written, presence: "one" });
      state.heap.set(target.id, { ...content, fields });
      return;
    }
    if (content.kind === "sequence") {
      const at = name === null ? Number.NaN : Number(name);
      const items = [...content.items];
      const existing = items[at];
      if (Number.isInteger(at) && at >= 0 && at <= items.length) {
        items[at] = {
          value: written,
          presence: existing?.presence ?? "one",
        };
        state.heap.set(target.id, { kind: "sequence", items });
        return;
      }
      state.heap.set(
        target.id,
        unbounded(joinAll([...items.map((item) => item.value), written])),
      );
      return;
    }
    if (content.kind === "unbounded") {
      state.heap.set(target.id, unbounded(join(content.element, written)));
    }
  }

  private expression(node: N, state: State, depth: number): Value {
    const given = this.givenById?.get(this.idOf(node));
    if (given !== undefined) {
      return given;
    }
    const shape = this.lowering.expression(node);
    if (shape.kind === "literal") {
      return literalValue(shape.value);
    }
    if (shape.kind === "template") {
      return concat(
        shape.parts.map((part) =>
          "text" in part
            ? text(part.text)
            : this.expression(part.expression, state, depth),
        ),
      );
    }
    if (shape.kind === "name") {
      const bound = state.bindings.get(shape.text);
      if (bound !== undefined) {
        return bound;
      }
      if (this.sound) {
        return this.unwritten(node);
      }
      return this.outer(node, shape.text, !state.parameters.has(shape.text));
    }
    if (this.sound && (shape.kind === "member" || shape.kind === "element")) {
      // A getter, a prototype or a write through another name can each
      // change what a member read gives back, and whatever it gives back
      // is out of the engine's sight from then on.
      const object = this.expression(shape.object, state, depth);
      for (const inside of valuesInside(this.contentOf(object, state))) {
        this.escape(inside, state);
      }
      return this.unwritten(node);
    }
    if (shape.kind === "member") {
      return this.member(node, shape.object, shape.name, state, depth);
    }
    if (shape.kind === "element") {
      const index = force(this.expression(shape.index, state, depth));
      const name =
        index.kind === "constant" && index.options.length === 1
          ? String(index.options[0])
          : literalOfValue(index);
      return name === null
        ? this.unwritten(node)
        : this.member(node, shape.object, name, state, depth);
    }
    if (shape.kind === "array") {
      return this.allocate(this.arrayOf(shape.items, state, depth), state);
    }
    if (shape.kind === "record") {
      return this.allocate(this.recordOf(shape.fields, state, depth), state);
    }
    if (shape.kind === "call") {
      return this.call(
        node,
        shape.callee,
        shape.args,
        shape.constructs,
        state,
        depth,
      );
    }
    if (shape.kind === "operator") {
      return this.operator(
        shape.operator,
        shape.operands.map((operand) => this.expression(operand, state, depth)),
        state,
      );
    }
    if (shape.kind === "conditional") {
      const settled = this.truthOf(
        this.expression(shape.condition, state, depth),
        state,
      );
      if (settled !== null) {
        return this.expression(
          settled ? shape.whenTrue : shape.whenFalse,
          state,
          depth,
        );
      }
      const taken = this.armTaken(node, 2, state);
      if (taken !== null) {
        return this.underTaken(taken, () =>
          this.expression(
            taken.arm === 0 ? shape.whenTrue : shape.whenFalse,
            state,
            depth,
          ),
        );
      }
      const [whenTrue, whenFalse] = this.inOpenArms(state, () => [
        this.expression(shape.whenTrue, state, depth),
        this.expression(shape.whenFalse, state, depth),
      ]);
      this.report(node, 2, state);
      return this.joinedValues(whenTrue, whenFalse, state);
    }
    if (this.sound && shape.kind === "function") {
      // The function may run later, from anywhere, and change what it reads.
      this.escapeFreeNames(node, state);
    }
    return this.unwritten(node);
  }

  private allocate(content: Value, state: State): Value {
    const id = this.nextAllocation++;
    state.heap.set(id, content);
    return { kind: "ref", id };
  }

  /** What an allocation contains in this state, or undefined when this state cannot reach it. */
  private allocationIn(state: State, id: number): Value | undefined {
    return state.heap.get(id) ?? this.allocatedByDeferredCalls.get(id)?.content;
  }

  /** The content behind a value, with a `ref` followed into the heap. */
  private contentOf(value: Value, state: State): Value {
    const forced = force(value);
    if (forced.kind !== "ref") {
      return forced;
    }
    return this.allocationIn(state, forced.id) ?? hole("value");
  }

  private arrayOf(
    items: readonly Element<N>[],
    state: State,
    depth: number,
  ): Value {
    const known: Item[] = [];
    let widened: Value | null = null;
    for (const item of items) {
      const value = this.expression(item.node, state, depth);
      if (item.kind !== "spread") {
        known.push({ value, presence: "one" });
        continue;
      }
      const spread = this.contentOf(value, state);
      if (spread.kind === "sequence" && widened === null) {
        known.push(...spread.items);
        continue;
      }
      widened = joinAll([
        ...(widened === null ? [] : [widened]),
        ...known.map((entry) => entry.value),
        spread.kind === "unbounded" ? spread.element : hole("value"),
      ]);
    }
    return widened === null
      ? { kind: "sequence", items: known }
      : unbounded(widened);
  }

  private recordOf(
    fields: readonly Field<N>[],
    state: State,
    depth: number,
  ): Value {
    const known = new Map<string, Item>();
    let open = false;
    for (const field of fields) {
      if (field.kind === "spread") {
        const spread = this.contentOf(
          this.expression(field.node, state, depth),
          state,
        );
        if (spread.kind !== "record") {
          open = true;
          continue;
        }
        for (const [name, item] of spread.fields) {
          known.set(name, item);
        }
        open = open || spread.open;
        continue;
      }
      const value = this.expression(field.value, state, depth);
      if (field.kind === "field") {
        known.set(field.name, { value, presence: "one" });
        continue;
      }
      const name = literalOfValue(
        force(this.expression(field.name, state, depth)),
      );
      if (name === null) {
        open = true;
        continue;
      }
      known.set(name, { value, presence: "one" });
    }
    return { kind: "record", fields: known, open };
  }

  private member(
    node: N,
    objectNode: N,
    name: string,
    state: State,
    depth: number,
  ): Value {
    const object = this.expression(objectNode, state, depth);
    if (object.kind === "deferred") {
      // An object read from outside this function is already
      // materialized, so there is no heap to follow. When it is not a
      // record or a sequence, the lowering resolves the member read.
      return deferred(
        () => this.memberOf(force(object), name, node) ?? this.outerValue(node),
      );
    }
    return (
      this.memberOf(this.contentOf(object, state), name, node) ??
      this.declaredValue(node)
    );
  }

  /** What a record, a sequence or an unbounded list has under a name, or null when it is none of those. */
  private memberOf(content: Value, name: string, node: N): Value | null {
    if (content.kind === "record") {
      return this.fieldOf(content, name, node);
    }
    if (content.kind === "sequence") {
      if (name === "length") {
        return constant(content.items.length);
      }
      const item = content.items[Number(name)];
      return item === undefined ? this.unwritten(node) : item.value;
    }
    if (content.kind === "unbounded" && Number.isInteger(Number(name))) {
      return content.element;
    }
    return null;
  }

  private fieldOf(
    content: Extract<Value, { kind: "record" }>,
    name: string,
    node: N,
  ): Value {
    const item = content.fields.get(name);
    if (item !== undefined) {
      return item.value;
    }
    return content.open ? this.unwritten(node) : constant(undefined);
  }

  /**
   * A name not bound in this function, read where the function is
   * written. An unfilled parameter skips the enclosing scopes, since
   * only a call site can supply its value.
   */
  private outer(node: N, name: string, throughScopes: boolean): Value {
    const id = this.idOf(node);
    const cached = this.remembers() ? this.outerByNode.get(id) : undefined;
    if (cached !== undefined) {
      return cached;
    }
    const value = deferred(
      () =>
        throughScopes
          ? this.outerName(node, name)
          : this.outerValue(node, CONTEXT_FREE),
      name,
    );
    if (this.remembers()) {
      this.outerByNode.set(id, value);
    }
    return value;
  }

  private outerName(node: N, name: string): Value {
    const site = this.lowering.siteOf(node);
    let root = site?.root ?? null;
    while (root !== null) {
      const parent = this.lowering.siteOf(root);
      if (parent === null) {
        break;
      }
      const state = this.stateAt(parent, null, 0);
      if (state.parameters.has(name)) {
        break;
      }
      const bound = state.bindings.get(name);
      if (bound !== undefined) {
        const value = this.materialize(bound, state);
        return this.lowering.mutatedInNestedFunction(parent.root, name)
          ? widenAway(force(value))
          : value;
      }
      root = parent.root;
    }
    return this.outerValue(node);
  }

  /** The value of the expression a name, a member or a call was written as. */
  private outerValue(
    node: N,
    ask: OuterAsk = UNDER_SITE,
    shape: OuterShape = A_READ,
  ): Value {
    const id = this.idOf(node);
    if (this.computing.has(id)) {
      return this.unwritten(node);
    }
    const cached = this.remembers() ? this.writtenByNode.get(id) : undefined;
    if (cached !== undefined) {
      return cached;
    }
    const value = this.writtenValue(node, id, ask, shape);
    if (this.remembers()) {
      this.writtenByNode.set(id, value);
    }
    return value;
  }

  private writtenValue(
    node: N,
    id: unknown,
    ask: OuterAsk,
    shape: OuterShape,
  ): Value {
    const written = this.lowering.writtenTo(
      node,
      ask === UNDER_SITE ? this.underSite : undefined,
    );
    if (written === null || this.same(written, node)) {
      return shape === A_READ ? this.declaredValue(node) : this.unwritten(node);
    }
    this.computing.add(id);
    try {
      // Forced here so a chain of writes that comes back to this node
      // meets the guard while it is still set.
      return named(
        force(this.valueAt(written)),
        this.lowering.holeNameOf(node),
      );
    } finally {
      this.computing.delete(id);
    }
  }

  /** The value a declared type allows, for a name or member read that nothing wrote. */
  private declaredValue(node: N): Value {
    return this.lowering.declaredValueOf?.(node) ?? this.unwritten(node);
  }

  /** A hole in place of an expression, with the name the lowering gives it. */
  private unwritten(node: N): Value {
    return hole(this.lowering.holeNameOf(node));
  }

  private call(
    node: N,
    callee: Callee<N>,
    args: readonly Element<N>[],
    constructs: boolean,
    state: State,
    depth: number,
  ): Value {
    const argValues = this.argumentsOf(args, state, depth);
    const receiver =
      callee.receiver === null
        ? null
        : this.expression(callee.receiver, state, depth);
    const fromRow = this.applyRow(
      callee,
      constructs,
      receiver,
      argValues.positional,
      state,
    );
    if (fromRow !== null) {
      return fromRow;
    }
    if (this.sound) {
      // A deferred call that nobody forces never widens what it was
      // given, so a sound run makes every call when it reaches it.
      return this.inlineOrEscape(node, argValues, state, depth, receiver);
    }
    const touchesHeap =
      allArguments(argValues).some((value) => value.kind === "ref") ||
      args.some(
        (arg) => this.lowering.expression(arg.node).kind === "function",
      );
    if (touchesHeap) {
      this.escapeCallbacks(args, state);
      return this.inlineOrEscape(node, argValues, state, depth);
    }
    const madeBy = this.deferredCalls++;
    return deferred(() =>
      this.keepingAllocations(madeBy, state, () =>
        this.inlineOrEscape(node, argValues, state, depth),
      ),
    );
  }

  /**
   * Runs a deferred call and records what each allocation made while it
   * ran contains once it returns. A deferred call it ran may have
   * recorded one of them already. When that call was made while this one
   * ran, only this call's result reaches the allocation, and this call's
   * statements came after, so its content replaces the earlier entry.
   * When that call was made before, a read through it may come before
   * this call, so the two contents are joined.
   */
  private keepingAllocations(
    madeBy: number,
    state: State,
    run: () => Value,
  ): Value {
    const allocatedFrom = this.nextAllocation;
    const madeWhileRunning = this.deferredCalls;
    const value = run();
    for (let id = allocatedFrom; id < this.nextAllocation; id++) {
      const content = state.heap.get(id);
      if (content === undefined) {
        continue;
      }
      const earlier = this.allocatedByDeferredCalls.get(id);
      if (earlier === undefined || earlier.madeBy >= madeWhileRunning) {
        this.allocatedByDeferredCalls.set(id, { content, madeBy });
        continue;
      }
      if (earlier.content !== content) {
        this.allocatedByDeferredCalls.set(id, {
          content: join(earlier.content, content),
          madeBy: earlier.madeBy,
        });
      }
    }
    return value;
  }

  private inlineOrEscape(
    node: N,
    argValues: Arguments,
    state: State,
    depth: number,
    receiver: Value | null = null,
  ): Value {
    const inlined = this.inline(node, argValues, state, depth);
    if (inlined !== null) {
      return inlined;
    }
    if (this.sound) {
      const given = receiver === null ? [] : [receiver];
      for (const value of [...allArguments(argValues), ...given]) {
        this.escape(value, state);
      }
      return this.unwritten(node);
    }
    // The lowering may still resolve the call to a value, as it does for
    // a declared wrapper that passes one argument through.
    const written = this.outerValue(node, UNDER_SITE, A_CALL);
    if (written.kind !== "hole") {
      return written;
    }
    for (const value of allArguments(argValues)) {
      this.escape(value, state);
    }
    return written;
  }

  private argumentsOf(
    args: readonly Element<N>[],
    state: State,
    depth: number,
  ): Arguments {
    const positional: Value[] = [];
    const named = new Map<string, Value>();
    let placed = true;
    for (const arg of args) {
      const value = this.expression(arg.node, state, depth);
      if (arg.kind === "named") {
        named.set(arg.name, value);
        continue;
      }
      if (arg.kind === "value") {
        positional.push(value);
        continue;
      }
      const spread = this.contentOf(value, state);
      if (spread.kind === "sequence") {
        positional.push(...spread.items.map((item) => item.value));
        placed =
          placed && spread.items.every((item) => item.presence === "one");
        continue;
      }
      positional.push(hole("value"));
      placed = false;
    }
    return { positional, named, placed };
  }

  private applyRow(
    callee: Callee<N>,
    constructs: boolean,
    receiver: Value | null,
    args: readonly Value[],
    state: State,
  ): Value | null {
    if (callee.name === null) {
      return null;
    }
    const methodRows = this.methodRows.get(callee.name) ?? [];
    if (receiver !== null && methodRows.length > 0) {
      const content = this.contentOf(receiver, state);
      const row = methodRows.find(
        (candidate) => candidate.on === content.kind || candidate.on === "any",
      );
      if (row !== undefined) {
        const output = row.apply({
          receiver: content,
          args,
          contentOf: (value) => this.contentOf(value, state),
        });
        const forced = force(receiver);
        if (output.receiver !== undefined && forced.kind === "ref") {
          state.heap.set(forced.id, output.receiver);
        }
        return output.result === "receiver" ? receiver : output.result;
      }
    }
    const candidates = (this.calleeRows.get(callee.name) ?? []).filter(
      (row) => Boolean(row.constructs) === constructs,
    );
    if (candidates.length === 0) {
      return null;
    }
    const origin = callee.origin();
    const row = candidates.find(
      (candidate) =>
        origin !== null && candidate.origin.module === origin.module,
    );
    if (row === undefined) {
      return null;
    }
    const output = row.apply({
      receiver: receiver === null ? null : this.contentOf(receiver, state),
      args,
      contentOf: (value) => this.contentOf(value, state),
    });
    return output.result === "receiver"
      ? (receiver ?? hole("value"))
      : output.result;
  }

  private inline(
    node: N,
    args: Arguments,
    state: State,
    depth: number,
  ): Value | null {
    if (depth >= INLINE_DEPTH_CAP) {
      return null;
    }
    if (this.sound && !args.placed) {
      return null;
    }
    const fn = this.lowering.callable(node);
    const shape = fn === null ? null : this.lowering.functionOf(fn);
    if (fn === null || shape === null || this.containsLoop(shape.body)) {
      return null;
    }
    const inner: State = {
      bindings: new Map(),
      heap: state.heap,
      parameters: new Set(),
      madeFrom: this.nextAllocation,
      picks: null,
    };
    this.bindParameters(shape, args, inner, depth);
    if (this.sound) {
      for (const { name } of shape.parameters) {
        inner.bindings.set(
          name,
          this.unlessNestedWrite(
            fn,
            name,
            inner.bindings.get(name) ?? hole(name),
            inner,
          ),
        );
      }
    }
    const returned = expressionBodyOf(shape.body);
    if (returned !== null) {
      return this.expression(returned, inner, depth + 1);
    }
    const outcome = this.run(statementsOf(shape.body), inner, fn, depth + 1);
    if (outcome.completes) {
      outcome.returns.push(constant(undefined));
    }
    const [first, ...rest] = outcome.returns;
    if (first === undefined) {
      return hole("value");
    }
    return rest.reduce<Value>(
      (joined, value) => this.joinedValues(joined, value, inner, false),
      first,
    );
  }

  /** Bound in order, so a default can read a parameter before it. */
  private bindParameters(
    shape: FunctionShape<N>,
    args: Arguments,
    inner: State,
    depth: number,
  ): void {
    for (const parameter of shape.parameters) {
      const passed = this.argumentFor(parameter, args, inner, depth);
      const bound =
        passed ??
        (parameter.default === null
          ? constant(undefined)
          : this.expression(parameter.default, inner, depth + 1));
      inner.bindings.set(parameter.name, bound);
    }
  }

  /** The argument a call passes for a parameter, or undefined when the call leaves it out. */
  private argumentFor(
    parameter: Parameter<N>,
    args: Arguments,
    state: State,
    depth: number,
  ): Value | undefined {
    const argument = args.positional[parameter.position];
    if (parameter.path === undefined) {
      return args.named.get(parameter.name) ?? argument;
    }
    const whole =
      argument ??
      (parameter.patternDefault === undefined
        ? undefined
        : this.expression(parameter.patternDefault, state, depth + 1));
    return whole === undefined
      ? undefined
      : this.propertyAt(whole, parameter.path, parameter.name, state);
  }

  /**
   * The value at `path` inside an argument. Undefined when the argument
   * is an object without that property, so the default applies the way
   * it does for an argument nobody passed; a hole when the argument does
   * not fold to an object at all.
   */
  private propertyAt(
    argument: Value,
    path: readonly string[],
    name: string,
    state: State,
  ): Value | undefined {
    let current = argument;
    for (const key of path) {
      const content = this.contentOf(current, state);
      if (content.kind !== "record") {
        return hole(name);
      }
      const field = content.fields.get(key);
      if (field === undefined) {
        return content.open ? hole(name) : undefined;
      }
      current = field.value;
    }
    return current;
  }

  private containsLoop(body: FunctionBody<N>): boolean {
    return statementsOf(body).some((stmt) => {
      const shape = this.lowering.statement(stmt);
      if (shape.kind === "loop") {
        return true;
      }
      if (shape.kind === "branch") {
        return shape.arms.some((arm) => this.containsLoop(arm));
      }
      return shape.kind === "block" && this.containsLoop(shape.body);
    });
  }

  private operator(
    operator: string,
    operands: readonly Value[],
    state: State,
  ): Value {
    const row = this.operatorRows.get(`${operator}/${operands.length}`);
    if (row === undefined) {
      return hole("value");
    }
    return row.apply(operands, (value) => this.contentOf(value, state));
  }

  /** A callback passed to an unknown call may run at any time, so every allocation it can reach escapes. */
  private escapeCallbacks(args: readonly Element<N>[], state: State): void {
    for (const arg of args) {
      if (this.lowering.expression(arg.node).kind === "function") {
        this.escapeFreeNames(arg.node, state);
      }
    }
  }

  private escapeFreeNames(fn: N, state: State): void {
    for (const name of this.lowering.freeNamesOf(fn)) {
      const bound = state.bindings.get(name);
      if (bound !== undefined) {
        this.escape(bound, state);
      }
    }
  }

  /**
   * Widens an allocation that code the engine cannot see now has a
   * reference to. A sound run widens every allocation reachable from it
   * too, since that code can follow the references.
   */
  private escape(value: Value, state: State, seen = new Set<number>()): void {
    const forced = force(value);
    if (forced.kind !== "ref" && this.sound) {
      for (const inner of valuesInside(forced)) {
        this.escape(inner, state, seen);
      }
      return;
    }
    if (forced.kind !== "ref" || seen.has(forced.id)) {
      return;
    }
    seen.add(forced.id);
    const content = this.allocationIn(state, forced.id);
    if (content === undefined) {
      return;
    }
    state.heap.set(forced.id, widenAway(content));
    if (!this.sound) {
      return;
    }
    for (const inner of valuesInside(content)) {
      this.escape(inner, state, seen);
    }
  }

  /** The value with every `ref` replaced by what the heap has for it. */
  private materialize(
    value: Value,
    state: State,
    seen = new Set<number>(),
  ): Value {
    if (value.kind === "deferred") {
      return deferred(() => this.materialize(force(value), state, seen));
    }
    if (value.kind === "ref") {
      if (seen.has(value.id)) {
        return hole("value");
      }
      const content = this.allocationIn(state, value.id);
      return content === undefined
        ? hole("value")
        : this.materialize(content, state, new Set([...seen, value.id]));
    }
    if (value.kind === "sequence") {
      return {
        kind: "sequence",
        items: value.items.map((item) => ({
          value: this.materialize(item.value, state, seen),
          presence: item.presence,
        })),
      };
    }
    if (value.kind === "unbounded") {
      return unbounded(this.materialize(value.element, state, seen));
    }
    if (value.kind === "record") {
      const fields = new Map<string, Item>();
      for (const [name, item] of value.fields) {
        fields.set(name, {
          value: this.materialize(item.value, state, seen),
          presence: item.presence,
        });
      }
      return { kind: "record", fields, open: value.open };
    }
    return value;
  }
}

/** An allocation's value once code the engine cannot see may have changed it. */
function widenAway(content: Value): Value {
  if (content.kind === "sequence" || content.kind === "unbounded") {
    return unbounded(hole("value"));
  }
  if (content.kind === "record") {
    const fields = new Map<string, Item>();
    for (const name of content.fields.keys()) {
      fields.set(name, { value: hole(name), presence: "optional" });
    }
    return { kind: "record", fields, open: true };
  }
  if (content.kind === "string" || content.kind === "constant") {
    return hole("value");
  }
  return content;
}

/** The values a record or a list keeps, one level down. */
function valuesInside(content: Value): Value[] {
  if (content.kind === "record") {
    return [...content.fields.values()].map((item) => item.value);
  }
  if (content.kind === "sequence") {
    return content.items.map((item) => item.value);
  }
  return content.kind === "unbounded" ? [content.element] : [];
}

/** The value with every deferral inside it computed, however deep. */
function forcedThrough(value: Value): Value {
  const forced = force(value);
  if (forced.kind === "record") {
    const fields = new Map<string, Item>();
    for (const [name, item] of forced.fields) {
      fields.set(name, {
        value: forcedThrough(item.value),
        presence: item.presence,
      });
    }
    return { kind: "record", fields, open: forced.open };
  }
  if (forced.kind === "sequence") {
    return {
      kind: "sequence",
      items: forced.items.map((item) => ({
        value: forcedThrough(item.value),
        presence: item.presence,
      })),
    };
  }
  if (forced.kind === "unbounded") {
    return unbounded(forcedThrough(forced.element));
  }
  return forced;
}

function literalValue(value: Literal): Value {
  return typeof value === "string" ? text(value) : constant(value);
}

/** A hole bound to a name takes that name, since a reader finds that name in the source. */
function named(value: Value, name: string): Value {
  if (value.kind === "hole") {
    return hole(name);
  }
  if (value.kind === "deferred") {
    return deferred(() => named(force(value), name), name);
  }
  return value;
}

function literalOfValue(value: Value): string | null {
  const forced = force(value);
  if (forced.kind === "constant" && forced.options.length === 1) {
    return String(forced.options[0]);
  }
  if (forced.kind !== "string") {
    return null;
  }
  const only = forced.pieces[0];
  if (forced.pieces.length === 0) {
    return "";
  }
  return forced.pieces.length === 1 &&
    only?.kind === "text" &&
    only.options.length === 1
    ? (only.options[0] ?? null)
    : null;
}

function emptyState(): State {
  return {
    bindings: new Map(),
    heap: new Map(),
    parameters: new Set(),
    madeFrom: 0,
    picks: null,
  };
}

function allArguments(args: Arguments): Value[] {
  return [...args.positional, ...args.named.values()];
}

function cloneState(state: State): State {
  return {
    bindings: new Map(state.bindings),
    heap: new Map(state.heap),
    parameters: state.parameters,
    madeFrom: state.madeFrom,
    picks: state.picks === null ? null : copyPicks(state.picks),
  };
}

/** The state an arm of a fork the run left open starts from. */
function openArm(state: State): State {
  const armState = cloneState(state);
  if (armState.picks !== null) {
    armState.picks.inOpen = true;
  }
  return armState;
}

/**
 * The state a loop body runs once in, to see what it changes. Its forks
 * are joined, since another time round could take another arm.
 */
function loopPass(state: State): State {
  const pass = cloneState(state);
  pass.picks = null;
  return pass;
}

/**
 * The target takes the source's bindings, heap and decided keys. Where
 * the run is, open or under a taken fork, stays the target's, in the
 * same object, which a run that took an arm puts back when it leaves it.
 */
function replaceState(target: State, source: State): void {
  target.bindings.clear();
  for (const [name, value] of source.bindings) {
    target.bindings.set(name, value);
  }
  target.heap.clear();
  for (const [id, value] of source.heap) {
    target.heap.set(id, value);
  }
  const picks = target.picks;
  if (picks === null || source.picks === null || picks === source.picks) {
    return;
  }
  const { decided, reads } = source.picks;
  picks.decided.clear();
  for (const [key, arm] of decided) {
    picks.decided.set(key, arm);
  }
  picks.reads.clear();
  for (const name of reads) {
    picks.reads.add(name);
  }
}

/** Whether two arms left every binding and every allocation as the same value, compared without forcing anything. */
function sameState(a: State, b: State): boolean {
  return sameEntries(a.bindings, b.bindings) && sameEntries(a.heap, b.heap);
}

function sameEntries<K>(
  a: ReadonlyMap<K, Value>,
  b: ReadonlyMap<K, Value>,
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false;
    }
  }
  return true;
}

function emptyPicks(): Picks {
  return { decided: new Map(), reads: new Set(), inOpen: false, under: null };
}

function copyPicks(picks: Picks): Picks {
  return {
    decided: new Map(picks.decided),
    reads: new Set(picks.reads),
    inOpen: picks.inOpen,
    under: picks.under,
  };
}

/**
 * What two arms both decided. A key one arm fixed and the other did not
 * is open again after the branch, since the run may have come either way.
 */
function meetPicks(a: Picks | null, b: Picks | null): Picks | null {
  if (a === null || b === null) {
    return a === null ? null : copyPicks(a);
  }
  const decided = new Map(
    [...a.decided].filter(([key, arm]) => b.decided.get(key) === arm),
  );
  const reads = new Set([...a.reads].filter((name) => b.reads.has(name)));
  return { decided, reads, inOpen: a.inOpen, under: a.under };
}

function newForkRun<N>(arms: ReadonlyMap<string, number>): ForkRun<N> {
  return { arms, met: new Map(), reached: true };
}

/** This fork's arm for an arm of its key, the two swapped for a negated condition. */
function ownArm(test: ForkTest, keyArm: number, count: number): number {
  return test.negated && count === 2 ? 1 - keyArm : keyArm;
}

type DeferredAllocations = ReadonlyMap<number, AllocatedByDeferredCall>;

function joinStates(
  a: State,
  b: State,
  allocatedByDeferredCalls: DeferredAllocations,
): State {
  return combineStates(a, b, join, allocatedByDeferredCalls);
}

function widenState(
  before: State,
  after: State,
  allocatedByDeferredCalls: DeferredAllocations,
): State {
  return combineStates(before, after, widen, allocatedByDeferredCalls);
}

/**
 * A state with no heap entry for an allocation a deferred call made
 * still reaches it, with the content the call left, so the join takes
 * that content for its side.
 */
function combineStates(
  a: State,
  b: State,
  combine: (left: Value, right: Value) => Value,
  allocatedByDeferredCalls: DeferredAllocations,
  combineContent: (left: Value, right: Value) => Value = combine,
): State {
  const bindings = new Map<string, Value>();
  for (const name of new Set([...a.bindings.keys(), ...b.bindings.keys()])) {
    const left = a.bindings.get(name);
    const right = b.bindings.get(name);
    bindings.set(
      name,
      left === undefined || right === undefined
        ? hole(name)
        : combine(left, right),
    );
  }
  const heap = new Map<number, Value>();
  for (const id of new Set([...a.heap.keys(), ...b.heap.keys()])) {
    const left = a.heap.get(id) ?? allocatedByDeferredCalls.get(id)?.content;
    const right = b.heap.get(id) ?? allocatedByDeferredCalls.get(id)?.content;
    const only = left ?? right;
    if (left === undefined || right === undefined) {
      if (only !== undefined) {
        heap.set(id, only);
      }
      continue;
    }
    heap.set(id, combineContent(left, right));
  }
  return {
    bindings,
    heap,
    parameters: a.parameters,
    madeFrom: a.madeFrom,
    picks: meetPicks(a.picks, b.picks),
  };
}

function groupBy<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [row]);
    } else {
      group.push(row);
    }
  }
  return groups;
}
