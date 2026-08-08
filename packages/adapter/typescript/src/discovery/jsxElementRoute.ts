// jsxElementRoute.ts (discovery handler): routes declared as JSX
// elements, and the object-array form the same libraries accept.
//
// The pack says which element is the route, the path / element / index
// attributes, and any factory whose first argument is a route-object
// array. This file only walks: it matches elements by resolving their
// tag through the file's imports (so an aliased import reads the same
// as a plain one), composes nested paths outermost-first, and resolves
// the rendered component when the element attribute is a single
// identifier.
//
// Abstention is a value here. A route whose path is not a string
// literal, a spread standing in for routes declared elsewhere, and a
// route object built by a call each produce a unit that claims no path
// and includes a sentence saying what was not read. A route whose path
// is readable but whose component is not stays discovered, as a
// boundary with nothing behind it.

import { Node, type SourceFile } from "ts-morph";

import {
  arrayLiteralOf,
  functionValueOf,
  propertyValueOf,
} from "./resolveValue.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type {
  ArrayLiteralExpression,
  CallExpression,
  Identifier,
  JsxAttributeLike,
  JsxElement,
  JsxSelfClosingElement,
  ObjectLiteralExpression,
} from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

type JsxRouteMatch = Extract<
  DiscoveryPattern["match"],
  { type: "jsxElementRoute" }
>;

type RouteJsxNode = JsxElement | JsxSelfClosingElement;

/**
 * What a route declaration says about its own path. `none` is a layout
 * route: it declares no path and only groups children. `unreadable` is
 * a path attribute written as something other than a string literal.
 */
type OwnPath =
  | { kind: "literal"; value: string }
  | { kind: "inherited" }
  | { kind: "none" }
  | { kind: "unreadable" };

/**
 * The path everything under a route hangs off. `unreadable` is what a
 * route whose own path nobody can read leaves its children with: the
 * segments below it are known and where they hang is not, so no full
 * path is claimed for any of them.
 */
type Prefix = { path: string } | { unreadable: true };

/** A route's own full path, or the sentence saying why it has none. */
type ResolvedPath = { path: string } | { unread: string };

/**
 * What the element attribute names. `named` is a single-identifier
 * component reference; whether it resolves to a function in this
 * project is the caller's question. Anything else the route renders
 * (a call, a member expression, an inline tree) is `unreadable`, and
 * an element attribute that is not there at all is `absent`.
 */
type ElementTarget =
  | { kind: "named"; identifier: Identifier }
  | { kind: "unreadable" }
  | { kind: "absent" };

const PATH_NOT_LITERAL =
  "The path this route declares is not written as a string literal, so no path is claimed and this route pairs with nothing";
const ENCLOSING_PATH_NOT_LITERAL =
  "A route this one is nested under declares its path as something other than a string literal, so the full path is not claimed and this route pairs with nothing";
const SPREAD_NOT_ENUMERATED =
  "A spread stands in for routes declared elsewhere in this array, and they are not read here, so no path is claimed for any of them";
const ROUTE_BUILT_BY_CALL =
  "This route is built by a call rather than written out where the router is created, so nothing of it is read and no path is claimed";
const ROUTES_NOT_AN_ARRAY =
  "The routes this router is created from are not written as an array literal within reach, so none of them are read here";
const CHILDREN_NOT_AN_ARRAY =
  "The routes nested under this one are not written as an array literal within reach, so none of them are read here";

export function discoverJsxElementRoutes(
  sourceFile: SourceFile,
  match: JsxRouteMatch,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  const routeNames = localNamesFor(sourceFile, match, [match.routeElement]);
  const factoryNames = localNamesFor(
    sourceFile,
    match,
    match.routeObjectFactories ?? [],
  );
  const elementsNames = localNamesFor(
    sourceFile,
    match,
    match.elementsFactories ?? [],
  );
  if (routeNames.size === 0 && factoryNames.size === 0) {
    return [];
  }

  const results: DiscoveredUnit[] = [];
  sourceFile.forEachDescendant((node) => {
    const route = asRouteJsx(node, routeNames);
    if (route !== null) {
      const unit = unitForJsxRoute(route, match, routeNames, kind, resolution);
      if (unit !== null) {
        results.push(unit);
      }
      return;
    }

    if (Node.isCallExpression(node) && callsAFactory(node, factoryNames)) {
      results.push(
        ...unitsForRouteArray(node, match, elementsNames, kind, resolution),
      );
    }
  });
  return results;
}

/**
 * The local spellings of the listed library exports in this file. An
 * aliased import contributes the alias, which is the name the JSX and
 * the calls are written with.
 */
function localNamesFor(
  sourceFile: SourceFile,
  match: JsxRouteMatch,
  exported: string[],
): Set<string> {
  const modules = Array.isArray(match.importModule)
    ? match.importModule
    : [match.importModule];
  const local = new Set<string>();
  if (exported.length === 0) {
    return local;
  }
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (!modules.includes(importDecl.getModuleSpecifierValue())) {
      continue;
    }
    for (const named of importDecl.getNamedImports()) {
      if (exported.includes(named.getName())) {
        local.add(named.getAliasNode()?.getText() ?? named.getName());
      }
    }
  }
  return local;
}

/** This node as a route declaration, or null when it is not one. */
function asRouteJsx(
  node: Node,
  routeNames: ReadonlySet<string>,
): RouteJsxNode | null {
  if (!Node.isJsxSelfClosingElement(node) && !Node.isJsxElement(node)) {
    return null;
  }
  return isRouteJsx(node, routeNames) ? node : null;
}

function isRouteJsx(
  node: RouteJsxNode,
  routeNames: ReadonlySet<string>,
): boolean {
  const tag = tagNameOf(node);
  return tag !== null && routeNames.has(tag.getText());
}

/** The element's tag, when it is a plain identifier. */
function tagNameOf(node: RouteJsxNode): Identifier | null {
  const tag = Node.isJsxElement(node)
    ? node.getOpeningElement().getTagNameNode()
    : node.getTagNameNode();
  return Node.isIdentifier(tag) ? tag : null;
}

function attributesOf(node: RouteJsxNode): JsxAttributeLike[] {
  return Node.isJsxElement(node)
    ? node.getOpeningElement().getAttributes()
    : node.getAttributes();
}

/**
 * The value of a named JSX attribute, or null when the attribute is
 * not there. A bare attribute (`index` with nothing after it) gives
 * with the attribute node itself, which is how a boolean flag is
 * written.
 */
function attributeValueOf(node: RouteJsxNode, name: string): Node | null {
  for (const attribute of attributesOf(node)) {
    if (!Node.isJsxAttribute(attribute)) {
      continue;
    }

    if (attribute.getNameNode().getText() !== name) {
      continue;
    }

    return attribute.getInitializer() ?? attribute;
  }
  return null;
}

/**
 * The string a JSX attribute or object-property value is, or null
 * for anything computed. `path="x"` and `path={"x"}` both read; a
 * template with substitutions, a variable, and a call all give null.
 */
function literalStringOf(value: Node): string | null {
  const unwrapped = Node.isJsxExpression(value)
    ? (value.getExpression() ?? value)
    : value;
  if (
    Node.isStringLiteral(unwrapped) ||
    Node.isNoSubstitutionTemplateLiteral(unwrapped)
  ) {
    return unwrapped.getLiteralValue();
  }
  return null;
}

function ownPathOfJsx(node: RouteJsxNode, match: JsxRouteMatch): OwnPath {
  const pathValue = attributeValueOf(node, match.pathAttribute);
  if (pathValue !== null) {
    const literal = literalStringOf(pathValue);
    return literal !== null
      ? { kind: "literal", value: literal }
      : { kind: "unreadable" };
  }

  if (
    match.indexAttribute !== undefined &&
    attributeValueOf(node, match.indexAttribute) !== null
  ) {
    return { kind: "inherited" };
  }

  return { kind: "none" };
}

function elementTargetOfValue(value: Node | null): ElementTarget {
  if (value === null) {
    return { kind: "absent" };
  }
  const unwrapped = Node.isJsxExpression(value)
    ? (value.getExpression() ?? value)
    : value;
  if (
    !Node.isJsxSelfClosingElement(unwrapped) &&
    !Node.isJsxElement(unwrapped)
  ) {
    return { kind: "unreadable" };
  }
  const tag = tagNameOf(unwrapped);
  if (tag === null) {
    return { kind: "unreadable" };
  }
  return { kind: "named", identifier: tag };
}

/**
 * The path prefix the enclosing route elements compose, read
 * outermost-first the way the router itself resolves it: a literal
 * segment joins the prefix, a layout route contributes nothing, and an
 * enclosing path nobody can read makes every path under it
 * unclaimable.
 */
function composedPrefixOf(
  node: RouteJsxNode,
  match: JsxRouteMatch,
  routeNames: ReadonlySet<string>,
): Prefix {
  const enclosing: RouteJsxNode[] = [];
  for (const ancestor of node.getAncestors()) {
    if (Node.isJsxElement(ancestor) && isRouteJsx(ancestor, routeNames)) {
      enclosing.push(ancestor);
    }
  }

  let prefix: Prefix = { path: "" };
  for (const ancestor of enclosing.reverse()) {
    prefix = prefixUnder(prefix, ownPathOfJsx(ancestor, match));
  }
  return prefix;
}

/**
 * The prefix the routes under this one hang off. A literal segment
 * joins what it is under, a route with no path of its own passes its
 * prefix through unchanged, and a path nobody can read leaves
 * everything below it with nowhere to hang.
 *
 * Both forms of route declaration compose this way, so both call this:
 * the JSX walk climbs to the routes an element is written inside, and
 * the object walk descends into the routes an object nests, and the
 * rule they apply at each hop is the same one.
 */
function prefixUnder(prefix: Prefix, own: OwnPath): Prefix {
  if ("unreadable" in prefix || own.kind === "unreadable") {
    return { unreadable: true };
  }

  if (own.kind === "literal") {
    return { path: joinRoutePaths(prefix.path, own.value) };
  }

  return prefix;
}

/**
 * The full path a route serves, or the sentence saying why it claims
 * none. An index route serves the path it is under; anything else
 * joins its own segment onto it.
 */
function resolvedPathOf(own: OwnPath, prefix: Prefix): ResolvedPath {
  if ("unreadable" in prefix) {
    return { unread: ENCLOSING_PATH_NOT_LITERAL };
  }

  if (own.kind === "unreadable") {
    return { unread: PATH_NOT_LITERAL };
  }

  if (own.kind === "inherited") {
    return { path: prefix.path === "" ? "/" : prefix.path };
  }

  if (own.kind === "none") {
    return { path: prefix.path === "" ? "/" : prefix.path };
  }

  return { path: joinRoutePaths(prefix.path, own.value) };
}

/**
 * One path under another, the way nested route declarations compose: a
 * segment starting with "/" is absolute and stands alone, anything
 * else goes under the prefix. The result always starts with "/".
 */
function joinRoutePaths(prefix: string, segment: string): string {
  if (segment.startsWith("/")) {
    return segment;
  }
  const trimmed = segment.replace(/\/+$/, "");
  return `${prefix}/${trimmed}`;
}

function unitForJsxRoute(
  node: RouteJsxNode,
  match: JsxRouteMatch,
  routeNames: ReadonlySet<string>,
  kind: string,
  resolution: ResolutionStore | undefined,
): DiscoveredUnit | null {
  const target = elementTargetOfValue(
    attributeValueOf(node, match.elementAttribute),
  );
  // A route that renders nothing exists only to group the routes under
  // it, and each of those is its own declaration. Whether its own path
  // reads or not is the children's business, through the prefix.
  if (target.kind === "absent") {
    return null;
  }

  const own = ownPathOfJsx(node, match);
  if (own.kind === "none") {
    return null;
  }

  const resolved = resolvedPathOf(
    own,
    composedPrefixOf(node, match, routeNames),
  );
  if ("unread" in resolved) {
    return abstention(
      node,
      kind,
      resolved.unread,
      labelForTarget(target, node),
    );
  }

  return routeUnit(node, kind, match.method, resolved.path, target, resolution);
}

/**
 * The unit one readable route produces. The component behind it is the
 * unit when a single identifier refers to it and that identifier
 * resolves. Otherwise the route is a boundary announced here, and what
 * we could not read shows up as the summary's body-elsewhere gap.
 */
function routeUnit(
  at: Node,
  kind: string,
  method: string,
  path: string,
  target: Exclude<ElementTarget, { kind: "absent" }>,
  resolution: ResolutionStore | undefined,
): DiscoveredUnit {
  const routeInfo = { method, path };
  if (target.kind === "unreadable") {
    return {
      func: null,
      announcedAt: at,
      kind,
      name: path,
      nameKind: "label",
      routeInfo,
    };
  }
  const func =
    resolution === undefined
      ? null
      : functionValueOf(target.identifier, resolution);
  if (func === null) {
    return {
      func: null,
      announcedAt: at,
      kind,
      name: target.identifier.getText(),
      routeInfo,
    };
  }
  return {
    func,
    kind,
    name: target.identifier.getText(),
    routeInfo,
    // The unit is a component: its one parameter is the props object,
    // whatever the enclosing pack maps its handlers' inputs to.
    inputMapping: { type: "componentProps", paramPosition: 0 },
  };
}

function labelForTarget(target: ElementTarget, node: RouteJsxNode): string {
  if (target.kind === "named") {
    return target.identifier.getText();
  }
  return tagNameOf(node)?.getText() ?? node.getKindName();
}

function abstention(
  at: Node,
  kind: string,
  sentence: string,
  label: string,
): DiscoveredUnit {
  return {
    func: null,
    announcedAt: at,
    kind,
    name: label,
    nameKind: "label",
    unreadBinding: sentence,
  };
}

// ---------------------------------------------------------------------------
// The object-array form
// ---------------------------------------------------------------------------

function callsAFactory(
  call: CallExpression,
  factoryNames: ReadonlySet<string>,
): boolean {
  const callee = call.getExpression();
  return Node.isIdentifier(callee) && factoryNames.has(callee.getText());
}

function unitsForRouteArray(
  call: CallExpression,
  match: JsxRouteMatch,
  elementsNames: ReadonlySet<string>,
  kind: string,
  resolution: ResolutionStore | undefined,
): DiscoveredUnit[] {
  const first = call.getArguments()[0];
  if (first === undefined) {
    return [];
  }
  // Route elements handed to the factory, either written out or
  // through the library's own elements-to-routes call, are read by the
  // JSX walk wherever they appear, so there is nothing further to say
  // about them here.
  if (
    Node.isJsxElement(first) ||
    Node.isJsxSelfClosingElement(first) ||
    (Node.isCallExpression(first) && callsAFactory(first, elementsNames))
  ) {
    return [];
  }
  const array = arrayLiteralOf(first, resolution);
  if (array === null) {
    return [
      abstention(call, kind, ROUTES_NOT_AN_ARRAY, labelOfExpression(first)),
    ];
  }
  return unitsOfArrayElements(
    array,
    match,
    kind,
    resolution,
    { path: "" },
    new Set(),
  );
}

/**
 * Every route an array of route objects declares, including the ones
 * nested under them. `ancestry` is the arrays this one is nested
 * inside, so an array that nests itself stops rather than descending
 * forever. It is the chain rather than everything already seen: one
 * array of routes nested under two parents is two sets of routes, at
 * two paths, and both are declared.
 */
function unitsOfArrayElements(
  array: ArrayLiteralExpression,
  match: JsxRouteMatch,
  kind: string,
  resolution: ResolutionStore | undefined,
  prefix: Prefix,
  ancestry: ReadonlySet<ArrayLiteralExpression>,
): DiscoveredUnit[] {
  if (ancestry.has(array)) {
    return [];
  }
  const nestedIn = new Set(ancestry).add(array);

  const results: DiscoveredUnit[] = [];
  for (const element of array.getElements()) {
    if (Node.isSpreadElement(element)) {
      results.push(
        abstention(
          element,
          kind,
          SPREAD_NOT_ENUMERATED,
          labelOfExpression(element.getExpression()),
        ),
      );
      continue;
    }

    if (!Node.isObjectLiteralExpression(element)) {
      results.push(
        abstention(
          element,
          kind,
          ROUTE_BUILT_BY_CALL,
          labelOfExpression(element),
        ),
      );
      continue;
    }

    results.push(
      ...unitsForRouteObject(
        element,
        match,
        kind,
        resolution,
        prefix,
        nestedIn,
      ),
    );
  }
  return results;
}

/**
 * What one route object declares: the route itself, when it renders
 * something, and every route nested under it, which hangs off this
 * one's path the same way a nested route element hangs off the element
 * it is written inside.
 */
function unitsForRouteObject(
  object: ObjectLiteralExpression,
  match: JsxRouteMatch,
  kind: string,
  resolution: ResolutionStore | undefined,
  prefix: Prefix,
  ancestry: ReadonlySet<ArrayLiteralExpression>,
): DiscoveredUnit[] {
  const own = ownPathOfObject(object, match);
  const here = unitForRouteObject(object, match, kind, resolution, prefix, own);
  const nested = unitsUnderRouteObject(
    object,
    match,
    kind,
    resolution,
    prefixUnder(prefix, own),
    ancestry,
  );
  return here === null ? nested : [here, ...nested];
}

function unitForRouteObject(
  object: ObjectLiteralExpression,
  match: JsxRouteMatch,
  kind: string,
  resolution: ResolutionStore | undefined,
  prefix: Prefix,
  own: OwnPath,
): DiscoveredUnit | null {
  const target = elementTargetOfValue(
    routePropertyOf(object, match.elementAttribute),
  );
  if (target.kind === "absent") {
    return null;
  }

  if (own.kind === "none") {
    return null;
  }

  const resolved = resolvedPathOf(own, prefix);
  if ("unread" in resolved) {
    return abstention(object, kind, resolved.unread, objectLabelOf(target));
  }

  return routeUnit(
    object,
    kind,
    match.method,
    resolved.path,
    target,
    resolution,
  );
}

/** The routes a route object nests under itself. */
function unitsUnderRouteObject(
  object: ObjectLiteralExpression,
  match: JsxRouteMatch,
  kind: string,
  resolution: ResolutionStore | undefined,
  prefix: Prefix,
  ancestry: ReadonlySet<ArrayLiteralExpression>,
): DiscoveredUnit[] {
  if (match.childrenAttribute === undefined) {
    return [];
  }
  const children = routePropertyOf(object, match.childrenAttribute);
  if (children === null) {
    return [];
  }
  const array = arrayLiteralOf(children, resolution);
  if (array === null) {
    return [
      abstention(
        children,
        kind,
        CHILDREN_NOT_AN_ARRAY,
        labelOfExpression(children),
      ),
    ];
  }
  return unitsOfArrayElements(array, match, kind, resolution, prefix, ancestry);
}

function ownPathOfObject(
  object: ObjectLiteralExpression,
  match: JsxRouteMatch,
): OwnPath {
  const pathValue = routePropertyOf(object, match.pathAttribute);
  if (pathValue !== null) {
    const literal = literalStringOf(pathValue);
    return literal !== null
      ? { kind: "literal", value: literal }
      : { kind: "unreadable" };
  }

  if (match.indexAttribute !== undefined) {
    const indexValue = routePropertyOf(object, match.indexAttribute);
    if (indexValue !== null && Node.isTrueLiteral(indexValue)) {
      return { kind: "inherited" };
    }
  }

  return { kind: "none" };
}

function routePropertyOf(
  object: ObjectLiteralExpression,
  name: string,
): Node | null {
  const property = object.getProperty(name);
  return property === undefined ? null : propertyValueOf(property);
}

function objectLabelOf(target: ElementTarget): string {
  return target.kind === "named" ? target.identifier.getText() : "declaration";
}

function labelOfExpression(node: Node): string {
  if (Node.isIdentifier(node)) {
    return node.getText();
  }

  if (Node.isCallExpression(node)) {
    return node.getExpression().getText();
  }

  return node.getKindName();
}
