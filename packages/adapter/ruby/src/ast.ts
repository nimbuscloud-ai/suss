import { IdMap, IdSet, SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

/**
 * Small helpers for reading a tree-sitter-ruby parse tree.
 *
 * The node-type strings here come from tree-sitter-ruby's grammar, at the
 * version the grammar README gives. Read a node through these helpers rather
 * than calling `childForFieldName` or `.type` inline, so that a grammar upgrade
 * that renames a field only has to be fixed in one place.
 */

import type { RbNode } from "./parser.js";

export interface Range {
  start: number;
  end: number;
}

/** Lines, counting from one, because a summary's `location.range` is lines everywhere else in the IR. */
export function rangeOf(node: RbNode): Range {
  return {
    start: node.startPosition.row + 1,
    end: node.endPosition.row + 1,
  };
}

/** Byte offsets, which identity measures with; lines above are for reading. */
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

/** A node whose named children are statements run in place, apart from a clause among them. */
const STATEMENT_LISTS = new Set(["then", "else", "do", "ensure", "begin"]);

/** A clause is part of the statement around it, not a statement of its own. */
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

/** A branch is a statement list, a clause, or, after a modifier, one statement. */
function statementsRunBy(branch: RbNode): RbNode[] {
  if (STATEMENT_LISTS.has(branch.type) || CLAUSE_TYPES.has(branch.type)) {
    return nestedStatements(branch);
  }
  return [branch];
}

/**
 * A body written in one of these belongs to the thing it declares, so
 * its statements do not run when the enclosing body runs.
 */
export const OWN_BODY_TYPES = new Set([
  "method",
  "singleton_method",
  "lambda",
  "class",
  "module",
  "singleton_class",
]);

/** A class and a module both open a body a definition can be written inside. */
export const NESTING_TYPES = new Set(["class", "module"]);

/**
 * Ruby's own module keywords. `extend` is not one: it adds class
 * methods, and a field is answered by an instance method. The syntactic
 * ancestry and the facts read the same two calls, so both sides agree on
 * which constant is mixed in.
 */
export const INCLUDE_CALL = "include";
export const PREPEND_CALL = "prepend";

/** A call's arguments are values it is handed, not statements the body runs. */
const ARGUMENT_LIST_TYPE = "argument_list";

/** The two spellings of a block, `{ }` and `do ... end`. */
const BLOCK_TYPES = new Set(["block", "do_block"]);

/** What a pack says about one call whose block runs as part of the body around it, with the fields it left out settled. */
export interface BodyBlockKind {
  /** Whether the library only gives the call to a module, so a class writing the same name means something else. */
  readonly moduleOnly: boolean;
  /** Whether a `def` in the block declares a method on the class itself rather than on an instance. */
  readonly definesClassMethods: boolean;
}

/**
 * The calls a run's packs say run their block as part of the class or
 * module body it is written in, by the name a project writes. Ruby
 * defines no such call, so this is empty until a pack declares one.
 */
export type BodyBlocks = ReadonlyMap<string, BodyBlockKind>;

/** What a reader that was given no packs works from. */
export const NO_BODY_BLOCKS: BodyBlocks = new Map();

/** Whether the class or module a body belongs to is a module. */
export function isModuleBody(body: RbNode): boolean {
  return body.parent?.type === "module";
}

/** What a pack declared about the block this statement opens on the body around it, or null when the statement opens no such block. */
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
 * The statements a class or module body runs, with every block a pack
 * declared opened out where it is written. Without that, a method or a
 * value a concern declares inside such a block belongs to the block and
 * nothing can read it off the module.
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
 * Whether a definition written somewhere inside `body` runs on the
 * class rather than on an instance, because a declared block that
 * defines class methods encloses it.
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

/** A call whose block is the thing being configured rather than a place statements run. */
export type BlockConfigures = (call: RbNode) => boolean;

/**
 * Every statement a body runs, in source order. Ruby runs a class body
 * like any other code, so a declaration can sit inside an `if`, a
 * `.each` block, a `begin` or a `class_eval`, and taking the body's own
 * child list finds the first spelling and loses the rest in silence.
 *
 * `blockConfigures` says which calls keep their block to themselves.
 * `field :x, String do argument :q, String end` declares an argument on
 * the field, not on the class, so that block is not part of the body.
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

/** tree-sitter-ruby leaves the leading colon in a `simple_symbol`'s text, but not in a `hash_key_symbol`'s. */
export function symbolValue(node: RbNode): string | null {
  return node.type === "simple_symbol" ? node.text.slice(1) : null;
}

/**
 * Every instance method a class body defines, keyed by the name it is
 * defined under. A name defined twice keeps the later definition, the
 * way Ruby's own redefinition does.
 *
 * `def self.name` parses as a `singleton_method` and is deliberately
 * not one of these: it runs on the class, and what resolves a field is
 * an instance method, and so is a `def` inside a block a pack declared
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

/** A public entry is left out rather than written, so the result stays sparse and an explicit `public` can still clear an earlier narrowing. */
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

/** Each name a `private`/`protected`/`public` call marks, `private def name; end` or `private :a, :b`. */
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
 * The Ruby visibility of every instance method a class body defines
 * directly, keyed by name. A body runs top to bottom: a bare
 * `private`/`protected`/`public` changes what every later `def` gets,
 * `private def name; end` marks that one definition without changing
 * what follows, and `private :a, :b` marks methods already defined.
 * A method absent from the result is public: nothing in the body
 * narrowed it.
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
 * Every `def self.name` a class body writes directly, keyed by the name
 * it is defined under. Used for a call written straight on the
 * constant, `OrderService.call` say, which runs on the class rather
 * than an instance and so is never in `instanceMethodsByName`. A `def`
 * inside a block a pack declared as defining class methods is one too.
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
 * group per call, in source order. Grouped rather than flattened
 * because `include A, B` and `include A` then `include B` order their
 * modules differently.
 */
export function bareCallArgumentGroups(body: RbNode, name: string): RbNode[][] {
  return bareCalls(body, name).map((call) => {
    const args = field(call, "arguments");
    return args === null ? [] : bodyStatements(args);
  });
}

/**
 * Whether a method has work in it. `def name; end` has no `body` field
 * at all; an endless `def name = expr` has the expression itself there
 * rather than a `body_statement`, and that is work.
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

/** A `pair` node's key, when it is written as the bare `key:` shorthand. Null for a pair keyed by a string or an expression. */
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

/** Keyword arguments turn up as `pair` nodes directly among the argument list's children, rather than wrapped in a hash node. */
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
 * tree-sitter hands back a fresh wrapper object every time a child is read,
 * so two reads of one node are never `===`. These key on the node id, and
 * `checkStyle` fails a build that keys a plain Set or Map on a node.
 */
/** A set of nodes, compared the way tree-sitter compares them. */
export class NodeSet extends IdSet<RbNode> {}

/** A map keyed by node, compared the way tree-sitter compares them. */
export class NodeMap<V> extends IdMap<RbNode, V> {}
