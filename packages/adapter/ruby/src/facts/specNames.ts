/**
 * Names a test file defines by group rather than by method. An RSpec
 * `let(:order)` defines `order` for every example in its group and the
 * groups inside it, and a sibling group can define its own `order`. Ruby
 * has no scope for that, so without this every read of `order` in the
 * file would be one name with several values.
 *
 * A test pack's reader registers, for each parsed test file, which group
 * a name read at a node belongs to. The value facts key a bare name on
 * that group, and the facts the reader emits for the group bind the name
 * there. A file nothing registers keys its names as before.
 */

import type { RbNode } from "../parser.js";

export interface GroupNames {
  /** The group node a name read at `node` belongs to, or null when no group defines it. */
  owner(node: RbNode, name: string): RbNode | null;
  /**
   * The class a bare name at `node` gives back, as `described_class`
   * gives back the class its group was given, or null. The name reads as
   * that class, so a call on it runs a class method.
   */
  classRead(node: RbNode): RbNode | null;
}

const namesByTree = new WeakMap<object, GroupNames>();

/**
 * Sets how the names in this file's tree are owned, or clears it with
 * null. A parse kept from an earlier run keeps its tree, so every run
 * sets or clears it for every file it reads.
 */
export function registerGroupNames(
  root: RbNode,
  names: GroupNames | null,
): void {
  if (names === null) {
    namesByTree.delete(root.tree);
    return;
  }
  namesByTree.set(root.tree, names);
}

export function groupNameOwner(node: RbNode, name: string): RbNode | null {
  return namesByTree.get(node.tree)?.owner(node, name) ?? null;
}

export function groupClassRead(node: RbNode): RbNode | null {
  return namesByTree.get(node.tree)?.classRead(node) ?? null;
}
