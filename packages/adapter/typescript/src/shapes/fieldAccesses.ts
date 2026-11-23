// fieldAccesses.ts: the response fields a client reads on each branch,
// with each value's place in the response asked of the resolution store.
// The README beside this file says which reads count.

import { type CallExpression, Node } from "ts-morph";

import {
  decidesResponse,
  placesInResponse,
  readShapeOf,
  readsOn,
} from "@suss/extractor";

import { factKeyOf, nodeId } from "../facts/extract.js";
import {
  callbackReturnExpression,
  thenLikeCall,
  thenParameterLink,
} from "../promiseThen.js";
import { siteOf } from "../resolve/invocationEffects.js";
import { isDescentStop } from "../walk/descent.js";
import { peelValue } from "../walk/unwrap.js";

import type { StatusMembers, TypeShape } from "@suss/behavioral-ir";
import type {
  BranchEnding,
  EffectSite,
  ReadHop,
  ReadStop,
  ResponsePropertyMapping,
  ResponseReading,
} from "@suss/extractor";
import type { ParameterDeclaration } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

// ---------------------------------------------------------------------------
// Find the response binding at the call site
// ---------------------------------------------------------------------------

/**
 * How the consumer binds the response at the call site.
 *
 * - `identifier`: `const res = await fetch(...)`.
 * - `destructured`: `const { data, status: code } = await axios.get(...)`.
 *   `bindings` maps each local name to the response property it reads.
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
      // Skip rest patterns: `...rest` isn't a known property on the response.
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
 * @deprecated Kept for compatibility: prefer `findResponseAccessor`.
 * Returns the simple identifier name when the consumer assigns the call to
 * one; null for destructured assignments and other shapes.
 */
export function findResponseVariable(callExpr: CallExpression): string | null {
  const accessor = findResponseAccessor(callExpr);
  return accessor?.kind === "identifier" ? accessor.name : null;
}

// ---------------------------------------------------------------------------
// Where a value is in the response
// ---------------------------------------------------------------------------

/**
 * How the store's walk is read for one response. `isResponse` says which
 * node is the response: the request call, or the parameter a helper was
 * handed it in. A call of one of the pack's body methods is the body of
 * the value it is called on, and a `.then` callback's parameter is what
 * the promise it is chained on resolves to.
 */
function responseReading(
  isResponse: (node: Node) => boolean,
  bodyMethods: ReadonlySet<string>,
  resolution: ResolutionStore,
): ResponseReading<Node> {
  return {
    idOf: (node) => nodeId(factKeyOf(node)),
    stopsOf: (values, endsAt) => {
      const found = resolution.sourcesOf(values, "wantedInputRead", endsAt);
      const stops = new Map<string, ReadStop<Node>[]>();
      for (const value of values) {
        stops.set(
          nodeId(factKeyOf(value)),
          (found.get(value) ?? []).map(({ leaf, node }) => ({
            // A key computed on the way is missing from the path, so the
            // place the path gives would be wrong.
            node: leaf.computedAt === null ? node : null,
            path: leaf.path,
            written: leaf.end.is === "written",
          })),
        );
      }
      return stops;
    },
    isRequest: (node) => isResponse(peeledNode(node)),
    hopOf: (node) => hopOf(peeledNode(node), bodyMethods),
    writtenAfter: (stop, read) =>
      stop.getSourceFile() === read.getSourceFile() &&
      stop.getStart() > read.getEnd(),
  };
}

function peeledNode(node: Node): Node {
  return Node.isExpression(node) ? peelValue(node) : node;
}

function hopOf(
  node: Node,
  bodyMethods: ReadonlySet<string>,
): ReadHop<Node> | null {
  if (Node.isCallExpression(node)) {
    return callHop(node, bodyMethods);
  }
  const parameter = parameterDeclarationOf(node);
  if (parameter === null) {
    return null;
  }
  const link = thenParameterLink(parameter);
  return link === null || link.method === "catch"
    ? null
    : { from: link.upstream, segments: [] };
}

/** `res.json()` is the `json` of `res`, and `p.then(cb)` is what `cb` returns. */
function callHop(
  call: CallExpression,
  bodyMethods: ReadonlySet<string>,
): ReadHop<Node> | null {
  const chained = thenLikeCall(call);
  if (chained !== null) {
    const returned =
      chained.method === "then"
        ? callbackReturnExpression(call.getArguments()[0])
        : null;
    return returned === null ? null : { from: returned, segments: [] };
  }
  const callee = call.getExpression();
  if (
    !Node.isPropertyAccessExpression(callee) ||
    !bodyMethods.has(callee.getName())
  ) {
    return null;
  }
  return { from: callee.getExpression(), segments: [callee.getName()] };
}

function parameterDeclarationOf(node: Node): ParameterDeclaration | null {
  if (Node.isParameterDeclaration(node)) {
    return node;
  }
  const parent = node.getParent();
  return Node.isIdentifier(node) &&
    parent !== undefined &&
    Node.isParameterDeclaration(parent)
    ? parent
    : null;
}

// ---------------------------------------------------------------------------
// The reads a function makes
// ---------------------------------------------------------------------------

/** A value read in the body, and the properties read off it, outermost first. */
interface ValueRead {
  root: Node;
  segments: string[];
  /** Whether the last property is called as a method rather than read. */
  called: boolean;
}

/**
 * Every read in `subtree` that could be a read of the response: a name
 * the function declares, or a parenthesized call such as
 * `(await res.json())`, with the properties read off it.
 */
function valueReadsIn(
  subtree: Node,
  declared: ReadonlySet<string>,
): ValueRead[] {
  const reads: ValueRead[] = [];
  for (const node of ownDescendants(subtree)) {
    if (isReadRoot(node, declared)) {
      reads.push(readOff(node));
    }
  }
  return reads;
}

function isReadRoot(node: Node, declared: ReadonlySet<string>): boolean {
  if (Node.isIdentifier(node)) {
    return declared.has(node.getText()) && isNameRead(node);
  }
  const parent = node.getParent();
  return (
    Node.isParenthesizedExpression(node) &&
    parent !== undefined &&
    Node.isPropertyAccessExpression(parent) &&
    parent.getExpression() === node &&
    Node.isCallExpression(peelValue(node))
  );
}

/** Whether a name is read here, rather than declared or used as a property name. */
function isNameRead(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined || isBindingDeclarationSite(node)) {
    return false;
  }
  if (
    Node.isPropertyAccessExpression(parent) ||
    Node.isVariableDeclaration(parent) ||
    Node.isPropertyAssignment(parent)
  ) {
    return parent.getNameNode() !== node;
  }
  return true;
}

function readOff(root: Node): ValueRead {
  const segments: string[] = [];
  let top: Node = root;
  let parent = top.getParent();
  while (
    parent !== undefined &&
    Node.isPropertyAccessExpression(parent) &&
    parent.getExpression() === top
  ) {
    segments.push(parent.getName());
    top = parent;
    parent = top.getParent();
  }
  const called =
    segments.length > 0 &&
    parent !== undefined &&
    Node.isCallExpression(parent) &&
    parent.getExpression() === top;
  return { root, segments, called };
}

/**
 * The response members a read takes. A method called on the response
 * itself, such as `res.json()`, is one of its members. A method called
 * on anything inside it, such as `items.map(...)`, is not a field.
 */
function fieldsOfRead(place: readonly string[], read: ValueRead): string[] {
  const onResponse = place.length === 0 && read.segments.length === 1;
  const segments =
    read.called && !onResponse ? read.segments.slice(0, -1) : read.segments;
  return [...place, ...segments];
}

/** The names a function declares for values: its variables, destructured names and parameters. */
function declaredNamesIn(func: Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    if (
      Node.isVariableDeclaration(node) ||
      Node.isParameterDeclaration(node) ||
      Node.isBindingElement(node)
    ) {
      const name = node.getNameNode();
      if (Node.isIdentifier(name)) {
        names.add(name.getText());
      }
    }
  };
  visit(func);
  for (const node of ownDescendants(func)) {
    visit(node);
  }
  return names;
}

/** A response field `func` reads, as the members read off the response, and where the read is written. */
interface FieldRead {
  chain: string[];
  site: EffectSite;
}

function storeReads(
  func: Node,
  isResponse: (node: Node) => boolean,
  bodyMethods: ReadonlySet<string>,
  resolution: ResolutionStore,
): FieldRead[] {
  const reads = valueReadsIn(func, declaredNamesIn(func));
  const placeOf = placesInResponse(
    reads.map((read) => read.root),
    responseReading(isResponse, bodyMethods, resolution),
  );
  return reads.flatMap((read) => {
    const place = placeOf(read.root);
    return place === null
      ? []
      : [{ chain: fieldsOfRead(place, read), site: siteOf(read.root, func) }];
  });
}

/**
 * Whether `node` is the declaration site of a local binding rather than a
 * read of it: a destructured element (inside an object binding pattern)
 * or a callback parameter's own name node.
 */
function isBindingDeclarationSite(node: Node): boolean {
  if (isInsideObjectBindingPattern(node)) {
    return true;
  }
  const parent = node.getParent();
  return (
    parent !== undefined &&
    Node.isParameterDeclaration(parent) &&
    parent.getNameNode() === node
  );
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

/**
 * Every descendant of `root` that belongs to the same unit. A function
 * declared inside it is a unit of its own, with its own client calls, so
 * a read in there is never this unit's read of its response.
 */
function ownDescendants(root: Node): Node[] {
  const found: Node[] = [];
  root.forEachDescendant((node, traversal) => {
    if (isDescentStop(node, root)) {
      traversal.skip();
      return;
    }
    found.push(node);
  });
  return found;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/** What the pack says about the response a client reads. */
export interface ResponseMembers {
  responseSemantics?: ResponsePropertyMapping[] | undefined;
  /** The members a test on which decides which response a branch sees. */
  statusMembers: StatusMembers;
}

/**
 * For a client function, the fields each branch reads off the response,
 * in the order the branches were given. A read goes on the branches
 * `readsOn` puts it on. Without a store nothing says where a value came
 * from, so no branch reads anything.
 */
export function collectClientFieldAccesses(
  callExpr: CallExpression,
  func: Node,
  branches: readonly BranchEnding[],
  members: ResponseMembers,
  resolution?: ResolutionStore,
): (TypeShape | null)[] {
  if (resolution === undefined) {
    return branches.map(() => null);
  }
  const reads = storeReads(
    func,
    (node) => node === callExpr,
    bodyMethodsOf(members.responseSemantics),
    resolution,
  );
  return readsPerBranch(reads, [], branches, members);
}

/**
 * The fields a helper reads off the parameter it was handed the response
 * in, for each of its branches. `prefix` says where that value is in the
 * response: empty for the response itself, `["json"]` for the body
 * `res.json()` parsed.
 */
export function collectParameterFieldAccesses(
  parameter: string,
  prefix: readonly string[],
  func: Node,
  branches: readonly BranchEnding[],
  resolution: ResolutionStore,
  members: ResponseMembers,
): (TypeShape | null)[] {
  const handed = (node: Node): boolean => {
    const declaration = parameterDeclarationOf(node);
    return (
      declaration !== null &&
      declaration.getParent() === func &&
      declaration.getName() === parameter
    );
  };
  const bodyMethods =
    prefix.length === 0
      ? bodyMethodsOf(members.responseSemantics)
      : new Set<string>();
  const reads = storeReads(func, handed, bodyMethods, resolution);
  return readsPerBranch(reads, prefix, branches, members);
}

function bodyMethodsOf(semantics?: ResponsePropertyMapping[]): Set<string> {
  return new Set(
    (semantics ?? [])
      .filter((m) => m.access === "method" && m.semantics.type === "body")
      .map((m) => m.name),
  );
}

function readsPerBranch(
  reads: readonly FieldRead[],
  prefix: readonly string[],
  branches: readonly BranchEnding[],
  members: ResponseMembers,
): (TypeShape | null)[] {
  // A status, success flag or header read off the response is not a body
  // field. Off the parsed body, every name is one.
  const nonBodyProps =
    prefix.length === 0
      ? buildNonBodyPropertySet(members.responseSemantics)
      : new Set<string>();
  const bodyReads = reads.filter(
    ({ chain }) => chain.length > 0 && !nonBodyProps.has(chain[0] ?? ""),
  );
  const decides = decidesResponse(members.statusMembers);
  return branches.map((branch) =>
    readShapeOf(
      bodyReads
        .filter(({ site }) => readsOn(site, branch, decides))
        .map(({ chain }) => [...prefix, ...chain]),
    ),
  );
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
