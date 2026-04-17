// field-accesses.ts — Collect property accesses on the API response variable
//
// After a consumer branches on status, it reads fields from the response body.
// This module traces those accesses and builds a TypeShape representing what
// the consumer expects the response to contain within each branch.

import { type CallExpression, type IfStatement, Node } from "ts-morph";

import type { TypeShape } from "@suss/behavioral-ir";
import type { ResponsePropertyMapping } from "@suss/extractor";

// ---------------------------------------------------------------------------
// Find the response variable from the API call site
// ---------------------------------------------------------------------------

/**
 * Given a call expression like `fetch(url)` or `client.getUser(params)`,
 * find the variable it's assigned to: `const res = await fetch(...)` → "res".
 * Returns null if the call result isn't assigned to a simple identifier.
 */
export function findResponseVariable(callExpr: CallExpression): string | null {
  // Walk up: CallExpression → (AwaitExpression →) VariableDeclaration
  let current: Node = callExpr;
  const parent1 = current.getParent();
  if (parent1 !== undefined && Node.isAwaitExpression(parent1)) {
    current = parent1;
  }
  const parent2 = current.getParent();
  if (parent2 !== undefined && Node.isVariableDeclaration(parent2)) {
    const nameNode = parent2.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      return nameNode.getText();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Collect property access paths within a subtree
// ---------------------------------------------------------------------------

interface AccessPath {
  /** Property chain from the root variable, e.g. ["body", "name"] for res.body.name */
  chain: string[];
}

/**
 * Walk `subtree` and find all property access chains rooted at `varName`.
 * Returns deduplicated access paths.
 *
 * Example: if varName = "result" and the code reads `result.body.name` and
 * `result.body.email`, returns [["body", "name"], ["body", "email"]].
 */
function collectPropertyAccesses(subtree: Node, varName: string): AccessPath[] {
  const paths: AccessPath[] = [];
  const seen = new Set<string>();

  subtree.forEachDescendant((node) => {
    if (!Node.isPropertyAccessExpression(node)) {
      return;
    }

    // Build the full chain by walking left
    const chain: string[] = [];
    let current: Node = node;

    while (Node.isPropertyAccessExpression(current)) {
      chain.unshift(current.getName());
      current = current.getExpression();
    }

    // Check if the root is our response variable
    if (Node.isIdentifier(current) && current.getText() === varName) {
      const key = chain.join(".");
      if (!seen.has(key)) {
        seen.add(key);
        paths.push({ chain });
      }
    }
  });

  return paths;
}

// ---------------------------------------------------------------------------
// Build TypeShape from access paths
// ---------------------------------------------------------------------------

/**
 * Given a set of access paths, build a TypeShape representing the consumed
 * fields. Paths that share a prefix are merged into nested records.
 *
 * Example: [["body", "name"], ["body", "email"]] produces:
 * { type: "record", properties: { body: { type: "record", properties: {
 *   name: { type: "unknown" }, email: { type: "unknown" } } } } }
 *
 * Leaf types are `unknown` because we're recording *which* fields are accessed,
 * not what types the consumer expects them to be. The checker compares field
 * presence, not leaf types — a missing field is a definite mismatch, while
 * a present field with the wrong type is caught by the existing body-shape
 * matcher against the contract.
 */
function buildShapeFromPaths(paths: AccessPath[]): TypeShape | null {
  if (paths.length === 0) {
    return null;
  }

  // Group paths by first segment
  const groups = new Map<string, string[][]>();
  const leaves = new Set<string>();

  for (const { chain } of paths) {
    if (chain.length === 0) {
      continue;
    }
    const [head, ...tail] = chain;
    if (tail.length === 0) {
      leaves.add(head);
    } else {
      if (!groups.has(head)) {
        groups.set(head, []);
      }
      groups.get(head)?.push(tail);
    }
  }

  const properties: Record<string, TypeShape> = {};

  // Leaves: accessed but not descended into further
  for (const leaf of leaves) {
    if (!groups.has(leaf)) {
      properties[leaf] = { type: "unknown" };
    }
    // If it's also a group, the nested shape takes priority (below)
  }

  // Groups: descended into
  for (const [key, tails] of groups) {
    const nested = buildShapeFromPaths(tails.map((t) => ({ chain: t })));
    properties[key] = nested ?? { type: "unknown" };
  }

  if (Object.keys(properties).length === 0) {
    return null;
  }

  return { type: "record", properties };
}

// ---------------------------------------------------------------------------
// Per-branch field access extraction
// ---------------------------------------------------------------------------

/**
 * Find the AST subtree for a given branch by matching the terminal's source
 * location back to the AST. Returns the nearest containing if-branch or
 * the function body for default transitions.
 */
function findBranchSubtree(
  func: Node,
  terminalStartLine: number,
  terminalEndLine: number,
): Node {
  // Walk down to find the terminal node by line range
  let terminalNode: Node | null = null;
  func.forEachDescendant((node) => {
    const start = node.getStartLineNumber();
    const end = node.getEndLineNumber();
    if (start === terminalStartLine && end === terminalEndLine) {
      terminalNode = node;
    }
  });

  if (terminalNode === null) {
    return func;
  }

  // Walk up from the terminal to find the nearest if-then/else block
  let current: Node = terminalNode;
  while (current !== func) {
    const parent = current.getParent();
    if (parent === undefined) {
      break;
    }

    if (Node.isIfStatement(parent)) {
      const ifStmt = parent as IfStatement;
      const thenBlock = ifStmt.getThenStatement();
      const elseBlock = ifStmt.getElseStatement();

      if (thenBlock !== undefined && isDescendantOf(terminalNode, thenBlock)) {
        return thenBlock;
      }
      if (elseBlock !== undefined && isDescendantOf(terminalNode, elseBlock)) {
        return elseBlock;
      }
    }

    current = parent;
  }

  // Default: use the whole function body
  return func;
}

function isDescendantOf(node: Node, ancestor: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface BranchFieldAccesses {
  /** Terminal location (start, end lines) — used to match back to transitions */
  terminalLocation: { start: number; end: number };
  /** The shape of fields the consumer reads from the response in this branch */
  expectedInput: TypeShape | null;
}

/**
 * For a client function, collect the fields accessed on the response variable
 * within each branch. Returns one entry per branch (matched by terminal location).
 *
 * @param callExpr The API call expression (fetch(), client.getUser())
 * @param func The enclosing function
 * @param branchLocations Terminal locations from the extracted branches
 * @param responseSemantics Optional response property mappings from the pack —
 *   used to filter non-body properties instead of a hardcoded list
 */
export function collectClientFieldAccesses(
  callExpr: CallExpression,
  func: Node,
  branchLocations: Array<{ start: number; end: number }>,
  responseSemantics?: ResponsePropertyMapping[],
): BranchFieldAccesses[] {
  const responseVar = findResponseVariable(callExpr);
  if (responseVar === null) {
    return branchLocations.map((loc) => ({
      terminalLocation: loc,
      expectedInput: null,
    }));
  }

  // Build the set of non-body property names from pack semantics.
  // Any property with statusCode, statusRange, or headers semantics
  // is filtered out; body-typed and unknown properties pass through.
  const nonBodyProps = buildNonBodyPropertySet(responseSemantics);

  return branchLocations.map((loc) => {
    const subtree = findBranchSubtree(func, loc.start, loc.end);
    const accesses = collectPropertyAccesses(subtree, responseVar);

    const bodyAccesses = accesses.filter(
      (a) => a.chain.length > 0 && !nonBodyProps.has(a.chain[0]),
    );

    const expectedInput = buildShapeFromPaths(bodyAccesses);
    return { terminalLocation: loc, expectedInput };
  });
}

function buildNonBodyPropertySet(
  semantics?: ResponsePropertyMapping[],
): Set<string> {
  if (semantics === undefined) {
    // Fallback: hardcoded list for packs without response semantics
    return new Set(["status", "statusCode", "ok", "headers"]);
  }
  const nonBody = new Set<string>();
  for (const mapping of semantics) {
    if (mapping.semantics.type !== "body") {
      nonBody.add(mapping.name);
    }
  }
  return nonBody;
}
