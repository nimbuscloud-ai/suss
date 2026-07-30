// program.ts — the generated-handler DSL and its renderer.
//
// A `HandlerProgram` is a tiny AST over the constructs suss claims to
// model for HTTP handlers: sequential early-return guards over request
// fields, a final response (plain / if-else / ternary), and — in the
// known-gap tiers — nested guards and loop guards. Rendering produces
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
  /** The response body is always `{ [key]: value }` — enough to tell terminals apart. */
  key: string;
  value: string;
}

/**
 * Statements that may appear before the final response.
 *
 * - `guard` is the sound construct: a top-level `if (c) { respond; return; }`.
 * - `nestedGuard` and `blockGuard` are the documented nested-guard gap
 *   shapes (guards one block deep).
 * - `loopGuard` is the documented loop-return gap shape.
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

/** The bare arrow function — what the vm harness executes. */
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
// Field collection — which request fields does this program observe?
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
  };

const FINAL_COMPARED: DispatchTable<FinalStmt, (field: ReqField) => string[]> =
  {
    respond: () => () => [],
    ifElse: (stmt) => (field) => condComparedValues(stmt.cond, field),
    ternary: (stmt) => (field) => condComparedValues(stmt.cond, field),
  };

/**
 * The string literals a field is compared against anywhere in the
 * program — the request battery uses these as candidate values so
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
