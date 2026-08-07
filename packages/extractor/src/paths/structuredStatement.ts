// structuredStatement.ts: the language-neutral shape the path engine
// walks. Statement kind, condition handle, children, exit kind (see
// docs/internal/roadmap-second-language.md, "Path engine: abstract it
// once"). Each language's adapter lowers its own AST into this shape,
// and enumeratePaths.ts never touches a language-specific node again.
//
// The `Cond` type parameter is the language's own handle for a
// condition expression (a ts-morph Expression for TypeScript, a
// tree-sitter node for a future language). The engine threads it
// through untouched, for a caller to parse later. It never inspects
// what's inside.

/** A condition source's outcome kind: what a branch's own body does. */
export type ConditionSource =
  | "explicit"
  | "earlyReturn"
  | "earlyThrow"
  | "catchBlock";

/** Whether a statement's own subtree exits the unit via return or throw, a throw anywhere winning over a return anywhere. Never set for break/continue. */
export type ExitKind = "return" | "throw" | null;

/**
 * A test the engine threads through opaque: its display text plus the
 * language's own expression handle (null for a synthetic condition,
 * such as a loop's synthesized "some iteration of" marker or a switch
 * group's disjunction text).
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
 * One switch/match case group, already merged from the language's own
 * grammar (TypeScript stacks several empty-bodied labels onto the
 * clause that finally carries a body, and the lowering step folds that
 * into one group with a joined condition). `condition` is null for
 * the default/wildcard group. `body` has any language-specific
 * fallthrough-joining statement (a trailing break) already stripped;
 * `hasTrailingBreak` says whether one was there.
 */
export interface CaseGroup<Cond> {
  readonly condition: ConditionHandle<Cond> | null;
  readonly hasTrailingBreak: boolean;
  readonly body: StatementBlock<Cond>;
}

/**
 * One statement in the unit's control-flow shape, already lowered from
 * the source language. Every variant carries the same four things the
 * roadmap named: `kind` says which construct it is, `condition` (where
 * one applies) is the opaque test, the block/group fields are its
 * children, and `exitKind` is precomputed by the lowering step (a deep
 * scan of the statement's own subtree for a return or throw, skipping
 * nested function bodies, the same scan every language needs to
 * classify a guard as an early return or an early throw).
 */
export type StructuredStatement<Cond = unknown> =
  | {
      readonly kind: "if";
      readonly condition: ConditionHandle<Cond>;
      readonly thenBody: StatementBlock<Cond>;
      /** null when the source has no else/elif tail at all. */
      readonly elseBody: StatementBlock<Cond> | null;
      readonly exitKind: ExitKind;
    }
  | {
      readonly kind: "switch";
      /** Source order; at most one group has a null (default) condition. */
      readonly groups: readonly CaseGroup<Cond>[];
      readonly exitKind: ExitKind;
    }
  | {
      readonly kind: "loop";
      /** Display text for the loop header. The engine builds two synthetic conditions from it: "some iteration of: ...", "loop exited via ...: ...". */
      readonly condition: ConditionHandle<Cond>;
      readonly body: StatementBlock<Cond>;
      readonly exitKind: ExitKind;
    }
  | {
      readonly kind: "try";
      readonly tryBody: StatementBlock<Cond>;
      readonly catchBody: StatementBlock<Cond> | null;
      /** Present only to validate: a finally that exits or holds a caller-given terminal is unmodeled, never enumerated for its own conditions. */
      readonly finallyBody: StatementBlock<Cond> | null;
      readonly exitKind: ExitKind;
    }
  | {
      readonly kind: "exit";
      readonly exit: "return" | "throw" | "break" | "continue";
      readonly exitKind: ExitKind;
    }
  | {
      /** Anything else: expression statements, declarations, and any statement the enumeration doesn't branch on. */
      readonly kind: "opaque";
      readonly exitKind: ExitKind;
    };
