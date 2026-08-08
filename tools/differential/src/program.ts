// program.ts: the generated-handler DSL and its renderer.
//
// A `HandlerProgram` is a tiny AST over the constructs suss claims to
// model for HTTP handlers: sequential early-return guards over request
// fields, a final response (plain / if-else / ternary), and, in the
// known-gap tiers: nested guards and loop guards. Rendering produces
// two views of the *same* body: an Express module for extraction and a
// bare arrow function for execution, so the two sides of the
// differential can never drift apart.

import { type DispatchTable, dispatchByType } from "./dispatch.js";

export type FieldSource = "params" | "query" | "headers" | "body";

export interface ReqField {
  source: FieldSource;
  key: string;
}

export type Cond =
  | { type: "truthy"; field: ReqField; negated: boolean }
  | { type: "eq"; field: ReqField; value: string; negated: boolean }
  | { type: "has"; field: ReqField; negated: boolean }
  | { type: "and"; left: Cond; right: Cond }
  | { type: "or"; left: Cond; right: Cond };

export interface Terminal {
  /** null → `res.json(body)` (implicit 200); otherwise `res.status(N).json(body)`. */
  status: number | null;
  /** The response body is always `{ [key]: value }`, enough to tell terminals apart. */
  key: string;
  value: string;
}

/**
 * `blockBreak`'s own two dimensions: whether an unrelated statement
 * runs before the braced block in the same clause body (the shape
 * that hides a break behind a leading sibling statement, not only
 * behind the block itself), and how many braces wrap the break, one
 * block or a block nested inside another. Lowering's own break scan
 * has to find the break through either, at any depth, so both are
 * worth generating.
 */
export interface BlockBreakShape {
  hasSibling: boolean;
  depth: 1 | 2;
}

/**
 * `blockNested`'s own two dimensions: whether the block wraps a small
 * if or a small switch (both side-effect only, so this clause's own
 * response always fires exactly once regardless of which branch the
 * nested construct takes), and whether the clause exits by breaking
 * out of the switch or returning from the function directly. Lowering
 * treats a control-flow construct sitting behind a block the same way
 * it treats the block itself: opaque, decomposed into nothing, the
 * same shape a bare pass-through statement there would produce.
 */
export interface BlockNestedShape {
  nested: "if" | "switch";
  exit: "break" | "return";
  /** The nested if's own condition; ignored when `nested` is "switch". */
  cond: Cond;
  /** The nested switch's own discriminant field; ignored when `nested` is "if". */
  field: ReqField;
}

/**
 * One switch/case clause. `break` and `return` are the sound
 * trailing-exit shapes; `blockBreak` wraps the same body in braces
 * (`case v: { respond; break; }`, optionally preceded by a sibling
 * statement and nested one block deeper), a shape lowering declines
 * to model and degrades, the same way the legacy scanner always did;
 * `blockNested` wraps a small if or switch in braces alongside this
 * clause's own response, a shape lowering keeps opaque rather than
 * decomposing; `fallthrough` is an empty clause that stacks its label
 * onto the next non-empty one, TypeScript's own case-grouping grammar.
 */
export type SwitchClause =
  | { value: string; type: "break"; terminal: Terminal }
  | ({
      value: string;
      type: "blockBreak";
      terminal: Terminal;
    } & BlockBreakShape)
  | ({
      value: string;
      type: "blockNested";
      terminal: Terminal;
    } & BlockNestedShape)
  | { value: string; type: "return"; terminal: Terminal }
  | { value: string; type: "fallthrough" };

/**
 * The switch's mandatory `default` clause. A `switchGuard` always
 * has one (never `fallthrough`, never absent), so the switch is
 * exhaustive: every possible field value produces exactly one
 * response from inside it. A "break" clause only exits the switch,
 * not the function, so an unmatched value with no default would fall
 * through to whatever guard or final statement comes next. A
 * matched-and-broken clause has the same problem, closed the same
 * way, in the renderer below.
 */
export type SwitchDefaultClause =
  | { type: "break"; terminal: Terminal }
  | ({ type: "blockBreak"; terminal: Terminal } & BlockBreakShape)
  | ({ type: "blockNested"; terminal: Terminal } & BlockNestedShape)
  | { type: "return"; terminal: Terminal };

/**
 * Statements that may appear before the final response.
 *
 * - `guard` is the sound construct: a top-level `if (c) { respond; return; }`.
 * - `nestedGuard` and `blockGuard` are the documented nested-guard gap
 *   shapes (guards one block deep).
 * - `loopGuard` is the documented loop-return gap shape.
 * - `switchGuard` dispatches on one field's literal value; clauses mix
 *   the sound trailing-break/return/fallthrough shapes with the
 *   block-wrapped one, which lowering declines and degrades rather
 *   than modeling. Rendered with a mandatory `default` and an
 *   unconditional `return` right after the switch, so it always
 *   produces exactly one response and never falls through to
 *   whatever's next, matching every other guard shape's own contract.
 */
export type GuardStmt =
  | { type: "guard"; cond: Cond; terminal: Terminal }
  | { type: "nestedGuard"; outer: Cond; inner: Cond; terminal: Terminal }
  | {
      type: "blockGuard";
      outer: Cond;
      inner: Cond;
      whenInner: Terminal;
      tail: Terminal;
    }
  | {
      type: "loopGuard";
      source: FieldSource;
      keys: string[];
      terminal: Terminal;
    }
  | {
      type: "switchGuard";
      field: ReqField;
      clauses: SwitchClause[];
      defaultClause: SwitchDefaultClause;
    };

export type FinalStmt =
  | { type: "respond"; terminal: Terminal }
  | { type: "ifElse"; cond: Cond; whenTrue: Terminal; whenFalse: Terminal }
  | { type: "ternary"; cond: Cond; whenTrue: Terminal; whenFalse: Terminal };

export interface HandlerProgram {
  guards: GuardStmt[];
  final: FinalStmt;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderField(field: ReqField): string {
  return `req.${field.source}.${field.key}`;
}

const isComposite = (cond: Cond): boolean =>
  cond.type === "and" || cond.type === "or";

function renderOperand(cond: Cond): string {
  const text = renderCond(cond);
  return isComposite(cond) ? `(${text})` : text;
}

const COND_RENDERERS: DispatchTable<Cond, string> = {
  truthy: (cond) =>
    cond.negated ? `!${renderField(cond.field)}` : renderField(cond.field),
  eq: (cond) =>
    `${renderField(cond.field)} ${cond.negated ? "!==" : "==="} ${JSON.stringify(cond.value)}`,
  has: (cond) => {
    const inExpr = `(${JSON.stringify(cond.field.key)} in req.${cond.field.source})`;
    return cond.negated ? `!${inExpr}` : inExpr;
  },
  and: (cond) => `${renderOperand(cond.left)} && ${renderOperand(cond.right)}`,
  or: (cond) => `${renderOperand(cond.left)} || ${renderOperand(cond.right)}`,
};

export function renderCond(cond: Cond): string {
  return dispatchByType(COND_RENDERERS, cond);
}

/**
 * How one terminal is spelled in a target framework's syntax
 * (`res.status(N).json(B)` for Express, `res.code(N).send(B)` for
 * Fastify, …). Provided by the `FuzzTarget` (see target.ts) so the
 * DSL stays framework-neutral.
 */
export type TerminalRenderer = (terminal: Terminal) => string;

/**
 * The lines a "break" or "return" clause body renders to. "blockBreak"
 * needs its own two extra dimensions (a leading sibling statement, a
 * nesting depth), so it renders separately, below.
 */
const SIMPLE_EXIT_LINES: Record<
  "break" | "return",
  (terminal: Terminal, renderTerminal: TerminalRenderer) => string[]
> = {
  break: (terminal, renderTerminal) => [
    `    ${renderTerminal(terminal)};`,
    "    break;",
  ],
  return: (terminal, renderTerminal) => [
    `    ${renderTerminal(terminal)};`,
    "    return;",
  ],
};

/** A side-effecting statement unrelated to the response, standing in for whatever an application's own clause body runs ahead of its exit. */
const SIBLING_STATEMENT_LINE = '    console.log("entering case");';

function renderBlockBreakBody(
  terminal: Terminal,
  shape: BlockBreakShape,
  renderTerminal: TerminalRenderer,
): string[] {
  const open = shape.depth === 2 ? ["    {", "      {"] : ["    {"];
  const close = shape.depth === 2 ? ["      }", "    }"] : ["    }"];
  const innerIndent = shape.depth === 2 ? "        " : "      ";
  return [
    ...(shape.hasSibling ? [SIBLING_STATEMENT_LINE] : []),
    ...open,
    `${innerIndent}${renderTerminal(terminal)};`,
    `${innerIndent}break;`,
    ...close,
  ];
}

/**
 * A small if or switch, doing side-effect-only work so this clause's
 * own response after it stays unconditional either way. Nested inside
 * a block alongside the clause's own terminal and exit, so the whole
 * thing renders as one braced body with a control-flow construct
 * inside it, the shape lowering is required to keep opaque.
 */
function renderBlockNestedBody(
  terminal: Terminal,
  shape: BlockNestedShape,
  renderTerminal: TerminalRenderer,
): string[] {
  const nestedLines =
    shape.nested === "if"
      ? [
          `      if (${renderCond(shape.cond)}) {`,
          '        console.log("nested");',
          "      }",
        ]
      : [
          `      switch (${renderField(shape.field)}) {`,
          '        case "nested-match":',
          '          console.log("nested-match");',
          "          break;",
          "        default:",
          '          console.log("nested-other");',
          "      }",
        ];
  return [
    "    {",
    ...nestedLines,
    `      ${renderTerminal(terminal)};`,
    shape.exit === "return" ? "      return;" : "      break;",
    "    }",
  ];
}

/** Shared between case clauses and the mandatory default clause, which carry the same four exit shapes. */
function renderClauseExitBody(
  clause:
    | { type: "break"; terminal: Terminal }
    | ({ type: "blockBreak"; terminal: Terminal } & BlockBreakShape)
    | ({ type: "blockNested"; terminal: Terminal } & BlockNestedShape)
    | { type: "return"; terminal: Terminal },
  renderTerminal: TerminalRenderer,
): string[] {
  if (clause.type === "blockBreak") {
    return renderBlockBreakBody(clause.terminal, clause, renderTerminal);
  }
  if (clause.type === "blockNested") {
    return renderBlockNestedBody(clause.terminal, clause, renderTerminal);
  }
  return SIMPLE_EXIT_LINES[clause.type](clause.terminal, renderTerminal);
}

function renderSwitchClause(
  clause: SwitchClause,
  renderTerminal: TerminalRenderer,
): string[] {
  const caseLine = `  case ${JSON.stringify(clause.value)}:`;
  if (clause.type === "fallthrough") {
    return [caseLine];
  }
  return [caseLine, ...renderClauseExitBody(clause, renderTerminal)];
}

function renderSwitchDefaultClause(
  defaultClause: SwitchDefaultClause,
  renderTerminal: TerminalRenderer,
): string[] {
  return ["  default:", ...renderClauseExitBody(defaultClause, renderTerminal)];
}

function guardRenderers(
  renderTerminal: TerminalRenderer,
): DispatchTable<GuardStmt, string[]> {
  return {
    guard: (stmt) => [
      `if (${renderCond(stmt.cond)}) {`,
      `  ${renderTerminal(stmt.terminal)};`,
      "  return;",
      "}",
    ],
    nestedGuard: (stmt) => [
      `if (${renderCond(stmt.outer)}) {`,
      `  if (${renderCond(stmt.inner)}) {`,
      `    ${renderTerminal(stmt.terminal)};`,
      "    return;",
      "  }",
      "}",
    ],
    blockGuard: (stmt) => [
      `if (${renderCond(stmt.outer)}) {`,
      `  if (${renderCond(stmt.inner)}) {`,
      `    ${renderTerminal(stmt.whenInner)};`,
      "    return;",
      "  }",
      `  ${renderTerminal(stmt.tail)};`,
      "  return;",
      "}",
    ],
    loopGuard: (stmt) => [
      `for (const key of [${stmt.keys.map((k) => JSON.stringify(k)).join(", ")}]) {`,
      `  if (!req.${stmt.source}[key]) {`,
      `    ${renderTerminal(stmt.terminal)};`,
      "    return;",
      "  }",
      "}",
    ],
    switchGuard: (stmt) => [
      `switch (${renderField(stmt.field)}) {`,
      ...stmt.clauses.flatMap((clause) =>
        renderSwitchClause(clause, renderTerminal),
      ),
      ...renderSwitchDefaultClause(stmt.defaultClause, renderTerminal),
      "}",
      // Every case either returns directly or breaks out of the
      // switch, and the mandatory default catches every value the
      // case clauses don't, so this line is always reached exactly
      // once a case has already responded, never before.
      "return;",
    ],
  };
}

function finalRenderers(
  renderTerminal: TerminalRenderer,
): DispatchTable<FinalStmt, string[]> {
  return {
    respond: (stmt) => [`${renderTerminal(stmt.terminal)};`],
    ifElse: (stmt) => [
      `if (${renderCond(stmt.cond)}) {`,
      `  ${renderTerminal(stmt.whenTrue)};`,
      "} else {",
      `  ${renderTerminal(stmt.whenFalse)};`,
      "}",
    ],
    ternary: (stmt) => [
      `${renderCond(stmt.cond)} ? ${renderTerminal(stmt.whenTrue)} : ${renderTerminal(stmt.whenFalse)};`,
    ],
  };
}

/** Render the handler body as lines, in the target's terminal syntax. */
export function renderBodyLines(
  program: HandlerProgram,
  renderTerminal: TerminalRenderer,
): string[] {
  const guards = guardRenderers(renderTerminal);
  const finals = finalRenderers(renderTerminal);
  return [
    ...program.guards.flatMap((stmt) => dispatchByType(guards, stmt)),
    ...dispatchByType(finals, program.final),
  ];
}

/** The bare arrow function, what the vm harness executes. */
export function renderHandlerSource(
  program: HandlerProgram,
  renderTerminal: TerminalRenderer,
): string {
  const body = renderBodyLines(program, renderTerminal)
    .map((line) => `  ${line}`)
    .join("\n");
  return `(req, res) => {\n${body}\n}`;
}

// ---------------------------------------------------------------------------
// Field collection: which request fields does this program observe?
// ---------------------------------------------------------------------------

function condFields(cond: Cond): ReqField[] {
  const table: DispatchTable<Cond, ReqField[]> = {
    truthy: (c) => [c.field],
    eq: (c) => [c.field],
    has: (c) => [c.field],
    and: (c) => [...condFields(c.left), ...condFields(c.right)],
    or: (c) => [...condFields(c.left), ...condFields(c.right)],
  };
  return dispatchByType(table, cond);
}

const GUARD_FIELDS: DispatchTable<GuardStmt, ReqField[]> = {
  guard: (stmt) => condFields(stmt.cond),
  nestedGuard: (stmt) => [...condFields(stmt.outer), ...condFields(stmt.inner)],
  blockGuard: (stmt) => [...condFields(stmt.outer), ...condFields(stmt.inner)],
  loopGuard: (stmt) => stmt.keys.map((key) => ({ source: stmt.source, key })),
  switchGuard: (stmt) => [stmt.field],
};

const FINAL_FIELDS: DispatchTable<FinalStmt, ReqField[]> = {
  respond: () => [],
  ifElse: (stmt) => condFields(stmt.cond),
  ternary: (stmt) => condFields(stmt.cond),
};

/** Every distinct request field the program's conditions observe. */
export function collectFields(program: HandlerProgram): ReqField[] {
  const raw = [
    ...program.guards.flatMap((stmt) => dispatchByType(GUARD_FIELDS, stmt)),
    ...dispatchByType(FINAL_FIELDS, program.final),
  ];
  const seen = new Set<string>();
  const unique: ReqField[] = [];
  for (const field of raw) {
    const id = `${field.source}.${field.key}`;
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(field);
    }
  }
  return unique;
}

function condComparedValues(cond: Cond, field: ReqField): string[] {
  const table: DispatchTable<Cond, string[]> = {
    truthy: () => [],
    has: () => [],
    eq: (c) =>
      c.field.source === field.source && c.field.key === field.key
        ? [c.value]
        : [],
    and: (c) => [
      ...condComparedValues(c.left, field),
      ...condComparedValues(c.right, field),
    ],
    or: (c) => [
      ...condComparedValues(c.left, field),
      ...condComparedValues(c.right, field),
    ],
  };
  return dispatchByType(table, cond);
}

const GUARD_COMPARED: DispatchTable<GuardStmt, (field: ReqField) => string[]> =
  {
    guard: (stmt) => (field) => condComparedValues(stmt.cond, field),
    nestedGuard: (stmt) => (field) => [
      ...condComparedValues(stmt.outer, field),
      ...condComparedValues(stmt.inner, field),
    ],
    blockGuard: (stmt) => (field) => [
      ...condComparedValues(stmt.outer, field),
      ...condComparedValues(stmt.inner, field),
    ],
    loopGuard: () => () => [],
    switchGuard: (stmt) => (field) =>
      stmt.field.source === field.source && stmt.field.key === field.key
        ? stmt.clauses.map((clause) => clause.value)
        : [],
  };

const FINAL_COMPARED: DispatchTable<FinalStmt, (field: ReqField) => string[]> =
  {
    respond: () => () => [],
    ifElse: (stmt) => (field) => condComparedValues(stmt.cond, field),
    ternary: (stmt) => (field) => condComparedValues(stmt.cond, field),
  };

/**
 * The string literals a field is compared against anywhere in the
 * program: the request battery uses these as candidate values so
 * equality guards get exercised on both sides.
 */
export function collectComparedValues(
  program: HandlerProgram,
  field: ReqField,
): string[] {
  const values = [
    ...program.guards.flatMap((stmt) =>
      dispatchByType(GUARD_COMPARED, stmt)(field),
    ),
    ...dispatchByType(FINAL_COMPARED, program.final)(field),
  ];
  return [...new Set(values)];
}
