/**
 * The language-neutral form the path engine walks: statement kind, condition
 * handle, children, and exit kind. Each language's adapter lowers its own AST
 * into this, and the path enumeration never touches a language-specific node
 * again.
 *
 * The `Cond` type parameter is the language's own handle for a condition
 * expression (a ts-morph Expression for TypeScript, a tree-sitter node for a
 * language added later). The engine passes it through untouched for a caller
 * to parse afterwards, and never looks inside it.
 */

/** Where a condition came from, in terms of what that branch's body does. */
export type ConditionSource =
  | "explicit"
  | "earlyReturn"
  | "earlyThrow"
  | "catchBlock";

/** Whether a statement's own subtree leaves the unit by returning or throwing. A throw anywhere beats a return anywhere. Never set for break or continue. */
export type ExitKind = "return" | "throw" | null;

/**
 * A test the engine passes through without looking inside: its display text
 * plus the language's own expression handle. The handle is null for a
 * synthetic condition, such as a loop's "some iteration of" marker or a
 * switch group's disjunction text.
 */
export interface ConditionHandle<Cond> {
  readonly sourceText: string;
  readonly expression: Cond | null;
}

/** One condition attached to a caller-visible transition. */
export interface ConditionInfo<Cond> {
  readonly sourceText: string;
  readonly polarity: "positive" | "negative";
  readonly source: ConditionSource;
  readonly expression: Cond | null;
}

/** A statement list: an if arm, a loop body, a try/catch/finally block. */
export type StatementBlock<Cond> = readonly StructuredStatement<Cond>[];

/**
 * One switch or match case group, already merged out of the language's own
 * grammar (TypeScript stacks several empty-bodied labels on top of the
 * clause that finally has a body, and the lowering step folds that
 * into one group with a joined condition). `condition` is null for the
 * default or wildcard group. `body` has any language-specific
 * statement that ends a fallthrough (a trailing break) already stripped
 * out, and `hasTrailingBreak` records whether one was there.
 */
export interface CaseGroup<Cond> {
  readonly condition: ConditionHandle<Cond> | null;
  readonly hasTrailingBreak: boolean;
  readonly body: StatementBlock<Cond>;
}

/**
 * What every lowered statement has on it, whichever construct it is.
 *
 * The lowering works `exitKind` out by scanning the statement's own
 * subtree for a return or a throw, skipping every nested function body.
 *
 * `callbacks` is the bodies of the functions this statement passes to
 * calls it makes, as far as the language counts those as running for the
 * enclosing unit. The engine walks them on the same path as the
 * statement, so their branches are the unit's branches. Their `return`
 * is not the unit's, so a path that ends inside one continues past the
 * statement. A lowering that leaves the field out behaves as it did
 * before there was one.
 */
export interface LoweredStatementParts<Cond> {
  readonly exitKind: ExitKind;
  readonly callbacks?: readonly StatementBlock<Cond>[];
}

/**
 * One statement in the unit's control flow, already lowered out of the
 * source language. `kind` says which construct it is, `condition` (where
 * one applies) is the opaque test, and the block and group fields are its
 * children. `LoweredStatementParts` describes the rest.
 */
export type StructuredStatement<Cond = unknown> =
  | (LoweredStatementParts<Cond> & {
      readonly kind: "if";
      readonly condition: ConditionHandle<Cond>;
      readonly thenBody: StatementBlock<Cond>;
      /** null when the source has no else/elif tail at all. */
      readonly elseBody: StatementBlock<Cond> | null;
    })
  | (LoweredStatementParts<Cond> & {
      readonly kind: "switch";
      /** Source order; at most one group has a null (default) condition. */
      readonly groups: readonly CaseGroup<Cond>[];
    })
  | (LoweredStatementParts<Cond> & {
      readonly kind: "loop";
      /** Display text for the loop header. The engine builds two synthetic conditions out of it: "some iteration of: ..." and "loop exited via ...: ...". */
      readonly condition: ConditionHandle<Cond>;
      readonly body: StatementBlock<Cond>;
    })
  | (LoweredStatementParts<Cond> & {
      readonly kind: "try";
      readonly tryBody: StatementBlock<Cond>;
      readonly catchBody: StatementBlock<Cond> | null;
      /** Here only so it can be validated. A finally that exits, or that contains a terminal the caller gave us, is not modeled, and its own conditions are never enumerated. */
      readonly finallyBody: StatementBlock<Cond> | null;
    })
  | (LoweredStatementParts<Cond> & {
      readonly kind: "exit";
      readonly exit: "return" | "throw" | "break" | "continue";
    })
  | (LoweredStatementParts<Cond> & {
      /** Anything else: expression statements, declarations, and any statement the enumeration does not branch on. */
      readonly kind: "opaque";
    });
