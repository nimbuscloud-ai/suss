// field-accesses.ts — Collect property accesses on the API response variable
//
// After a consumer branches on status, it reads fields from the response body.
// This module traces those accesses and builds a TypeShape representing what
// the consumer expects the response to contain within each branch.

import { type CallExpression, type IfStatement, Node } from "ts-morph";

import type { TypeShape } from "@suss/behavioral-ir";
import type { ResponsePropertyMapping } from "@suss/extractor";

// ---------------------------------------------------------------------------
// Find the response accessor from the API call site
// ---------------------------------------------------------------------------

/**
 * How the consumer reaches the response from a call site.
 *
 * - `identifier`: classic `const res = await fetch(...)` form. Field accesses
 *   are walked as `res.x.y` chains.
 * - `destructured`: `const { data, status } = await axios.get(...)` form.
 *   `bindings` maps each local binding name back to the underlying response
 *   property it refers to (`{ data: "data", code: "status" }` for
 *   `{ data, status: code }`). Standalone uses of a local name resolve to
 *   the bound property; chained uses (`data.id`) extend that path.
 */
export type ResponseAccessor =
  | { kind: "identifier"; name: string }
  | { kind: "destructured"; bindings: Map<string, string> };

/**
 * Given a call expression like `fetch(url)` or `client.getUser(params)`,
 * find how the consumer captures the result. Returns null if the call
 * result isn't bound to anything we can trace.
 */
export function findResponseAccessor(
  callExpr: CallExpression,
): ResponseAccessor | null {
  // Walk up: CallExpression → (AwaitExpression →) VariableDeclaration
  let current: Node = callExpr;
  const parent1 = current.getParent();
  if (parent1 !== undefined && Node.isAwaitExpression(parent1)) {
    current = parent1;
  }
  const parent2 = current.getParent();
  if (parent2 === undefined || !Node.isVariableDeclaration(parent2)) {
    return null;
  }
  const nameNode = parent2.getNameNode();
  if (Node.isIdentifier(nameNode)) {
    return { kind: "identifier", name: nameNode.getText() };
  }
  if (Node.isObjectBindingPattern(nameNode)) {
    const bindings = new Map<string, string>();
    for (const element of nameNode.getElements()) {
      // Skip rest patterns — `...rest` isn't a known property on the response.
      if (element.getDotDotDotToken() !== undefined) {
        continue;
      }
      const localName = element.getName();
      // propertyNameNode is set for `{ status: code }` (renamed binding);
      // null for the shorthand `{ data }` form.
      const propertyNode = element.getPropertyNameNode();
      const sourceProperty =
        propertyNode !== undefined ? propertyNode.getText() : localName;
      bindings.set(localName, sourceProperty);
    }
    if (bindings.size === 0) {
      return null;
    }
    return { kind: "destructured", bindings };
  }
  return null;
}

/**
 * @deprecated Kept for compatibility — prefer `findResponseAccessor`.
 * Returns the simple identifier name when the consumer assigns the call to
 * one; null for destructured assignments and other shapes.
 */
export function findResponseVariable(callExpr: CallExpression): string | null {
  const accessor = findResponseAccessor(callExpr);
  return accessor?.kind === "identifier" ? accessor.name : null;
}

// ---------------------------------------------------------------------------
// Collect property access paths within a subtree
// ---------------------------------------------------------------------------

interface AccessPath {
  /** Property chain from the root variable, e.g. ["body", "name"] for res.body.name */
  chain: string[];
}

/**
 * Walk `subtree` and collect access paths the consumer reads from the
 * response, normalized to chains rooted at the response object.
 *
 * Identifier accessor: `result.body.name` → chain `["body", "name"]`.
 * Destructured accessor: given `const { data, status: code } = ...`,
 *   the consumer's `data.id` → `["data", "id"]`, bare `code` → `["status"]`.
 */
function collectPropertyAccesses(
  subtree: Node,
  accessor: ResponseAccessor,
): AccessPath[] {
  const paths: AccessPath[] = [];
  const seen = new Set<string>();

  function pushChain(chain: string[]) {
    const key = chain.join(".");
    if (!seen.has(key)) {
      seen.add(key);
      paths.push({ chain });
    }
  }

  if (accessor.kind === "identifier") {
    const varName = accessor.name;
    subtree.forEachDescendant((node) => {
      if (!Node.isPropertyAccessExpression(node)) {
        return;
      }
      const chain: string[] = [];
      let current: Node = node;
      while (Node.isPropertyAccessExpression(current)) {
        chain.unshift(current.getName());
        current = current.getExpression();
      }
      if (Node.isIdentifier(current) && current.getText() === varName) {
        pushChain(chain);
      }
    });
    return paths;
  }

  // Destructured accessor: walk every Identifier whose text matches a local
  // binding and convert to a chain in terms of the underlying property.
  const bindings = accessor.bindings;
  subtree.forEachDescendant((node) => {
    if (!Node.isIdentifier(node)) {
      return;
    }
    const localName = node.getText();
    const sourceProperty = bindings.get(localName);
    if (sourceProperty === undefined) {
      return;
    }
    // Skip the binding's own declaration site.
    if (isInsideObjectBindingPattern(node)) {
      return;
    }
    // Find the topmost property-access chain rooted on this identifier
    // (so for `data.id.name`, walk from the bare identifier up through both
    // property-accesses), then collect the segment names in source order.
    let chainTop: Node = node;
    let parent = chainTop.getParent();
    while (
      parent !== undefined &&
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === chainTop
    ) {
      chainTop = parent;
      parent = chainTop.getParent();
    }

    const segments: string[] = [];
    let current: Node = chainTop;
    while (Node.isPropertyAccessExpression(current)) {
      segments.push(current.getName());
      current = current.getExpression();
    }
    segments.reverse();
    pushChain([sourceProperty, ...segments]);
  });
  return paths;
}

function isInsideObjectBindingPattern(node: Node): boolean {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (Node.isObjectBindingPattern(current)) {
      return true;
    }
    if (
      Node.isFunctionLikeDeclaration(current) ||
      Node.isVariableStatement(current)
    ) {
      // We've walked past anything that could plausibly be the LHS of the
      // declaration we're skipping; keep going up only inside binding nodes.
      break;
    }
    current = current.getParent();
  }
  return false;
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
  const accessor = findResponseAccessor(callExpr);
  if (accessor === null) {
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
    const accesses = collectPropertyAccesses(subtree, accessor);

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
