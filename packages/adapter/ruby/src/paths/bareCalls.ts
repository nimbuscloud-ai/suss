/**
 * Finds a Ruby method call written as a bare name, with no receiver and
 * no arguments.
 *
 * `visible_items` on its own parses as an identifier, the same node a
 * local variable read produces, so a reader that collects only `call`
 * nodes misses it. This module tells the two apart the way Ruby does: a
 * name the method binds is a local variable, and every other identifier
 * read is a call on self.
 *
 * Binding is over-approximated on purpose. A name assigned anywhere in
 * the method counts as a local, even after the read, so a mistake here
 * misses a call and never invents one.
 */

import { bodyStatements, field } from "../ast.js";

import type { RbNode } from "../parser.js";

const PARAMETER_LIST_TYPES = [
  "method_parameters",
  "block_parameters",
  "lambda_parameters",
  "parameters",
];

function isFieldOf(parent: RbNode, node: RbNode, name: string): boolean {
  return field(parent, name)?.id === node.id;
}

function namedAt(parent: RbNode, node: RbNode): boolean {
  return isFieldOf(parent, node, "name");
}

function always(): boolean {
  return true;
}

/**
 * For each parent node type, whether an identifier under it spells a
 * name instead of reading a value. Under a parent type missing from this
 * table, an identifier reads a value.
 */
const SPELLS_A_NAME: Record<string, (parent: RbNode, node: RbNode) => boolean> =
  {
    call: (parent, node) =>
      isFieldOf(parent, node, "method") || isFieldOf(parent, node, "receiver"),
    method: namedAt,
    singleton_method: namedAt,
    assignment: (parent, node) => isFieldOf(parent, node, "left"),
    operator_assignment: (parent, node) => isFieldOf(parent, node, "left"),
    for: (parent, node) => isFieldOf(parent, node, "pattern"),
    optional_parameter: namedAt,
    splat_parameter: namedAt,
    hash_splat_parameter: namedAt,
    keyword_parameter: namedAt,
    block_parameter: namedAt,
    destructured_parameter: always,
    left_assignment_list: always,
    rest_assignment: always,
    destructured_left_assignment: always,
    exception_variable: always,
    undef: always,
    alias: always,
    ...Object.fromEntries(PARAMETER_LIST_TYPES.map((type) => [type, always])),
  };

function addNamesUnder(node: RbNode | null, names: Set<string>): void {
  if (node === null) {
    return;
  }
  if (node.type === "identifier") {
    names.add(node.text);
    return;
  }
  for (const child of bodyStatements(node)) {
    addNamesUnder(child, names);
  }
}

function parameterNames(node: RbNode, names: Set<string>): void {
  for (const parameter of bodyStatements(node)) {
    if (parameter.type === "identifier") {
      names.add(parameter.text);
      continue;
    }
    const declared = field(parameter, "name");
    if (declared !== null && declared.type === "identifier") {
      names.add(declared.text);
      continue;
    }
    addNamesUnder(parameter, names);
  }
}

function assignedNames(node: RbNode, names: Set<string>): void {
  addNamesUnder(field(node, "left"), names);
}

/** The node types that bind a name, and where each one writes it. */
const BINDS_A_NAME: Record<string, (node: RbNode, names: Set<string>) => void> =
  {
    assignment: assignedNames,
    operator_assignment: assignedNames,
    for: (node, names) => addNamesUnder(field(node, "pattern"), names),
    exception_variable: (node, names) => addNamesUnder(node, names),
    ...Object.fromEntries(
      PARAMETER_LIST_TYPES.map((type) => [type, parameterNames]),
    ),
  };

const DESCENDS_EVERYWHERE: ReadonlySet<string> = new Set<string>();

/**
 * Every name a method binds as a local variable, its own parameters
 * included. The walk does not descend into the node types in `stops`, so
 * a name bound inside a class or a block does not hide a call written
 * outside it.
 */
export function localNamesIn(
  definitionNode: RbNode,
  stops: ReadonlySet<string> = DESCENDS_EVERYWHERE,
): Set<string> {
  const names = new Set<string>();
  const visit = (node: RbNode): void => {
    BINDS_A_NAME[node.type]?.(node, names);
    for (const child of bodyStatements(node)) {
      if (!stops.has(child.type)) {
        visit(child);
      }
    }
  };
  visit(definitionNode);
  return names;
}

/** Whether this identifier spells a name rather than reading a value. */
export function spellsAName(node: RbNode): boolean {
  const parent = node.parent;
  if (parent === null) {
    return true;
  }
  return SPELLS_A_NAME[parent.type]?.(parent, node) === true;
}

/** Ruby keywords that parse as an identifier but call no method, such as the `__FILE__` in `if __FILE__ == $0`. */
const KEYWORD_LITERALS = new Set(["__FILE__", "__LINE__", "__ENCODING__"]);

/** Whether this identifier is a bare call on self rather than a local variable read or a name being spelled. */
export function isBareMethodCall(
  node: RbNode,
  locals: ReadonlySet<string>,
): boolean {
  if (node.type !== "identifier" || locals.has(node.text)) {
    return false;
  }
  return !KEYWORD_LITERALS.has(node.text) && !spellsAName(node);
}
