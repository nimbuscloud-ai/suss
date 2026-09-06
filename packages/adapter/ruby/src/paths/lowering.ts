// lowering.ts: Ruby tree-sitter statements to StructuredStatement<RbNode>.
// The shared path engine is generic over the language's condition handle,
// so the README's table of what each construct lowers to is the contract.

import { field, NodeMap, NodeSet, OWN_BODY_TYPES } from "../ast.js";

import type {
  CaseGroup,
  ConditionHandle,
  ExitKind,
  StatementBlock,
  StructuredStatement,
} from "@suss/extractor";
import type { RbNode } from "../parser.js";

/** `raise` is an ordinary method call in Ruby rather than a keyword. */
const RAISE_NAMES = new Set(["raise", "fail"]);

/**
 * A `return` written in a block belongs to the method the block is written
 * in, so the scan descends into `do_block`. A lambda captures its own
 * return, and a nested method or class starts a new one.
 */
const CAPTURES_RETURN = new Set([
  "method",
  "singleton_method",
  "lambda",
  "class",
  "module",
  "singleton_class",
]);

const KEYWORD_EXITS: Record<string, "return" | "break" | "continue"> = {
  return: "return",
  break: "break",
  next: "continue",
  redo: "continue",
};

export interface RubyLowering {
  statements: StatementBlock<RbNode>;
  terminalsByStmt: Map<StructuredStatement<RbNode>, readonly RbNode[]>;
  /** Where each terminal ended up, so a caller can stop an ancestor walk there. */
  terminalHome: NodeMap<StructuredStatement<RbNode>>;
}

/** Whether this call is a raise, which is Ruby's throw. */
function isRaise(node: RbNode): boolean {
  if (node.type !== "call") {
    return false;
  }
  const receiver = field(node, "receiver");
  const method = field(node, "method") ?? node.namedChildren[0] ?? null;
  return receiver === null && method !== null && RAISE_NAMES.has(method.text);
}

function exitOf(
  node: RbNode,
): "return" | "throw" | "break" | "continue" | null {
  if (isRaise(node)) {
    return "throw";
  }
  return KEYWORD_EXITS[node.type] ?? null;
}

/** A raise anywhere beats a return anywhere, which is what the engine expects. */
function exitKindOf(node: RbNode): ExitKind {
  let sawReturn = false;
  const raises = (current: RbNode): boolean => {
    for (const child of current.namedChildren) {
      if (child === null || CAPTURES_RETURN.has(child.type)) {
        continue;
      }
      if (isRaise(child)) {
        return true;
      }
      if (child.type === "return") {
        sawReturn = true;
      }
      if (raises(child)) {
        return true;
      }
    }
    return false;
  };

  if (isRaise(node) || raises(node)) {
    return "throw";
  }
  return node.type === "return" || sawReturn ? "return" : null;
}

function handleOf(node: RbNode | null): ConditionHandle<RbNode> {
  return node === null
    ? { sourceText: "", expression: null }
    : { sourceText: node.text, expression: node };
}

/**
 * A reader of a condition wants to see `respond_to`, not the whole block
 * underneath it, so the header stops where the block starts.
 */
function callHeaderOf(call: RbNode, block: RbNode): ConditionHandle<RbNode> {
  const header = call.text.slice(0, block.startIndex - call.startIndex).trim();
  return {
    sourceText: header === "" ? call.text : header,
    expression: call,
  };
}

/** `then`, `else` and a bare body all read as a list of statements. */
function blockStatements(block: RbNode | null): RbNode[] {
  if (block === null) {
    return [];
  }
  return block.namedChildren.filter((child): child is RbNode => child !== null);
}

class Lowerer {
  readonly terminalsByStmt = new Map<
    StructuredStatement<RbNode>,
    readonly RbNode[]
  >();
  readonly terminalHome = new NodeMap<StructuredStatement<RbNode>>();

  constructor(
    private readonly terminals: ReadonlyMap<number, RbNode>,
    private readonly responseCalls: NodeSet,
  ) {}

  private attachTerminals(
    statement: StructuredStatement<RbNode>,
    found: readonly RbNode[],
  ): StructuredStatement<RbNode> {
    if (found.length === 0) {
      return statement;
    }
    const already = this.terminalsByStmt.get(statement) ?? [];
    this.terminalsByStmt.set(statement, [...already, ...found]);
    for (const node of found) {
      this.terminalHome.set(node, statement);
    }
    return statement;
  }

  private attach(
    statement: StructuredStatement<RbNode>,
    candidates: readonly (RbNode | null)[],
  ): StructuredStatement<RbNode> {
    const found = candidates.flatMap((node) => {
      const match = node === null ? undefined : this.terminals.get(node.id);
      return match === undefined ? [] : [match];
    });
    return this.attachTerminals(statement, found);
  }

  /** The response calls written inside one statement, which the caller gave as the calls that end a path. */
  private responsesIn(node: RbNode, found: RbNode[] = []): RbNode[] {
    if (this.responseCalls.size === 0) {
      return found;
    }
    const own = this.responseCalls.get(node);
    if (own !== undefined) {
      found.push(own);
      return found;
    }
    for (const child of node.namedChildren) {
      if (child !== null && !OWN_BODY_TYPES.has(child.type)) {
        this.responsesIn(child, found);
      }
    }
    return found;
  }

  lowerBlock(block: RbNode | null): StatementBlock<RbNode> {
    return blockStatements(block).map((statement) => this.lower(statement));
  }

  /** An elsif chain reads as an if nested in the previous else arm. */
  private lowerAlternative(node: RbNode | null): StatementBlock<RbNode> | null {
    if (node === null) {
      return null;
    }
    if (node.type !== "elsif") {
      return this.lowerBlock(node);
    }

    const nested: StructuredStatement<RbNode> = {
      kind: "if",
      condition: handleOf(field(node, "condition")),
      thenBody: this.lowerBlock(field(node, "consequence")),
      elseBody: this.lowerAlternative(field(node, "alternative")),
      exitKind: exitKindOf(node),
    };
    this.attach(nested, [field(node, "condition")]);
    return [nested];
  }

  private lowerIf(node: RbNode): StructuredStatement<RbNode> {
    return {
      kind: "if",
      condition: handleOf(field(node, "condition")),
      thenBody: this.lowerBlock(field(node, "consequence")),
      elseBody: this.lowerAlternative(field(node, "alternative")),
      exitKind: exitKindOf(node),
    };
  }

  /** `render :gone if expired?` gates one statement on one test, so it reads as an if with no else arm. */
  private lowerIfModifier(node: RbNode): StructuredStatement<RbNode> {
    const body = field(node, "body");
    return {
      kind: "if",
      condition: handleOf(field(node, "condition")),
      thenBody: body === null ? [] : [this.lower(body)],
      elseBody: null,
      exitKind: exitKindOf(node),
    };
  }

  private lowerBegin(node: RbNode): StructuredStatement<RbNode> {
    const rescues = node.namedChildren.filter(
      (child): child is RbNode => child !== null && child.type === "rescue",
    );
    const ensureClause =
      node.namedChildren.find(
        (child): child is RbNode => child !== null && child.type === "ensure",
      ) ?? null;
    const tryBody = node.namedChildren.filter(
      (child): child is RbNode =>
        child !== null &&
        child.type !== "rescue" &&
        child.type !== "ensure" &&
        child.type !== "else",
    );

    return {
      kind: "try",
      tryBody: tryBody.map((statement) => this.lower(statement)),
      catchBody:
        rescues.length > 0
          ? rescues.flatMap((clause) => this.lowerBlock(field(clause, "body")))
          : null,
      finallyBody: ensureClause === null ? null : this.lowerBlock(ensureClause),
      exitKind: exitKindOf(node),
    };
  }

  private lowerCase(node: RbNode): StructuredStatement<RbNode> {
    const groups: CaseGroup<RbNode>[] = [];
    for (const child of node.namedChildren) {
      if (child === null) {
        continue;
      }
      if (child.type === "when") {
        groups.push({
          condition: handleOf(field(child, "pattern")),
          hasTrailingBreak: false,
          body: this.lowerBlock(field(child, "body")),
        });
      }
      if (child.type === "else") {
        groups.push({
          condition: null,
          hasTrailingBreak: false,
          body: this.lowerBlock(child),
        });
      }
    }
    return { kind: "switch", groups, exitKind: exitKindOf(node) };
  }

  lower(node: RbNode): StructuredStatement<RbNode> {
    const exit = exitOf(node);
    if (exit !== null) {
      const statement = this.attach(
        { kind: "exit", exit, exitKind: exitKindOf(node) },
        [node],
      );
      return this.attachTerminals(statement, this.responsesIn(node));
    }

    if (node.type === "if" || node.type === "unless") {
      return this.attach(this.lowerIf(node), [field(node, "condition")]);
    }

    if (node.type === "if_modifier" || node.type === "unless_modifier") {
      return this.attach(this.lowerIfModifier(node), [
        field(node, "condition"),
      ]);
    }

    if (node.type === "while" || node.type === "until" || node.type === "for") {
      const header = field(node, "condition") ?? field(node, "value");
      return this.attach(
        {
          kind: "loop",
          condition: handleOf(header),
          body: this.lowerBlock(field(node, "body")),
          exitKind: exitKindOf(node),
        },
        [header],
      );
    }

    // `items.each do |i| ... end` runs its block per iteration and a return
    // inside it returns from the method, which is what a loop already means
    // to the engine.
    const attachedBlock = node.namedChildren.find(
      (child): child is RbNode =>
        child !== null && (child.type === "do_block" || child.type === "block"),
    );
    if (node.type === "call" && attachedBlock !== undefined) {
      return this.attach(
        {
          kind: "loop",
          condition: callHeaderOf(node, attachedBlock),
          body: this.lowerBlock(field(attachedBlock, "body") ?? attachedBlock),
          exitKind: exitKindOf(node),
        },
        [node],
      );
    }

    if (node.type === "begin" || node.type === "rescue_modifier") {
      return this.attach(this.lowerBegin(node), []);
    }

    if (node.type === "case" || node.type === "case_match") {
      return this.attach(this.lowerCase(node), [field(node, "value")]);
    }

    // Rails raises on a second render, so a statement that responds is the
    // last thing its path does.
    const responses = this.responsesIn(node);
    if (responses.length > 0) {
      return this.attachTerminals(
        { kind: "exit", exit: "return", exitKind: "return" },
        responses,
      );
    }

    return this.attach({ kind: "opaque", exitKind: exitKindOf(node) }, [node]);
  }
}

/**
 * Lower one method body, and say where each terminal ended up. The terminals
 * are whatever the caller wants paths to, which for a resolver is its return
 * statements and its raises.
 *
 * `responseCalls` is for a caller reading what an action responds with: each
 * one is a terminal, and the statement it is written in leaves the method
 * rather than falling through to whatever comes next.
 */
export function lowerRubyBody(
  body: RbNode | null,
  terminals: readonly RbNode[],
  responseCalls: readonly RbNode[] = [],
): RubyLowering {
  const lowerer = new Lowerer(
    new Map(terminals.map((terminal) => [terminal.id, terminal])),
    new NodeSet(responseCalls),
  );
  return {
    statements: lowerer.lowerBlock(body),
    terminalsByStmt: lowerer.terminalsByStmt,
    terminalHome: lowerer.terminalHome,
  };
}
