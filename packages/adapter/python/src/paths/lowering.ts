// lowering.ts: Python tree-sitter statements to StructuredStatement<PyNode>.
// The shared path engine is generic over the language's condition handle,
// so the README's table of what each construct lowers to is the contract.

import { field, NodeMap, NodeSet } from "../ast.js";

import type {
  CaseGroup,
  ConditionHandle,
  ExitKind,
  StatementBlock,
  StructuredStatement,
} from "@suss/extractor";
import type { PyNode } from "../parser.js";

const EXIT_KINDS: Record<string, "return" | "throw" | "break" | "continue"> = {
  return_statement: "return",
  raise_statement: "throw",
  break_statement: "break",
  continue_statement: "continue",
};

/** A body written in one of these belongs to the function it declares. */
const NESTED_FUNCTION_TYPES = new Set(["function_definition", "lambda"]);

export interface PythonLowering {
  statements: StatementBlock<PyNode>;
  terminalsByStmt: Map<StructuredStatement<PyNode>, readonly PyNode[]>;
  /** Where each terminal ended up, so a caller can stop an ancestor walk there. */
  terminalHome: NodeMap<StructuredStatement<PyNode>>;
}

/** A raise anywhere beats a return anywhere, which is what the engine expects. */
function exitKindOf(node: PyNode, thrown: NodeSet): ExitKind {
  let sawReturn = false;
  const raises = (current: PyNode): boolean => {
    for (const child of current.namedChildren) {
      if (child === null || NESTED_FUNCTION_TYPES.has(child.type)) {
        continue;
      }
      if (child.type === "raise_statement" || thrown.has(child)) {
        return true;
      }
      if (child.type === "return_statement") {
        sawReturn = true;
      }
      if (raises(child)) {
        return true;
      }
    }
    return false;
  };

  if (raises(node)) {
    return "throw";
  }
  return sawReturn ? "return" : null;
}

function handleOf(node: PyNode | null): ConditionHandle<PyNode> {
  return node === null
    ? { sourceText: "", expression: null }
    : { sourceText: node.text, expression: node };
}

function blockStatements(block: PyNode | null): PyNode[] {
  if (block === null) {
    return [];
  }
  return block.namedChildren.filter((child): child is PyNode => child !== null);
}

function childBlock(node: PyNode): PyNode | null {
  return (
    node.namedChildren.find(
      (child): child is PyNode => child !== null && child.type === "block",
    ) ?? null
  );
}

class Lowerer {
  readonly terminalsByStmt = new Map<
    StructuredStatement<PyNode>,
    readonly PyNode[]
  >();
  readonly terminalHome = new NodeMap<StructuredStatement<PyNode>>();

  // tree-sitter hands back a fresh wrapper object each time a child is
  // read, so a terminal is matched by its stable node id.
  constructor(
    private readonly terminals: ReadonlyMap<number, PyNode>,
    private readonly thrown: NodeSet,
  ) {}

  private attach(
    statement: StructuredStatement<PyNode>,
    candidates: readonly (PyNode | null)[],
  ): StructuredStatement<PyNode> {
    const found = candidates.flatMap((node) => {
      const match = node === null ? undefined : this.terminals.get(node.id);
      return match === undefined ? [] : [match];
    });
    if (found.length > 0) {
      this.terminalsByStmt.set(statement, found);
      for (const node of found) {
        this.terminalHome.set(node, statement);
      }
    }
    return statement;
  }

  lowerBlock(block: PyNode | null): StatementBlock<PyNode> {
    return blockStatements(block).map((statement) => this.lower(statement));
  }

  /** An elif chain reads as an if nested in the previous else arm. */
  private lowerIfTail(
    clauses: readonly PyNode[],
    index: number,
  ): StatementBlock<PyNode> | null {
    const clause = clauses[index];
    if (clause === undefined) {
      return null;
    }
    if (clause.type === "else_clause") {
      return this.lowerBlock(childBlock(clause));
    }

    const nested: StructuredStatement<PyNode> = {
      kind: "if",
      condition: handleOf(field(clause, "condition")),
      thenBody: this.lowerBlock(field(clause, "consequence")),
      elseBody: this.lowerIfTail(clauses, index + 1),
      exitKind: exitKindOf(clause, this.thrown),
    };
    this.attach(nested, [field(clause, "condition")]);
    return [nested];
  }

  private lowerIf(node: PyNode): StructuredStatement<PyNode> {
    const clauses = node.namedChildren.filter(
      (child): child is PyNode =>
        child !== null &&
        (child.type === "elif_clause" || child.type === "else_clause"),
    );
    return {
      kind: "if",
      condition: handleOf(field(node, "condition")),
      thenBody: this.lowerBlock(field(node, "consequence")),
      elseBody: this.lowerIfTail(clauses, 0),
      exitKind: exitKindOf(node, this.thrown),
    };
  }

  private lowerTry(node: PyNode): StructuredStatement<PyNode> {
    const excepts = node.namedChildren.filter(
      (child): child is PyNode =>
        child !== null &&
        (child.type === "except_clause" ||
          child.type === "except_group_clause"),
    );
    const finallyClause =
      node.namedChildren.find(
        (child): child is PyNode =>
          child !== null && child.type === "finally_clause",
      ) ?? null;

    return {
      kind: "try",
      tryBody: this.lowerBlock(field(node, "body")),
      catchBody:
        excepts.length > 0
          ? excepts.flatMap((clause) => this.lowerBlock(childBlock(clause)))
          : null,
      finallyBody:
        finallyClause === null
          ? null
          : this.lowerBlock(childBlock(finallyClause)),
      exitKind: exitKindOf(node, this.thrown),
    };
  }

  private lowerMatch(node: PyNode): StructuredStatement<PyNode> {
    const cases = blockStatements(field(node, "body")).filter(
      (child) => child.type === "case_clause",
    );
    const groups: CaseGroup<PyNode>[] = cases.map((clause) => {
      const pattern =
        clause.namedChildren.find(
          (child): child is PyNode =>
            child !== null && child.type === "case_pattern",
        ) ?? null;
      return {
        condition: pattern?.text.trim() === "_" ? null : handleOf(pattern),
        hasTrailingBreak: false,
        body: this.lowerBlock(field(clause, "consequence")),
      };
    });
    return { kind: "switch", groups, exitKind: exitKindOf(node, this.thrown) };
  }

  lower(node: PyNode): StructuredStatement<PyNode> {
    // A call that raises inside the library leaves the unit as surely as
    // a `raise` does, and only the caller knows which calls those are.
    if (this.thrown.has(node)) {
      return this.attach({ kind: "exit", exit: "throw", exitKind: "throw" }, [
        node,
      ]);
    }

    const exit = EXIT_KINDS[node.type];
    if (exit !== undefined) {
      return this.attach(
        { kind: "exit", exit, exitKind: exitKindOf(node, this.thrown) },
        [node],
      );
    }

    if (node.type === "if_statement") {
      return this.attach(this.lowerIf(node), [field(node, "condition")]);
    }

    if (node.type === "while_statement" || node.type === "for_statement") {
      const header =
        node.type === "while_statement"
          ? field(node, "condition")
          : field(node, "right");
      return this.attach(
        {
          kind: "loop",
          condition: handleOf(header),
          body: this.lowerBlock(field(node, "body")),
          exitKind: exitKindOf(node, this.thrown),
        },
        [header],
      );
    }

    if (node.type === "try_statement") {
      return this.attach(this.lowerTry(node), []);
    }

    if (node.type === "match_statement") {
      return this.attach(this.lowerMatch(node), [field(node, "subject")]);
    }

    return this.attach(
      { kind: "opaque", exitKind: exitKindOf(node, this.thrown) },
      [node],
    );
  }
}

/**
 * Lower one function body, and say where each terminal ended up. The
 * terminals are whatever the caller wants paths to, which for a route is
 * its return statements and the calls its pack says end the request.
 *
 * `thrown` is the set of statements that leave the unit without being
 * written as a `raise`, which is what a call like Flask's `abort` does.
 */
export function lowerPythonBody(
  body: PyNode | null,
  terminals: readonly PyNode[],
  thrown: NodeSet = new NodeSet(),
): PythonLowering {
  const lowerer = new Lowerer(
    new Map(terminals.map((terminal) => [terminal.id, terminal])),
    thrown,
  );
  return {
    statements: lowerer.lowerBlock(body),
    terminalsByStmt: lowerer.terminalsByStmt,
    terminalHome: lowerer.terminalHome,
  };
}
