// subUnitContext.ts: Primitives the TypeScript adapter exposes to
// packs whose `subUnits` hook needs to walk the parent's AST.
//
// The PatternPack.subUnits signature in @suss/extractor takes `ctx:
// unknown` because the extractor has no knowledge of which adapter is
// driving. Each adapter defines its own context type; packs cast to
// the adapter context they're written against ("I expect the
// TypeScript adapter"). The primitives here are enough to cover React
// event-handler prop discovery and React/Node event-subscription call
// discovery: both expressions of "runtime schedules user callbacks."
//
// Keep primitives narrow: they do AST-shape inspection and return
// either concrete JS types (string, string[]) or opaque AST handles
// (FunctionRoot, Node). Packs don't manipulate ts-morph directly from
// here: they receive handles and pass them back via the context.

import {
  type ArrayLiteralExpression,
  type CallExpression,
  type JsxExpression,
  type NewExpression,
  Node,
  SyntaxKind,
} from "ts-morph";

import { factElementOps, factValueOps } from "@suss/recognize/ops";

import { importedReferenceSpellings } from "./discovery/resolveImport.js";
import { nodeId } from "./facts/extract.js";
import { ResolutionStore } from "./facts/store.js";
import { factSourceFor, statedFactKey } from "./resolve/factSource.js";
import { opsOverFacts } from "./resolve/opsOverFacts.js";
import {
  callsInUnitBody,
  isDescentStop,
  withDescentStops,
} from "./walk/descent.js";
import { forEachDescendantOfKinds } from "./walk/rawDescent.js";
import { peelValue } from "./walk/unwrap.js";

import type {
  AstCapableValueOps,
  CallOps,
  DiscoveredSubUnitParent,
  ElementOps,
  SubUnitOpsCarrier,
  ValueOps,
} from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

/**
 * The context the TypeScript adapter passes to a pack's `subUnits`
 * hook. Covers JSX-attribute-walking and call-expression-walking plus
 * the resolution helpers packs need to map AST nodes back to function
 * bodies and source text.
 *
 * The walks descend the way the parent's body walk does, so a sub-unit
 * inside a nested declaration belongs to that declaration's summary.
 */
export interface TsSubUnitContext extends SubUnitOpsCarrier {
  /**
   * Yield every JSX attribute on every JSX element / self-closing
   * element in the parent's body, excluding any inside nested
   * function bodies. The tag is the source text of the element's
   * tag-name node.
   */
  findJsxAttributes(parent: FunctionRoot): TsJsxAttributeLocation[];

  /**
   * Yield every call written `name(...)`, from the calls the parent's
   * body walk reaches. Given the module that exports `name`, also every
   * other way the file can write that export: an alias of a named import,
   * or `React.useEffect` off a default or namespace import.
   */
  findCallExpressionsByName(
    parent: FunctionRoot,
    name: string,
    module?: string,
  ): CallExpression[];

  /**
   * Resolve a JSX attribute's value to a function body, if the value
   * is (a) an inline arrow or function expression or (b) an
   * identifier referring to a function declared inside the parent.
   * Returns null for prop-delegating references (`props.onClick`),
   * identifiers that resolve outside the parent's scope, or any
   * non-function expression.
   */
  resolveAttributeValueFunction(
    attr: TsJsxAttributeLocation,
    parent: FunctionRoot,
  ): { func: FunctionRoot; localName: string | null } | null;

  /**
   * Return the Nth argument of a call as a function body, if it's an
   * arrow or function expression, through parentheses and casts. Returns
   * null for identifier references, property accesses, or other values.
   */
  getCallArgumentFunction(
    call: CallExpression,
    position: number,
  ): FunctionRoot | null;

  /**
   * Return the Nth argument raw node (or null if absent).
   */
  getCallArgument(call: CallExpression, position: number): Node | null;

  /**
   * Each element's source text for an array literal, read through
   * parentheses and casts, or else the whole expression's text as one
   * entry. Null means no deps argument was given.
   */
  readArrayLiteralText(node: Node | null): string[] | null;

  /**
   * The run's store, the same one a recognizer's context has, so a pack
   * that claims a callback off a call it recognized can ask the store
   * the same questions about that call. Undefined when the run has no
   * store.
   */
  readonly resolution?: ResolutionStore;
}

/**
 * A located JSX attribute: which element it's on, its name, and the
 * expression node supplying its value (null for boolean-shorthand
 * attributes like `<input disabled>`).
 */
export interface TsJsxAttributeLocation {
  tag: string;
  name: string;
  valueExpression: Node | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createTsSubUnitContext(
  resolution?: ResolutionStore,
): TsSubUnitContext {
  // A bare context gets a store of its own to read a handler's name over.
  const store = resolution ?? new ResolutionStore();
  return {
    findJsxAttributes,
    findCallExpressionsByName,
    resolveAttributeValueFunction: (attr, parent) =>
      resolveAttributeValueFunction(attr, parent, store),
    getCallArgumentFunction,
    getCallArgument,
    readArrayLiteralText,
    ...(resolution === undefined
      ? {}
      : {
          resolution,
          calls: (parent) => callsRunAsOps(parent, resolution),
          elements: (parent) => elementsRunAsOps(parent, resolution),
          writes: (parent, fn) => parentWrites(parent, fn),
        }),
    mentions: (parent, word) =>
      (parent.func as Node).getSourceFile().getFullText().includes(word),
  };
}

/** The JSX elements the parent renders, as the ops a declared pack reads each one's tag and attributes through. */
function elementsRunAsOps(
  parent: DiscoveredSubUnitParent,
  store: ResolutionStore,
): ElementOps[] {
  const source = factSourceFor(store, (value, module) =>
    store.originatesFrom(value, module),
  );
  return store
    .elementsRunBy(parent.func as FunctionRoot)
    .map((element) => factElementOps(nodeId(element), source));
}

/** Whether the function a value settles to is written in the parent's body, at any depth. */
function parentWrites(parent: DiscoveredSubUnitParent, fn: ValueOps): boolean {
  const node = (fn as Partial<AstCapableValueOps>).ast?.() ?? null;
  return (
    node instanceof Node && isWithinFunction(node, parent.func as FunctionRoot)
  );
}

/**
 * The calls the parent's body runs, as the ops a declared pack's
 * recognizer gets for each, so its hook matches a call the same way.
 */
function callsRunAsOps(
  parent: DiscoveredSubUnitParent,
  store: ResolutionStore,
): CallOps[] {
  const originatesFrom = (value: Node, module: string): boolean =>
    store.originatesFrom(value, module);
  return store
    .callsRunBy(parent.func as FunctionRoot)
    .filter(
      (call): call is CallExpression | NewExpression =>
        Node.isCallExpression(call) || Node.isNewExpression(call),
    )
    .map((call) => opsOverFacts(call, { resolution: store, originatesFrom }));
}

const JSX_ELEMENTS_AND_STOPS = withDescentStops(
  SyntaxKind.JsxOpeningElement,
  SyntaxKind.JsxSelfClosingElement,
);

function findJsxAttributes(parent: FunctionRoot): TsJsxAttributeLocation[] {
  const out: TsJsxAttributeLocation[] = [];

  forEachDescendantOfKinds(parent, JSX_ELEMENTS_AND_STOPS, (node) => {
    if (isDescentStop(node, parent)) {
      return true;
    }
    if (
      !Node.isJsxOpeningElement(node) &&
      !Node.isJsxSelfClosingElement(node)
    ) {
      return false;
    }
    const tag = node.getTagNameNode().getText();
    for (const attr of node.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) {
        continue;
      }
      const initializer = attr.getInitializer();
      let valueExpression: Node | null = null;
      if (initializer !== undefined) {
        if (Node.isJsxExpression(initializer)) {
          const inner = (initializer as JsxExpression).getExpression();
          valueExpression = inner ?? null;
        } else {
          // String-literal-valued attributes (`type="button"`),
          // rarely interesting for subUnits, but exposing the node
          // keeps the interface complete.
          valueExpression = initializer;
        }
      }
      out.push({
        tag,
        name: attr.getNameNode().getText(),
        valueExpression,
      });
    }
    return false;
  });

  return out;
}

function findCallExpressionsByName(
  parent: FunctionRoot,
  name: string,
  module?: string,
): CallExpression[] {
  const spellings = new Set([
    name,
    ...(module === undefined
      ? []
      : importedReferenceSpellings(parent.getSourceFile(), module, name)),
  ]);
  return callsInUnitBody(parent).filter((call) =>
    spellings.has(call.getExpression().getText()),
  );
}

function resolveAttributeValueFunction(
  attr: TsJsxAttributeLocation,
  parent: FunctionRoot,
  store: ResolutionStore,
): { func: FunctionRoot; localName: string | null } | null {
  if (attr.valueExpression === null) {
    return null;
  }
  const expr = peelValue(attr.valueExpression);

  if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
    return { func: expr as FunctionRoot, localName: null };
  }

  if (!Node.isIdentifier(expr)) {
    return null;
  }
  const func = functionNamedBy(expr, store);
  return func !== null && isWithinFunction(func, parent)
    ? { func: func as FunctionRoot, localName: expr.getText() }
    : null;
}

/**
 * The function a name settles to over the facts, as a declared pack's
 * value ops find it: through a `useCallback` the component declares as
 * well as a declaration or an arrow kept in a const.
 */
function functionNamedBy(name: Node, store: ResolutionStore): Node | null {
  const found =
    factValueOps(
      statedFactKey(name, store),
      factSourceFor(store),
    ).function?.() ?? null;
  const node = (found as Partial<AstCapableValueOps> | null)?.ast?.() ?? null;
  return node as Node | null;
}

function isWithinFunction(node: Node, func: FunctionRoot): boolean {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (current === func) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

function getCallArgumentFunction(
  call: CallExpression,
  position: number,
): FunctionRoot | null {
  const written = call.getArguments()[position];
  if (written === undefined) {
    return null;
  }
  const arg = peelValue(written);
  if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
    return arg as FunctionRoot;
  }
  return null;
}

function getCallArgument(call: CallExpression, position: number): Node | null {
  return call.getArguments()[position] ?? null;
}

function readArrayLiteralText(written: Node | null): string[] | null {
  if (written === null) {
    return null;
  }
  const node = peelValue(written);
  if (Node.isArrayLiteralExpression(node)) {
    return (node as ArrayLiteralExpression)
      .getElements()
      .map((e) => e.getText());
  }
  // Non-array deps argument: record the whole expression as a single
  // dep-text entry so provenance isn't lost.
  return [node.getText()];
}
