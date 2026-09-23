import { IdMap, IdSet, SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

/**
 * Small helpers for reading a tree-sitter-ruby parse tree.
 *
 * The node type strings come from tree-sitter-ruby's grammar, at the
 * version the grammar README gives. Read nodes through these helpers
 * instead of calling `childForFieldName` or `.type` inline, so a grammar
 * upgrade that renames a field is fixed in one place.
 */

import type { RbNode } from "./parser.js";

export interface Range {
  start: number;
  end: number;
}

/** A node's lines, counting from one, since `location.range` is in lines throughout the IR. */
export function rangeOf(node: RbNode): Range {
  return {
    start: node.startPosition.row + 1,
    end: node.endPosition.row + 1,
  };
}

/** A node's byte offsets, which node keys are built from. */
export function spanOf(node: RbNode): Range {
  return { start: node.startIndex, end: node.endIndex };
}

export function field(node: RbNode, name: string): RbNode | null {
  return node.childForFieldName(name);
}

export function isType(node: RbNode, ...types: string[]): boolean {
  return types.includes(node.type);
}

export function bodyStatements(body: RbNode): RbNode[] {
  return body.namedChildren.filter((child): child is RbNode => child !== null);
}

/** The fields of a branching statement that run when the branch is taken; the condition is left out. */
const BRANCH_FIELDS: Record<string, string[]> = {
  if: ["consequence", "alternative"],
  unless: ["consequence", "alternative"],
  elsif: ["consequence", "alternative"],
  if_modifier: ["body"],
  unless_modifier: ["body"],
  while: ["body"],
  until: ["body"],
  while_modifier: ["body"],
  until_modifier: ["body"],
  when: ["body"],
  rescue: ["body"],
};

/** Nodes whose named children are statements that run in order, except for any clause among them. */
const STATEMENT_LISTS = new Set(["then", "else", "do", "ensure", "begin"]);

/** Clauses belong to the statement around them, so the walk opens them up. */
const CLAUSE_TYPES = new Set(["elsif", "else", "when", "rescue", "ensure"]);

/**
 * Every statement written directly inside a branching statement's
 * branches, across its `elsif`, `else`, `when`, `rescue` and `ensure`
 * clauses. A statement inside a nested branching statement is not
 * included; the caller descends into that one itself.
 */
export function nestedStatements(stmt: RbNode): RbNode[] {
  const branchFields = BRANCH_FIELDS[stmt.type];
  if (branchFields !== undefined) {
    return branchFields.flatMap((name) => {
      const branch = field(stmt, name);
      return branch === null ? [] : statementsRunBy(branch);
    });
  }

  if (STATEMENT_LISTS.has(stmt.type)) {
    return bodyStatements(stmt).flatMap((child) =>
      CLAUSE_TYPES.has(child.type) ? nestedStatements(child) : [child],
    );
  }

  if (stmt.type === "case") {
    return bodyStatements(stmt)
      .filter((child) => CLAUSE_TYPES.has(child.type))
      .flatMap(nestedStatements);
  }
  return [];
}

/** A branch is a statement list, a clause, or, after a modifier such as `x if y`, one statement. */
function statementsRunBy(branch: RbNode): RbNode[] {
  if (STATEMENT_LISTS.has(branch.type) || CLAUSE_TYPES.has(branch.type)) {
    return nestedStatements(branch);
  }
  return [branch];
}

/**
 * The body of one of these belongs to the definition, so its statements
 * do not run when the enclosing body runs.
 */
export const OWN_BODY_TYPES = new Set([
  "method",
  "singleton_method",
  "lambda",
  "class",
  "module",
  "singleton_class",
]);

/** The parse tree's root. Its own statements run when the file loads. */
export const PROGRAM_TYPE = "program";

/**
 * The node types a read of a file's load-time statements does not
 * descend into. Blocks are included with the definitions because the
 * call a block is passed to decides whether it runs. Otherwise a Rake
 * task body would count as work the file does when it is required.
 */
export const MODULE_SCOPE_STOPS = new Set([
  ...OWN_BODY_TYPES,
  "block",
  "do_block",
]);

/** Classes and modules, whose bodies can contain definitions. */
export const NESTING_TYPES = new Set(["class", "module"]);

/** The two ways Ruby writes a method, `def x` and `def self.x`. */
export const METHOD_TYPES = new Set(["method", "singleton_method"]);

/** `->(x) { ... }`, a function that can be assigned to a name and called later. */
export const LAMBDA_TYPE = "lambda";

/**
 * The nearest method or lambda a node is written inside, or null outside
 * both. Parameter reads are keyed under it, so this has to stop where the
 * fact emitter stops.
 */
export function enclosingDefinition(node: RbNode): RbNode | null {
  let current = node.parent;
  while (current !== null) {
    if (METHOD_TYPES.has(current.type) || current.type === LAMBDA_TYPE) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * The calls that mix a module into a class's instance methods. `extend`
 * is left out because it adds class methods, and a field resolves through
 * an instance method. The ancestry walk and the facts both read these two
 * calls, so they agree on which constant is mixed in.
 */
export const INCLUDE_CALL = "include";
export const PREPEND_CALL = "prepend";

/** A call's arguments are values passed in, so the statement walk skips them. */
const ARGUMENT_LIST_TYPE = "argument_list";

/** The two ways to write a block, `{ }` and `do ... end`. */
const BLOCK_TYPES = new Set(["block", "do_block"]);

/** A pack's declaration of one body-block call, with its optional flags defaulted. */
export interface BodyBlockKind {
  /** Whether the library offers the call only to modules. In a class, a call of the same name is something else. */
  readonly moduleOnly: boolean;
  /** Whether a `def` in the block defines a method on the class itself instead of on an instance. */
  readonly definesClassMethods: boolean;
}

/**
 * The calls whose block runs as part of the surrounding class or module
 * body, keyed by the call's name as a project writes it. Ruby has no such
 * call of its own, so this is empty unless a pack declares one.
 */
export type BodyBlocks = ReadonlyMap<string, BodyBlockKind>;

/** The body blocks for a reader that was given no packs. */
export const NO_BODY_BLOCKS: BodyBlocks = new Map();

/** Whether the class or module a body belongs to is a module. */
export function isModuleBody(body: RbNode): boolean {
  return body.parent?.type === "module";
}

/** The pack's declaration for this statement when it is a declared body-block call with a block, or null otherwise. */
function declaredBlockAt(
  statement: RbNode,
  isModule: boolean,
  blocks: BodyBlocks,
): BodyBlockKind | null {
  if (statement.type !== "call" || field(statement, "receiver") !== null) {
    return null;
  }
  const method = field(statement, "method");
  const kind = method === null ? undefined : blocks.get(method.text);
  if (kind === undefined || (kind.moduleOnly && !isModule)) {
    return null;
  }
  return field(statement, "block") === null ? null : kind;
}

/**
 * The statements a class or module body runs, with the statements of
 * every declared body block read in place of the call. Otherwise a method
 * or value that a concern declares inside such a block would belong to
 * the block, and nothing could read it off the module.
 */
export function bodyStatementsRun(
  body: RbNode,
  isModule: boolean,
  blocks: BodyBlocks,
): RbNode[] {
  return bodyStatements(body).flatMap((statement) => {
    if (declaredBlockAt(statement, isModule, blocks) === null) {
      return [statement];
    }
    const block = field(statement, "block");
    const inner = block === null ? null : field(block, "body");
    return inner === null ? [] : bodyStatementsRun(inner, isModule, blocks);
  });
}

/**
 * Whether a definition inside `body` defines a class method, because it
 * is inside a declared body block that defines class methods.
 */
export function definedAtClassLevel(
  node: RbNode,
  body: RbNode,
  blocks: BodyBlocks,
): boolean {
  if (blocks.size === 0) {
    return false;
  }
  const isModule = isModuleBody(body);
  let current = node.parent;
  while (current !== null && current.id !== body.id) {
    const parent: RbNode | null = current.parent;
    if (BLOCK_TYPES.has(current.type) && parent !== null) {
      if (declaredBlockAt(parent, isModule, blocks)?.definesClassMethods) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

/** Whether a call's block configures the call itself, so its statements are not part of the body. */
export type BlockConfigures = (call: RbNode) => boolean;

/**
 * Every statement a body runs, in source order. Ruby runs a class body
 * like any other code, so a declaration can be inside an `if`, an `.each`
 * block, a `begin` or a `class_eval`. Reading only the body's direct
 * children would miss those without any sign.
 *
 * `blockConfigures` picks out the calls whose block is not part of the
 * body. `field :x, String do argument :q, String end` declares an
 * argument on the field, so that block is skipped.
 */
export function runStatements(
  body: RbNode,
  blockConfigures: BlockConfigures = () => false,
): RbNode[] {
  const found: RbNode[] = [];
  const readsItsChildren = (node: RbNode): boolean => {
    if (OWN_BODY_TYPES.has(node.type) || node.type === ARGUMENT_LIST_TYPE) {
      return false;
    }
    return !(node.type === "call" && blockConfigures(node));
  };
  walkDescendants<RbNode, null>(body, null, {
    at: (node) => {
      found.push(node);
    },
    into: (node) => (readsItsChildren(node) ? null : SKIP_CHILDREN),
  });
  return found;
}

/** The text inside a plain string node, with the quotes removed. A string with interpolation returns null. */
export function stringLiteralValue(node: RbNode): string | null {
  if (node.type !== "string") {
    return null;
  }
  let content = "";
  for (const child of bodyStatements(node)) {
    if (child.type === "string_content") {
      content += child.text;
      continue;
    }
    if (child.type === "interpolation") {
      return null;
    }
  }
  return content;
}

/** A `simple_symbol`'s name without its leading colon, or null for any other node. */
export function symbolValue(node: RbNode): string | null {
  return node.type === "simple_symbol" ? node.text.slice(1) : null;
}

/**
 * Every instance method a class body defines, keyed by name. A name
 * defined twice keeps the later definition, as Ruby does.
 *
 * Class methods are left out, since a field resolves through an instance
 * method. That covers `def self.name`, which parses as a
 * `singleton_method`, and a `def` inside a body block the pack declares
 * as defining class methods.
 */
export function instanceMethodsByName(
  body: RbNode,
  blocks: BodyBlocks = NO_BODY_BLOCKS,
): Map<string, RbNode> {
  const methods = new Map<string, RbNode>();
  for (const stmt of runStatements(body)) {
    if (stmt.type !== "method" || definedAtClassLevel(stmt, body, blocks)) {
      continue;
    }
    const name = field(stmt, "name")?.text;
    if (name !== undefined) {
      methods.set(name, stmt);
    }
  }
  return methods;
}

export type MethodVisibility = "public" | "private" | "protected";

const VISIBILITY_KEYWORDS: ReadonlySet<string> = new Set([
  "private",
  "protected",
  "public",
]);

function visibilityKeyword(text: string): MethodVisibility | null {
  return VISIBILITY_KEYWORDS.has(text) ? (text as MethodVisibility) : null;
}

/** Public is recorded by removing the entry, so the result stays sparse and an explicit `public` clears an earlier `private`. */
function setVisibility(
  visibility: Map<string, MethodVisibility>,
  name: string,
  keyword: MethodVisibility,
): void {
  if (keyword === "public") {
    visibility.delete(name);
    return;
  }
  visibility.set(name, keyword);
}

/** Sets the visibility of each method passed to `private`, `protected` or `public`, as in `private def name; end` or `private :a, :b`. */
function markCalledOutMethods(
  call: RbNode,
  keyword: MethodVisibility,
  visibility: Map<string, MethodVisibility>,
): void {
  const argumentList = field(call, "arguments");
  if (argumentList === null) {
    return;
  }
  for (const arg of bodyStatements(argumentList)) {
    const name =
      arg.type === "method" ? field(arg, "name")?.text : symbolValue(arg);
    if (name !== undefined && name !== null) {
      setVisibility(visibility, name, keyword);
    }
  }
}

/**
 * The visibility of every instance method a class body defines directly,
 * keyed by name. The body is read top to bottom. A bare `private`,
 * `protected` or `public` applies to every later `def`. The call form,
 * `private def name; end`, marks that one definition, and
 * `private :a, :b` marks methods already defined. A method missing from
 * the result is public.
 */
export function instanceMethodVisibility(
  body: RbNode,
): Map<string, MethodVisibility> {
  const visibility = new Map<string, MethodVisibility>();
  let mode: MethodVisibility = "public";
  for (const stmt of bodyStatements(body)) {
    if (stmt.type === "method") {
      const name = field(stmt, "name")?.text;
      if (name !== undefined) {
        setVisibility(visibility, name, mode);
      }
      continue;
    }
    if (stmt.type === "identifier") {
      mode = visibilityKeyword(stmt.text) ?? mode;
      continue;
    }
    if (stmt.type !== "call" || field(stmt, "receiver") !== null) {
      continue;
    }
    const keyword = visibilityKeyword(field(stmt, "method")?.text ?? "");
    if (keyword !== null) {
      markCalledOutMethods(stmt, keyword, visibility);
    }
  }
  return visibility;
}

/**
 * Every class method a class body defines, keyed by name: each
 * `def self.name`, and each `def` inside a body block the pack declares
 * as defining class methods. A call on the constant itself, such as
 * `OrderService.call`, is looked up here, since it runs on the class.
 */
export function singletonMethodsByName(
  body: RbNode,
  blocks: BodyBlocks = NO_BODY_BLOCKS,
): Map<string, RbNode> {
  const methods = new Map<string, RbNode>();
  for (const stmt of runStatements(body)) {
    const classLevel =
      stmt.type === "method" && definedAtClassLevel(stmt, body, blocks);
    if (stmt.type !== "singleton_method" && !classLevel) {
      continue;
    }
    const name = field(stmt, "name")?.text;
    if (name !== undefined) {
      methods.set(name, stmt);
    }
  }
  return methods;
}

/** Each receiverless call to `name` the body runs, in source order. */
export function bareCalls(body: RbNode, name: string): RbNode[] {
  return runStatements(body).filter(
    (stmt) =>
      stmt.type === "call" &&
      field(stmt, "receiver") === null &&
      field(stmt, "method")?.text === name,
  );
}

/**
 * The arguments of each receiverless call to `name` the body runs, one
 * group per call, in source order. They stay grouped because
 * `include A, B` orders its modules differently from `include A`
 * followed by `include B`.
 */
export function bareCallArgumentGroups(body: RbNode, name: string): RbNode[][] {
  return bareCalls(body, name).map((call) => {
    const args = field(call, "arguments");
    return args === null ? [] : bodyStatements(args);
  });
}

/**
 * Whether a method has any statements. `def name; end` has no `body`
 * field. An endless `def name = expr` has the expression itself as its
 * body, which counts.
 */
export function methodHasStatements(method: RbNode): boolean {
  const body = field(method, "body");
  if (body === null) {
    return false;
  }
  if (body.type !== "body_statement") {
    return true;
  }
  return bodyStatements(body).length > 0;
}

/** A `pair` key's name when it is written as `key:`, or null for a key written as a string or an expression. */
export function hashKeySymbolName(node: RbNode): string | null {
  return node.type === "hash_key_symbol" ? node.text : null;
}

export function booleanLiteralValue(node: RbNode): boolean | null {
  if (node.type === "true") {
    return true;
  }
  if (node.type === "false") {
    return false;
  }
  return null;
}

/**
 * A call's arguments, split into positional and keyword. tree-sitter puts
 * keyword arguments in the argument list as `pair` nodes, with no hash
 * node around them. Only keys written as `key:` are read.
 */
export interface CallArgs {
  positional: RbNode[];
  keyword: Record<string, RbNode>;
}

export function readCallArgs(argumentList: RbNode | null): CallArgs {
  const positional: RbNode[] = [];
  const keyword: Record<string, RbNode> = {};
  if (argumentList === null) {
    return { positional, keyword };
  }
  for (const child of bodyStatements(argumentList)) {
    if (child.type === "pair") {
      const keyNode = field(child, "key");
      const valueNode = field(child, "value");
      const name = keyNode !== null ? hashKeySymbolName(keyNode) : null;
      if (name !== null && valueNode !== null) {
        keyword[name] = valueNode;
      }
      continue;
    }
    positional.push(child);
  }
  return { positional, keyword };
}

/**
 * A set of nodes keyed on node id. tree-sitter returns a new wrapper
 * object each time a child is read, so two reads of one node are never
 * `===`, and a plain Set would miss the match.
 */
export class NodeSet extends IdSet<RbNode> {}

/** A map keyed on node id, for the same reason as `NodeSet`. */
export class NodeMap<V> extends IdMap<RbNode, V> {}
