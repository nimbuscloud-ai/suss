/**
 * The evaluator: the abstract value of one expression at the place it
 * is written.
 *
 * Asked about an expression, the engine runs the statements of the
 * enclosing function or module up to that expression, keeping a local
 * heap so that a push through an alias is seen by every name bound to
 * the same array, then evaluates the expression against that state. A
 * name declared outside the function is read at the point the function
 * is written, and a name declared in another file is read through the
 * lowering's resolution. A call is inlined when its callee is a project
 * function whose body has no loop, under a depth cap; a library call is
 * looked up in the lowering's rows; any other call is a hole.
 */

import {
  type Callee,
  type Element,
  expressionBodyOf,
  type Field,
  type FunctionBody,
  type Lowering,
  type Row,
  type Site,
  statementsOf,
} from "./language.js";
import { join, joinAll, widen } from "./lattice.js";
import {
  concat,
  constant,
  deferred,
  force,
  hole,
  type Item,
  text,
  truthOf,
  unbounded,
  type Value,
} from "./value.js";

const INLINE_DEPTH_CAP = 3;
const STATEMENT_BUDGET = 20_000;

interface State {
  readonly bindings: Map<string, Value>;
  readonly heap: Map<number, Value>;
  /** Parameters no call site filled; a read of one goes to the lowering. */
  readonly parameters: Set<string>;
}

interface Outcome {
  readonly returns: Value[];
  readonly completes: boolean;
}

export interface EvaluateOptions {
  /** Values for parameters of the enclosing function, from a call site. */
  readonly bindings?: ReadonlyMap<string, Value>;
}

export interface EvaluatorOptions {
  /** How many statements one `evaluate` call may run before it stops. */
  readonly statementBudget?: number;
}

export class Evaluator<N extends object> {
  private nextAllocation = 0;
  private statements = 0;
  private readonly statementBudget: number;
  private readonly stateAfterStatement = new Map<N, State>();
  private readonly outerByNode = new Map<N, Value>();
  private readonly computing = new Set<N>();
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

  /** The value of an expression where it is written. */
  evaluate(node: N, options: EvaluateOptions = {}): Value {
    this.statements = 0;
    return this.valueAt(node, options);
  }

  private valueAt(node: N, options: EvaluateOptions = {}): Value {
    const site = this.lowering.siteOf(node);
    const state =
      site === null
        ? emptyState()
        : this.stateAt(site, options.bindings ?? null, 0);
    return this.materialize(this.expression(node, state, 0), state);
  }

  private stateAt(
    site: Site<N>,
    bindings: ReadonlyMap<string, Value> | null,
    depth: number,
  ): State {
    const shape = this.lowering.functionOf(site.root);
    const state = emptyState();
    for (const parameter of shape?.parameters ?? []) {
      const supplied = bindings?.get(parameter);
      if (supplied === undefined) {
        state.parameters.add(parameter);
      } else {
        state.bindings.set(parameter, supplied);
      }
    }
    const body = shape === null ? [] : statementsOf(shape.body);
    const memo = bindings === null ? this.stateAfterStatement : null;
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
    memo: Map<N, State> | null,
  ): State {
    const [target, ...rest] = path;
    if (target === undefined) {
      return state;
    }
    const at = body.indexOf(target);
    if (at === -1) {
      return state;
    }
    let current = state;
    let from = 0;
    if (memo !== null) {
      for (let i = at - 1; i >= 0; i--) {
        const stmt = body[i];
        const remembered = stmt === undefined ? undefined : memo.get(stmt);
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
      memo?.set(stmt, cloneState(current));
      if (!outcome.completes) {
        break;
      }
    }
    if (rest.length === 0) {
      return current;
    }
    return this.descend(target, rest, current, root, depth);
  }

  /** Into the arm, loop body or block of `stmt` that contains the rest of the path. */
  private descend(
    stmt: N,
    rest: readonly N[],
    state: State,
    root: N,
    depth: number,
  ): State {
    const shape = this.lowering.statement(stmt);
    const next = rest[0];
    if (next === undefined) {
      return state;
    }
    if (shape.kind === "branch") {
      const arm = shape.arms.find((candidate) => candidate.includes(next));
      return arm === undefined
        ? state
        : this.runPath(arm, rest, state, root, depth, null);
    }
    if (shape.kind === "loop") {
      const after = cloneState(state);
      this.run(shape.body, after, root, depth);
      const entry = widenState(state, after);
      return this.runPath(shape.body, rest, entry, root, depth, null);
    }
    if (shape.kind === "block") {
      return this.runPath(shape.body, rest, state, root, depth, null);
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
      return this.branch(shape.condition, shape.arms, state, root, depth);
    }
    if (shape.kind === "loop") {
      const after = cloneState(state);
      const outcome = this.run(shape.body, after, root, depth);
      replaceState(state, widenState(state, after));
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
    if (shape.kind === "block") {
      return this.run(shape.body, state, root, depth);
    }
    return completes;
  }

  /**
   * A name some nested function writes to is unknown from its
   * declaration on, since that function can run at any point after.
   */
  private unlessNestedWrite(
    root: N,
    name: string,
    value: Value,
    state: State,
  ): Value {
    if (!this.lowering.mutatedInNestedFunction(root, name)) {
      return value;
    }
    return named(widenAway(force(this.materialize(value, state))), name);
  }

  private branch(
    condition: N | null,
    arms: readonly (readonly N[])[],
    state: State,
    root: N,
    depth: number,
  ): Outcome {
    const settled =
      condition === null
        ? null
        : truthOf(this.expression(condition, state, depth));
    if (settled !== null && arms.length === 2) {
      const arm = arms[settled ? 0 : 1] ?? [];
      return this.run(arm, state, root, depth);
    }
    const returns: Value[] = [];
    const completing: State[] = [];
    for (const arm of arms) {
      const armState = cloneState(state);
      const outcome = this.run(arm, armState, root, depth);
      returns.push(...outcome.returns);
      if (outcome.completes) {
        completing.push(armState);
      }
    }
    const [first, ...rest] = completing;
    if (first === undefined) {
      return { returns, completes: false };
    }
    replaceState(
      state,
      rest.reduce((acc, other) => joinStates(acc, other), first),
    );
    return { returns, completes: true };
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
      const previous = this.expression(target, state, depth);
      const value =
        operator === null
          ? named(written, shape.text)
          : this.operator(operator, [previous, written]);
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
  }

  /** A write to `object.name`; a null name is an index nothing settled. */
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
      return;
    }
    const content = state.heap.get(target.id) ?? hole("value");
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
    const shape = this.lowering.expression(node);
    if (shape.kind === "literal") {
      return typeof shape.value === "string"
        ? text(shape.value)
        : constant(shape.value);
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
      return this.outer(node, shape.text, !state.parameters.has(shape.text));
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
        ? hole(this.lowering.holeNameOf(node))
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
      );
    }
    if (shape.kind === "conditional") {
      const settled = truthOf(this.expression(shape.condition, state, depth));
      if (settled !== null) {
        return this.expression(
          settled ? shape.whenTrue : shape.whenFalse,
          state,
          depth,
        );
      }
      return join(
        this.expression(shape.whenTrue, state, depth),
        this.expression(shape.whenFalse, state, depth),
      );
    }
    return hole(this.lowering.holeNameOf(node));
  }

  private allocate(content: Value, state: State): Value {
    const id = this.nextAllocation++;
    state.heap.set(id, content);
    return { kind: "ref", id };
  }

  /** The content behind a value, with a `ref` followed into the heap. */
  private contentOf(value: Value, state: State): Value {
    const forced = force(value);
    if (forced.kind !== "ref") {
      return forced;
    }
    return state.heap.get(forced.id) ?? hole("value");
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
      if (item.kind === "value") {
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
      return deferred(() => {
        const content = force(object);
        return content.kind === "record"
          ? this.fieldOf(content, name, node)
          : this.outerValue(node);
      });
    }
    const content = this.contentOf(object, state);
    if (content.kind === "record") {
      return this.fieldOf(content, name, node);
    }
    if (content.kind === "sequence") {
      if (name === "length") {
        return constant(content.items.length);
      }
      const item = content.items[Number(name)];
      return item === undefined
        ? hole(this.lowering.holeNameOf(node))
        : item.value;
    }
    if (content.kind === "unbounded" && Number.isInteger(Number(name))) {
      return content.element;
    }
    return hole(this.lowering.holeNameOf(node));
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
    return content.open
      ? hole(this.lowering.holeNameOf(node))
      : constant(undefined);
  }

  /**
   * A name not bound in this function, read where the function is
   * written. An unfilled parameter skips the enclosing scopes, since
   * only a call site can say what it is.
   */
  private outer(node: N, name: string, throughScopes: boolean): Value {
    const cached = this.outerByNode.get(node);
    if (cached !== undefined) {
      return cached;
    }
    const value = deferred(
      () =>
        throughScopes ? this.outerName(node, name) : this.outerValue(node),
      name,
    );
    this.outerByNode.set(node, value);
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

  /** The value of the expression a name or member was written as. */
  private outerValue(node: N): Value {
    if (this.computing.has(node)) {
      return hole(this.lowering.holeNameOf(node));
    }
    const written = this.lowering.writtenTo(node);
    if (written === null || written === node) {
      return hole(this.lowering.holeNameOf(node));
    }
    this.computing.add(node);
    try {
      // Forced here so a chain of writes that comes back to this node
      // meets the guard while it is still set.
      return named(
        force(this.valueAt(written)),
        this.lowering.holeNameOf(node),
      );
    } finally {
      this.computing.delete(node);
    }
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
      argValues,
      state,
    );
    if (fromRow !== null) {
      return fromRow;
    }
    const touchesHeap =
      argValues.some((value) => value.kind === "ref") ||
      args.some(
        (arg) => this.lowering.expression(arg.node).kind === "function",
      );
    if (touchesHeap) {
      this.escapeCallbacks(args, state);
      return this.inlineOrEscape(node, argValues, state, depth);
    }
    return deferred(() => this.inlineOrEscape(node, argValues, state, depth));
  }

  private inlineOrEscape(
    node: N,
    argValues: readonly Value[],
    state: State,
    depth: number,
  ): Value {
    const inlined = this.inline(node, argValues, state, depth);
    if (inlined !== null) {
      return inlined;
    }
    // A call the lowering can follow to what it is worth, such as a
    // declared wrapper that passes one argument through.
    const written = this.outerValue(node);
    if (written.kind !== "hole") {
      return written;
    }
    for (const value of argValues) {
      this.escape(value, state);
    }
    return written;
  }

  private argumentsOf(
    args: readonly Element<N>[],
    state: State,
    depth: number,
  ): Value[] {
    const values: Value[] = [];
    for (const arg of args) {
      const value = this.expression(arg.node, state, depth);
      if (arg.kind === "value") {
        values.push(value);
        continue;
      }
      const spread = this.contentOf(value, state);
      if (spread.kind === "sequence") {
        values.push(...spread.items.map((item) => item.value));
        continue;
      }
      values.push(hole("value"));
    }
    return values;
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
    args: readonly Value[],
    state: State,
    depth: number,
  ): Value | null {
    if (depth >= INLINE_DEPTH_CAP) {
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
    };
    shape.parameters.forEach((parameter, i) => {
      inner.bindings.set(parameter, args[i] ?? constant(undefined));
    });
    const returned = expressionBodyOf(shape.body);
    if (returned !== null) {
      return this.expression(returned, inner, depth + 1);
    }
    const outcome = this.run(statementsOf(shape.body), inner, fn, depth + 1);
    if (outcome.completes) {
      outcome.returns.push(constant(undefined));
    }
    return joinAll(outcome.returns);
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

  private operator(operator: string, operands: readonly Value[]): Value {
    const row = this.operatorRows.get(`${operator}/${operands.length}`);
    return row === undefined ? hole("value") : row.apply(operands);
  }

  /** A callback handed to an unknown call may run any time; what it reaches is gone. */
  private escapeCallbacks(args: readonly Element<N>[], state: State): void {
    for (const arg of args) {
      if (this.lowering.expression(arg.node).kind !== "function") {
        continue;
      }
      for (const name of this.lowering.freeNamesOf(arg.node)) {
        const bound = state.bindings.get(name);
        if (bound !== undefined) {
          this.escape(bound, state);
        }
      }
    }
  }

  /** An allocation something unknown now has a handle on. */
  private escape(value: Value, state: State): void {
    const forced = force(value);
    if (forced.kind !== "ref") {
      return;
    }
    const content = state.heap.get(forced.id);
    if (content === undefined) {
      return;
    }
    state.heap.set(forced.id, widenAway(content));
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
      const content = state.heap.get(value.id);
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

/** What an allocation is once something the engine cannot see may have changed it. */
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

/** A hole bound to a name takes that name, since that is what a reader sees. */
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
  return { bindings: new Map(), heap: new Map(), parameters: new Set() };
}

function cloneState(state: State): State {
  return {
    bindings: new Map(state.bindings),
    heap: new Map(state.heap),
    parameters: state.parameters,
  };
}

function replaceState(target: State, source: State): void {
  target.bindings.clear();
  for (const [name, value] of source.bindings) {
    target.bindings.set(name, value);
  }
  target.heap.clear();
  for (const [id, value] of source.heap) {
    target.heap.set(id, value);
  }
}

function joinStates(a: State, b: State): State {
  return combineStates(a, b, join);
}

function widenState(before: State, after: State): State {
  return combineStates(before, after, widen);
}

function combineStates(
  a: State,
  b: State,
  combine: (left: Value, right: Value) => Value,
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
    const left = a.heap.get(id);
    const right = b.heap.get(id);
    const only = left ?? right;
    if (left === undefined || right === undefined) {
      if (only !== undefined) {
        heap.set(id, only);
      }
      continue;
    }
    heap.set(id, combine(left, right));
  }
  return { bindings, heap, parameters: a.parameters };
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
