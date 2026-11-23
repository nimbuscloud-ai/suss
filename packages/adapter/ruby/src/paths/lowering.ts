/**
 * Lowers Ruby tree-sitter statements into the `StructuredStatement<RbNode>`
 * form the shared path engine walks. The engine is generic over each
 * language's condition handle, so what each Ruby construct lowers to is
 * the whole contract between this module and the engine.
 */

import {
  children,
  field,
  NodeMap,
  NodeSet,
  OWN_BODY_TYPES,
  rangeOf,
} from "../ast.js";
import {
  caseArmOf,
  caseArmText,
  matchesAnything,
  whenArmOf,
} from "./caseArms.js";

import type {
  CaseGroup,
  ConditionHandle,
  ExitKind,
  StatementBlock,
  StructuredStatement,
} from "@suss/extractor";
import type { RbFormatSwitch } from "../pack.js";
import type { RbNode } from "../parser.js";

/** `raise` is an ordinary method call in Ruby, and not a keyword. */
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
export function isRaise(node: RbNode): boolean {
  if (node.type !== "call") {
    return false;
  }
  const receiver = field(node, "receiver");
  const method = field(node, "method") ?? node.namedChild(0) ?? null;
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

const NOTHING_CLAIMED: ReadonlySet<number> = new Set<number>();

/**
 * A raise anywhere in the node wins over a return anywhere, as the engine
 * expects. A `claimed` block runs as a unit of its own, so what it does
 * does not leave this body.
 */
function exitKindOf(node: RbNode, claimed: ReadonlySet<number>): ExitKind {
  let sawReturn = false;
  const raises = (current: RbNode): boolean => {
    for (const child of children(current)) {
      if (
        child === null ||
        CAPTURES_RETURN.has(child.type) ||
        claimed.has(child.id)
      ) {
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
 * The condition text for a call with a block stops where the block
 * starts, so a reader sees `respond_to` and not the whole block under it.
 */
function callHeaderOf(call: RbNode, block: RbNode): ConditionHandle<RbNode> {
  const header = call.text.slice(0, block.startIndex - call.startIndex).trim();
  return {
    sourceText: header === "" ? call.text : header,
    expression: call,
  };
}

/**
 * `case ... in` with no `else` raises when no arm matches, so that path
 * ends there.
 */
const NO_PATTERN_MATCHED: CaseGroup<RbNode> = {
  condition: null,
  hasTrailingBreak: true,
  body: [{ kind: "exit", exit: "throw", exitKind: "throw" }],
};

/** A throw anywhere wins over a return anywhere, as the engine expects. */
function strongestExit(kinds: readonly ExitKind[]): ExitKind {
  if (kinds.includes("throw")) {
    return "throw";
  }
  return kinds.includes("return") ? "return" : null;
}

/** `then`, `else` and a bare body all read as a list of statements. */
function blockStatements(block: RbNode | null): RbNode[] {
  return block === null ? [] : children(block);
}

/** One `format.json { ... }` in a format switch. */
interface FormatArm {
  format: string;
  /** The arm as written up to its block, `format.json`. */
  header: string;
  block: RbNode | null;
}

function attachedBlockOf(call: RbNode): RbNode | null {
  return (
    children(call).find(
      (child): child is RbNode =>
        child !== null && (child.type === "do_block" || child.type === "block"),
    ) ?? null
  );
}

/** The one parameter a block takes, `format` in `do |format|`. */
function soleBlockParameter(block: RbNode): string | null {
  const names = children(field(block, "parameters")).filter(
    (child) => child.type === "identifier",
  );
  return names.length === 1 ? (names[0] as RbNode).text : null;
}

/** A block's statements, without its parameter list. */
function blockBodyStatements(block: RbNode): RbNode[] {
  const body = field(block, "body");
  if (body !== null) {
    return children(body);
  }
  return children(block).filter((child) => child.type !== "block_parameters");
}

/** The node whose statements an arm's block runs. */
function armBody(block: RbNode): RbNode {
  return field(block, "body") ?? block;
}

/** The arm a statement is when it is a call on the block's parameter, or null. */
function formatArmOf(statement: RbNode, parameter: string): FormatArm | null {
  if (statement.type !== "call") {
    return null;
  }
  const receiver = field(statement, "receiver");
  const format = field(statement, "method")?.text;
  if (receiver?.text !== parameter || format === undefined) {
    return null;
  }
  const block = attachedBlockOf(statement);
  return {
    format,
    header:
      block === null
        ? statement.text
        : callHeaderOf(statement, block).sourceText,
    block,
  };
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
    private readonly formatSwitch: RbFormatSwitch | undefined,
    private readonly claimed: ReadonlySet<number>,
  ) {}

  private exitKindOf(node: RbNode): ExitKind {
    return exitKindOf(node, this.claimed);
  }

  /** The block written with this call, unless a pack claims it as a unit of its own. */
  private blockRunBy(call: RbNode): RbNode | null {
    const block = attachedBlockOf(call);
    return block === null || this.claimed.has(block.id) ? null : block;
  }

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

  /** The response calls inside one statement. The caller passed these as the calls that end a path. */
  private responsesIn(node: RbNode, found: RbNode[] = []): RbNode[] {
    if (this.responseCalls.size === 0) {
      return found;
    }
    const own = this.responseCalls.get(node);
    if (own !== undefined) {
      found.push(own);
      return found;
    }
    for (const child of children(node)) {
      if (
        child !== null &&
        !OWN_BODY_TYPES.has(child.type) &&
        !this.claimed.has(child.id)
      ) {
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
      exitKind: this.exitKindOf(node),
    };
    this.attach(nested, [field(node, "condition")]);
    return [nested];
  }

  /**
   * `unless ok` runs its body when `ok` is false, so it lowers to an `if` on
   * the same test with the two arms the other way around. Without the swap
   * a summary would say a branch runs on the test that skips it.
   */
  private lowerIf(node: RbNode): StructuredStatement<RbNode> {
    const consequence = this.lowerBlock(field(node, "consequence"));
    const alternative = this.lowerAlternative(field(node, "alternative"));
    const inverted = node.type === "unless";
    return {
      kind: "if",
      condition: handleOf(field(node, "condition")),
      thenBody: inverted ? (alternative ?? []) : consequence,
      elseBody: inverted ? consequence : alternative,
      exitKind: this.exitKindOf(node),
    };
  }

  /** `render :gone if expired?` lowers to an `if` with one arm, on whichever side of the test the modifier puts the statement. */
  private lowerIfModifier(node: RbNode): StructuredStatement<RbNode> {
    const body = field(node, "body");
    const gated = body === null ? [] : [this.lower(body)];
    const inverted = node.type === "unless_modifier";
    return {
      kind: "if",
      condition: handleOf(field(node, "condition")),
      thenBody: inverted ? [] : gated,
      elseBody: inverted ? gated : null,
      exitKind: this.exitKindOf(node),
    };
  }

  private lowerBegin(node: RbNode): StructuredStatement<RbNode> {
    const rescues = children(node).filter((child) => child.type === "rescue");
    const ensureClause =
      children(node).find((child) => child.type === "ensure") ?? null;
    const tryBody = children(node).filter(
      (child): child is RbNode =>
        child !== null &&
        child.type !== "rescue" &&
        child.type !== "ensure" &&
        child.type !== "else",
    );

    return {
      kind: "try",
      lines: rangeOf(node),
      tryBody: tryBody.map((statement) => this.lower(statement)),
      catchBody:
        rescues.length > 0
          ? rescues.flatMap((clause) => this.lowerBlock(field(clause, "body")))
          : null,
      finallyBody: ensureClause === null ? null : this.lowerBlock(ensureClause),
      exitKind: this.exitKindOf(node),
    };
  }

  /**
   * Ruby runs one arm of a `case` and never falls into the next, so each
   * arm is a group that ends with an implicit break. With no subject,
   * each arm tests a condition of its own in order, which is what an
   * `elsif` chain does, so it lowers the same way.
   */
  private lowerCase(node: RbNode): StructuredStatement<RbNode> {
    const arms = children(node).filter(
      (child) => child.type === "when" || child.type === "in_clause",
    );
    const otherwise = children(node).find((child) => child.type === "else");
    const [first, ...rest] = arms;
    if (field(node, "value") === null) {
      return first === undefined
        ? { kind: "opaque", exitKind: this.exitKindOf(node) }
        : this.lowerArmChain(first, rest, otherwise ?? null);
    }

    const groups = arms.map((arm) => this.caseGroupOf(arm));
    if (otherwise !== undefined) {
      groups.push({
        condition: null,
        hasTrailingBreak: true,
        body: this.lowerBlock(otherwise),
      });
    }
    // An arm that matches anything leaves the ones after it unreachable.
    const fallback = groups.findIndex((group) => group.condition === null);
    const reachable = fallback === -1 ? groups : groups.slice(0, fallback + 1);
    const raisesUnmatched = fallback === -1 && node.type === "case_match";
    return {
      kind: "switch",
      groups: raisesUnmatched ? [...reachable, NO_PATTERN_MATCHED] : reachable,
      exitKind: this.exitKindOf(node),
    };
  }

  private caseGroupOf(arm: RbNode): CaseGroup<RbNode> {
    const read = caseArmOf(arm);
    return {
      condition:
        read === null || matchesAnything(read)
          ? null
          : { sourceText: caseArmText(read), expression: arm },
      hasTrailingBreak: true,
      body: this.lowerBlock(field(arm, "body")),
    };
  }

  /** One arm as an `if`, with the arms after it nested in its else arm. */
  private lowerArmChain(
    arm: RbNode,
    rest: readonly RbNode[],
    otherwise: RbNode | null,
  ): StructuredStatement<RbNode> {
    const covered = [arm, ...rest, ...(otherwise === null ? [] : [otherwise])];
    return {
      kind: "if",
      condition: { sourceText: caseArmText(whenArmOf(arm)), expression: arm },
      thenBody: this.lowerBlock(field(arm, "body")),
      elseBody: this.lowerChainTail(rest, otherwise),
      exitKind: strongestExit(covered.map((node) => this.exitKindOf(node))),
    };
  }

  /** What runs when an arm's test fails: the next arm, the else body, or nothing. */
  private lowerChainTail(
    rest: readonly RbNode[],
    otherwise: RbNode | null,
  ): StatementBlock<RbNode> | null {
    const [next, ...after] = rest;
    if (next !== undefined) {
      return [this.lowerArmChain(next, after, otherwise)];
    }
    return otherwise === null ? null : this.lowerBlock(otherwise);
  }

  /**
   * `respond_to do |format| ... end` runs one arm per request, picked by
   * the format the request accepts, so it lowers to a switch with an arm
   * per `format.x`. The arm that accepts every format is the default.
   * Without one, a request no arm accepts makes the library raise. Null
   * when the block contains anything besides those arms.
   */
  private lowerFormatSwitch(
    node: RbNode,
    block: RbNode,
  ): StructuredStatement<RbNode> | null {
    const declared = this.formatSwitch;
    if (
      declared === undefined ||
      node.type !== "call" ||
      field(node, "receiver") !== null ||
      field(node, "method")?.text !== declared.name
    ) {
      return null;
    }
    const parameter = soleBlockParameter(block);
    if (parameter === null) {
      return null;
    }
    const arms = blockBodyStatements(block).map((statement) =>
      formatArmOf(statement, parameter),
    );
    if (arms.length === 0 || arms.some((arm) => arm === null)) {
      return null;
    }
    const groups = (arms as FormatArm[]).map(
      (arm): CaseGroup<RbNode> => ({
        condition:
          arm.format === declared.matchesEvery
            ? null
            : { sourceText: arm.header, expression: null },
        hasTrailingBreak: true,
        body: arm.block === null ? [] : this.lowerBlock(armBody(arm.block)),
      }),
    );
    const named = groups.filter((group) => group.condition !== null);
    const fallback = groups.find((group) => group.condition === null) ?? {
      condition: null,
      hasTrailingBreak: true,
      body: [{ kind: "exit", exit: "throw", exitKind: "throw" }],
    };
    return {
      kind: "switch",
      groups: [...named, fallback],
      exitKind: this.exitKindOf(node),
    };
  }

  lower(node: RbNode): StructuredStatement<RbNode> {
    const exit = exitOf(node);
    if (exit !== null) {
      const statement = this.attach(
        { kind: "exit", exit, exitKind: this.exitKindOf(node) },
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
          exitKind: this.exitKindOf(node),
          lines: rangeOf(node),
        },
        [header],
      );
    }

    // `items.each do |i| ... end` runs its block once per item, and a
    // return inside it returns from the method. The engine treats a loop
    // the same way.
    const attachedBlock = this.blockRunBy(node);
    const formatSwitch =
      attachedBlock === null
        ? null
        : this.lowerFormatSwitch(node, attachedBlock);
    if (formatSwitch !== null) {
      return this.attach(formatSwitch, [node]);
    }

    if (node.type === "call" && attachedBlock !== null) {
      return this.attach(
        {
          kind: "loop",
          condition: callHeaderOf(node, attachedBlock),
          body: this.lowerBlock(field(attachedBlock, "body") ?? attachedBlock),
          exitKind: this.exitKindOf(node),
          lines: rangeOf(node),
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

    return this.attach({ kind: "opaque", exitKind: this.exitKindOf(node) }, [
      node,
    ]);
  }
}

/**
 * Lowers one method body and records where each terminal ended up. The
 * terminals are whatever the caller wants paths to. For a resolver those
 * are its return statements and its raises.
 *
 * `responseCalls` is for a caller reading what an action responds with.
 * Each one is a terminal, and the statement it is in leaves the method
 * instead of falling through to the next statement. A `claimed` block
 * is a unit of its own, so it is not read as part of this body.
 */
export function lowerRubyBody(
  body: RbNode | null,
  terminals: readonly RbNode[],
  responseCalls: readonly RbNode[] = [],
  formatSwitch?: RbFormatSwitch,
  claimed: ReadonlySet<number> = NOTHING_CLAIMED,
): RubyLowering {
  const lowerer = new Lowerer(
    new Map(terminals.map((terminal) => [terminal.id, terminal])),
    new NodeSet(responseCalls),
    formatSwitch,
    claimed,
  );
  return {
    statements: lowerer.lowerBlock(body),
    terminalsByStmt: lowerer.terminalsByStmt,
    terminalHome: lowerer.terminalHome,
  };
}
