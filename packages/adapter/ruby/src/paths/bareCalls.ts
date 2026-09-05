/**
 * A Ruby method call written as a bare name, with no receiver and no
 * arguments.
 *
 * `visible_items` on its own parses as an identifier, the same node a
 * local variable read parses as, so a reader that collects only `call`
 * nodes misses the call. Ruby tells the two apart the same way this
 * does: a name the method binds is a local variable, and every other
 * identifier read is a call on self.
 *
 * Binding is over-approximated on purpose. A name assigned anywhere in
 * the method counts as a local, even below the read, so the mistake
 * this can make is missing a call rather than inventing one.
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
 * Where an identifier spells a name rather than reading a value, by the
 * node it is written under. A parent absent from here reads its
 * identifier children as values.
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

/** Every name a method binds as a local variable, its own parameters included. */
export function localNamesIn(definitionNode: RbNode): Set<string> {
  const names = new Set<string>();
  const visit = (node: RbNode): void => {
    BINDS_A_NAME[node.type]?.(node, names);
    for (const child of bodyStatements(node)) {
      visit(child);
    }
  };
  visit(definitionNode);
  return names;
}

/** Whether this identifier is a bare call on self rather than a local variable read or a name being spelled. */
export function isBareMethodCall(
  node: RbNode,
  locals: ReadonlySet<string>,
): boolean {
  if (node.type !== "identifier" || locals.has(node.text)) {
    return false;
  }
  const parent = node.parent;
  if (parent === null) {
    return false;
  }
  return SPELLS_A_NAME[parent.type]?.(parent, node) !== true;
}
