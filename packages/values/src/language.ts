/**
 * What an adapter supplies to run the evaluator over its language.
 *
 * The adapter lowers each expression and statement into one of a dozen
 * kinds on demand, so the engine never sees a syntax tree. The adapter
 * also resolves the two things that need lookups across files: which
 * expression a name was written as, and which function a callee is.
 * Last, it supplies a table of rows, one for each operator and library
 * method, saying what that operation does to abstract values. Every
 * language shares the engine. Only the lowering and the table change.
 */

import type { Truthiness } from "./truthiness.js";
import type { Value } from "./value.js";

export type Literal = string | number | boolean | null | undefined;

/** An element of an array literal or an argument list; a named one is a keyword argument. */
export type Element<N> =
  | { readonly kind: "value"; readonly node: N }
  | { readonly kind: "spread"; readonly node: N }
  | { readonly kind: "named"; readonly name: string; readonly node: N };

export type Field<N> =
  | { readonly kind: "field"; readonly name: string; readonly value: N }
  | { readonly kind: "computed"; readonly name: N; readonly value: N }
  | { readonly kind: "spread"; readonly node: N };

export interface Origin {
  readonly module: string;
  readonly name: string;
}

/**
 * The receiver and name of a call. The engine calls `origin` only when a
 * row matches on it, because finding an import's source costs a
 * resolution lookup.
 */
export interface Callee<N> {
  readonly receiver: N | null;
  readonly name: string | null;
  readonly origin: () => Origin | null;
}

export type Expression<N> =
  | { readonly kind: "literal"; readonly value: Literal }
  | {
      readonly kind: "template";
      readonly parts: readonly (
        | { readonly text: string }
        | { readonly expression: N }
      )[];
    }
  | { readonly kind: "name"; readonly text: string }
  | { readonly kind: "member"; readonly object: N; readonly name: string }
  | { readonly kind: "element"; readonly object: N; readonly index: N }
  | { readonly kind: "array"; readonly items: readonly Element<N>[] }
  | { readonly kind: "record"; readonly fields: readonly Field<N>[] }
  | {
      readonly kind: "call";
      readonly callee: Callee<N>;
      readonly args: readonly Element<N>[];
      readonly constructs: boolean;
    }
  | {
      readonly kind: "operator";
      readonly operator: string;
      readonly operands: readonly N[];
    }
  | {
      readonly kind: "conditional";
      readonly condition: N;
      readonly whenTrue: N;
      readonly whenFalse: N;
    }
  | { readonly kind: "function"; readonly node: N }
  | { readonly kind: "opaque" };

export interface Declaration<N> {
  readonly name: string;
  readonly value: N | null;
}

export type Statement<N> =
  | { readonly kind: "declare"; readonly bindings: readonly Declaration<N>[] }
  | {
      readonly kind: "assign";
      readonly target: N;
      /** The binary operator of a compound assignment (`+` for `+=`), or null. */
      readonly operator: string | null;
      readonly value: N;
    }
  | { readonly kind: "expression"; readonly value: N }
  | {
      readonly kind: "branch";
      readonly condition: N | null;
      readonly arms: readonly (readonly N[])[];
    }
  | { readonly kind: "loop"; readonly body: readonly N[] }
  | { readonly kind: "return"; readonly value: N | null }
  /**
   * A throw that nothing in the same function catches. It ends the
   * statement list it is in and gives the function no value.
   */
  | { readonly kind: "throw" }
  | { readonly kind: "block"; readonly body: readonly N[] }
  | { readonly kind: "opaque" };

/** A function's parameters and body, ready to inline or to walk. */
export interface FunctionShape<N> {
  readonly parameters: readonly Parameter<N>[];
  readonly body: FunctionBody<N>;
}

/** A parameter and the expression it takes when a call leaves it out, if any. */
export interface Parameter<N> {
  readonly name: string;
  readonly default: N | null;
  /**
   * The position of the argument that fills the name. Counting list
   * entries gives the wrong position for two reasons: every name a
   * destructured parameter binds shares one argument, and a parameter
   * the lowering dropped for lack of a path still uses up a position.
   */
  readonly position: number;
  /**
   * The properties to read off that argument, outermost first, for a
   * name a destructured parameter binds. A plain name takes the
   * argument itself.
   */
  readonly path?: readonly string[];
  /**
   * The default the whole pattern takes, as in `{ a, b } = {}`. A call
   * that leaves the argument out has `path` read off this instead.
   */
  readonly patternDefault?: N;
}

export function parameter<N>(
  name: string,
  fallback: N | null = null,
  position = 0,
): Parameter<N> {
  return { name, default: fallback, position };
}

export type FunctionBody<N> = readonly N[] | { readonly expression: N };

/** The expression an arrow function returns directly, or null for a block body. */
export function expressionBodyOf<N>(body: FunctionBody<N>): N | null {
  return "expression" in body ? body.expression : null;
}

/** The statements of a block body; an expression body has none. */
export function statementsOf<N>(body: FunctionBody<N>): readonly N[] {
  return "expression" in body ? [] : body;
}

/**
 * Where a node is in its enclosing function or module: the root, and
 * the statements from the root's body down to the one containing it.
 */
export interface Site<N> {
  readonly root: N;
  readonly path: readonly N[];
}

export interface Lowering<N> {
  expression(node: N): Expression<N>;
  statement(node: N): Statement<N>;
  /** Null for a node that is not inside any function or module body. */
  siteOf(node: N): Site<N> | null;
  /** The body of a function node, or of a module. */
  functionOf(node: N): FunctionShape<N> | null;
  /**
   * The expression a name resolves to, through imports and re-exports.
   * Given a site, it returns the expression only when the receiver
   * behind the name was created at that site.
   */
  writtenTo(node: N, site?: string): N | null;
  /** The function a callee resolves to, through wrappers and barrels. */
  callable(node: N): N | null;
  /** Whether a function nested in `root` writes to, or calls a method on, `name`. */
  mutatedInNestedFunction(root: N, name: string): boolean;
  /**
   * Whether every write to `name` in `root` is one the engine follows:
   * `root` binds it exactly once, as one of its own parameters or with
   * a declaration or assignment the lowering expresses, and nothing else
   * in `root` or in a function nested in it writes it. A sound evaluator
   * reads any other name as a hole, and reads every name as one when the
   * lowering leaves this out.
   */
  writtenOnce?(root: N, name: string): boolean;
  /** The names a function reads from its enclosing scopes. */
  freeNamesOf(fn: N): readonly string[];
  /** The name to give a hole that replaces this expression. */
  holeNameOf(node: N): string;
  /**
   * What the declared type of a name or member read limits it to, for
   * one nothing in the source writes a value for, such as a parameter
   * typed as a string literal union. Null when the type does not narrow
   * the value to a few literals. A language with no declared types
   * leaves it out.
   */
  declaredValueOf?(node: N): Value | null;
  /**
   * One key per node, for a parser that returns a fresh object on
   * every read of the same node. The engine compares and memoizes nodes
   * by this key. Left out, the node itself is the key.
   */
  idOf?(node: N): unknown;
  /**
   * The language's rule for which values count as true in a condition.
   * The engine settles a branch or a `?:` with it, so each language
   * states its own and the engine never decides.
   */
  readonly truthiness: Truthiness;
  readonly rows: readonly Row[];
  /**
   * What a branch statement or a `?:` in `root` tests, for a run that
   * takes one of its arms. Null leaves the fork joined, as for a `switch`
   * whose clauses fall into each other, whose arms the lowering does not
   * write apart. A language that leaves this out never has a fork taken.
   */
  forkTest?(fork: N, root: N): ForkTest | null;
}

/** What a fork tests, as `Lowering.forkTest` says it. */
export interface ForkTest {
  /**
   * The same for two forks that test the same thing: the condition's
   * source text, with one leading negation taken off. A fork with more
   * than two arms has a key of its own, and so does a condition with a
   * call in it or one that reads a name `root` writes more than once,
   * since two forks with that text may test different values.
   */
  readonly key: string;
  /** Whether the condition was negated, so the key's first arm is this fork's second. */
  readonly negated: boolean;
  /** The names the condition reads. */
  readonly reads: readonly string[];
}

export interface CallInput {
  /** The receiver's content, with a `ref` already followed into the heap. */
  readonly receiver: Value | null;
  /** Arguments as written; an array or record argument is a `ref`. */
  readonly args: readonly Value[];
  /** The content behind a `ref`, for a row that copies rather than aliases. */
  contentOf(value: Value): Value;
}

export interface CallOutput {
  /** `"receiver"` hands back the receiver itself, so a chain keeps its identity. */
  readonly result: Value | "receiver";
  /** The receiver's new content, when the call changed it in place. */
  readonly receiver?: Value;
}

export type Row =
  | {
      readonly kind: "operator";
      readonly operator: string;
      readonly arity: number;
      /** Operands as written; an array or record operand is a `ref`, read through `contentOf`. */
      readonly apply: (
        operands: readonly Value[],
        contentOf: (value: Value) => Value,
      ) => Value;
    }
  | {
      readonly kind: "method";
      readonly method: string;
      readonly on: Value["kind"] | "any";
      readonly apply: (input: CallInput) => CallOutput;
    }
  | {
      readonly kind: "callee";
      readonly origin: Origin;
      readonly constructs?: boolean;
      readonly apply: (input: CallInput) => CallOutput;
    };
