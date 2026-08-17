/**
 * The pack's `discoverUnits` callback.
 *
 * A Worker registers nothing. Its entrypoint is the shape of its
 * default export, `export default { fetch, scheduled, queue, tail }`,
 * so discovery reads that object literal and emits one unit per trigger
 * it defines. A function written elsewhere and referred to by name is
 * followed to its declaration, since that is how most services split a
 * long handler out of the entrypoint file. The older service-worker
 * form registers the same triggers through `addEventListener("fetch",
 * handler)`, and comes out as the same unit.
 */

import { Node as N } from "ts-morph";

import { TRIGGERS } from "./handlers.js";

import type { FunctionRoot } from "@suss/adapter-typescript";
import type { DiscoveredCustomUnit, PatternPack } from "@suss/extractor";
import type {
  Expression,
  Node,
  ObjectLiteralExpression,
  SourceFile,
} from "ts-morph";

/** Metadata namespace stamped on every unit this pack discovers. */
export const METADATA_NAMESPACE = "cloudflareWorkers";

/** How a trigger was registered, recorded so a reader can tell them apart. */
type Registration = "default-export" | "addEventListener";

interface Trigger {
  name: string;
  func: FunctionRoot;
  registration: Registration;
}

export interface CloudflareWorkersDiscoveryOptions {
  /**
   * The name the deployment gives this Worker. Left out, a unit states
   * no deployable, and the runtime-config provider from `wrangler.toml`
   * places its code by directory instead.
   */
  scriptName?: string;
}

export function cloudflareWorkersDiscovery(
  options: CloudflareWorkersDiscoveryOptions = {},
): NonNullable<PatternPack["discoverUnits"]> {
  return (sourceFile) => {
    const sf = sourceFile as SourceFile;
    const triggers = [...defaultExportTriggers(sf), ...listenerTriggers(sf)];

    const units: DiscoveredCustomUnit[] = [];
    const taken = new Set<string>();
    for (const trigger of triggers) {
      if (taken.has(trigger.name)) {
        continue;
      }
      taken.add(trigger.name);
      units.push(unitFor(trigger, options.scriptName));
    }
    return units;
  };
}

function unitFor(
  trigger: Trigger,
  scriptName: string | undefined,
): DiscoveredCustomUnit {
  const shape = TRIGGERS[trigger.name] as (typeof TRIGGERS)[string];
  return {
    func: trigger.func,
    kind: shape.kind,
    name: trigger.name,
    ...(shape.routeInfo !== undefined ? { routeInfo: shape.routeInfo } : {}),
    ...(shape.channelInfo !== undefined
      ? { channelInfo: shape.channelInfo }
      : {}),
    ...(scriptName !== undefined
      ? {
          deployableUnit: {
            deploymentTarget: "worker" as const,
            instanceName: scriptName,
          },
        }
      : {}),
    metadata: {
      [METADATA_NAMESPACE]: {
        trigger: trigger.name,
        registration: trigger.registration,
      },
    },
  };
}

/**
 * The triggers `export default { ... }` defines. `exportedFunctions`
 * skips this export, since it lists only the ones whose declaration is
 * a function, and an entrypoint's is an object.
 */
function defaultExportTriggers(sf: SourceFile): Trigger[] {
  const literal = defaultExportObject(sf);
  if (literal === null) {
    return [];
  }

  const triggers: Trigger[] = [];
  for (const property of literal.getProperties()) {
    const found = triggerOfProperty(property, sf);
    if (found !== null) {
      triggers.push(found);
    }
  }
  return triggers;
}

/** One property of the entrypoint object, when it defines a trigger. */
function triggerOfProperty(property: Node, sf: SourceFile): Trigger | null {
  const named = propertyName(property);
  if (named === null || TRIGGERS[named] === undefined) {
    return null;
  }
  const func = functionOfProperty(property, sf);
  return func === null
    ? null
    : { name: named, func, registration: "default-export" };
}

function propertyName(property: Node): string | null {
  if (N.isMethodDeclaration(property) || N.isPropertyAssignment(property)) {
    const name = property.getNameNode();
    if (N.isIdentifier(name)) {
      return name.getText();
    }
    return N.isStringLiteral(name) ? name.getLiteralValue() : null;
  }
  return N.isShorthandPropertyAssignment(property) ? property.getName() : null;
}

function functionOfProperty(
  property: Node,
  sf: SourceFile,
): FunctionRoot | null {
  if (N.isMethodDeclaration(property)) {
    return property as FunctionRoot;
  }
  if (N.isPropertyAssignment(property)) {
    const written = property.getInitializer();
    return written === undefined ? null : functionBehind(written, sf);
  }
  if (N.isShorthandPropertyAssignment(property)) {
    return functionBehind(property.getNameNode(), sf);
  }
  return null;
}

/**
 * The function an expression comes down to: written in place, or
 * declared elsewhere in this project under the name it refers to.
 */
function functionBehind(expression: Node, sf: SourceFile): FunctionRoot | null {
  if (N.isArrowFunction(expression) || N.isFunctionExpression(expression)) {
    return expression as FunctionRoot;
  }
  if (!N.isIdentifier(expression)) {
    return null;
  }
  for (const definition of expression.getDefinitionNodes()) {
    const declared = declaredFunction(definition);
    if (declared !== null) {
      return declared;
    }
  }
  return localFunction(sf, expression.getText());
}

function declaredFunction(definition: Node): FunctionRoot | null {
  if (N.isFunctionDeclaration(definition)) {
    return definition as FunctionRoot;
  }
  if (!N.isVariableDeclaration(definition)) {
    return null;
  }
  const written = definition.getInitializer();
  if (written === undefined) {
    return null;
  }
  return N.isArrowFunction(written) || N.isFunctionExpression(written)
    ? (written as FunctionRoot)
    : null;
}

/** A function this file declares under a name, when the symbol did not resolve. */
function localFunction(sf: SourceFile, name: string): FunctionRoot | null {
  const declaration = sf.getFunction(name);
  if (declaration !== undefined) {
    return declaration as FunctionRoot;
  }
  const variable = sf.getVariableDeclaration(name);
  return variable === undefined ? null : declaredFunction(variable);
}

/**
 * The object literal the file default-exports, through however many
 * type assertions the entrypoint is written with.
 */
function defaultExportObject(sf: SourceFile): ObjectLiteralExpression | null {
  const assignment = sf.getExportAssignment((a) => !a.isExportEquals());
  if (assignment === undefined) {
    return null;
  }
  return objectBehind(unwrap(assignment.getExpression()), sf);
}

/** An expression with its `satisfies`, `as` and parentheses taken off. */
function unwrap(expression: Expression): Expression {
  let inner = expression;
  while (
    N.isSatisfiesExpression(inner) ||
    N.isAsExpression(inner) ||
    N.isParenthesizedExpression(inner)
  ) {
    inner = inner.getExpression();
  }
  return inner;
}

function objectBehind(
  expression: Expression,
  sf: SourceFile,
): ObjectLiteralExpression | null {
  if (N.isObjectLiteralExpression(expression)) {
    return expression;
  }
  if (!N.isIdentifier(expression)) {
    return null;
  }
  const declaration = sf.getVariableDeclaration(expression.getText());
  const written = declaration?.getInitializer();
  if (written === undefined) {
    return null;
  }
  const inner = unwrap(written);
  return N.isObjectLiteralExpression(inner) ? inner : null;
}

/**
 * The triggers `addEventListener("fetch", handler)` registers. Only a
 * string literal is read: an event name computed at run time gives no
 * trigger anyone can pair against.
 */
function listenerTriggers(sf: SourceFile): Trigger[] {
  const triggers: Trigger[] = [];
  sf.forEachDescendant((node) => {
    const registered = listenerAt(node);
    if (registered === null) {
      return;
    }
    const func = functionBehind(registered.handler, sf);
    if (func !== null) {
      triggers.push({
        name: registered.event,
        func,
        registration: "addEventListener",
      });
    }
  });
  return triggers;
}

function listenerAt(node: Node): { event: string; handler: Node } | null {
  if (!N.isCallExpression(node)) {
    return null;
  }
  const callee = node.getExpression();
  if (!N.isIdentifier(callee) || callee.getText() !== "addEventListener") {
    return null;
  }
  const [event, handler] = node.getArguments();
  if (event === undefined || handler === undefined) {
    return null;
  }
  if (
    !N.isStringLiteral(event) ||
    TRIGGERS[event.getLiteralValue()] === undefined
  ) {
    return null;
  }
  return { event: event.getLiteralValue(), handler };
}
