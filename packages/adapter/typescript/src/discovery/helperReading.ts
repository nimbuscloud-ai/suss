/**
 * helperReading.ts: what a project helper's body does, written in terms
 * of the helper's own parameters.
 *
 * A `.get` call inside a function whose parameters are `(app, name,
 * handlers)` comes back as a call on parameter 0 with the path
 * `"/{1}"` and the handler `{2}.list`. A pack reads that shape and
 * never touches an AST.
 *
 * Nothing here resolves a value through the store. A helper's body says
 * what it does with what it was handed, and following a name out of the
 * body would answer for one caller when the point is to answer for all
 * of them.
 */

import { Node } from "ts-morph";

import type { HelperSink, HelperValue } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";

const UNREAD: HelperValue = { as: "unread" };

/** Every call `helper`'s body makes, read in the helper's own terms. */
export function readHelperSinks(helper: FunctionRoot): HelperSink[] {
  const positions = parameterPositions(helper);
  const sinks: HelperSink[] = [];
  const body = helper.getBody();
  if (body === undefined) {
    return sinks;
  }

  body.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    const [method, receiver] = Node.isPropertyAccessExpression(callee)
      ? [callee.getName(), readValue(callee.getExpression(), positions)]
      : [null, UNREAD];
    sinks.push({
      method,
      receiver,
      arguments: node.getArguments().map((arg) => readValue(arg, positions)),
    });
  });

  return sinks;
}

/** What a helper's parameters are called, in order. */
export function parameterNames(helper: FunctionRoot): string[] {
  return helper.getParameters().map((p) => p.getName());
}

function parameterPositions(helper: FunctionRoot): Map<string, number> {
  const positions = new Map<string, number>();
  helper.getParameters().forEach((parameter, position) => {
    positions.set(parameter.getName(), position);
  });
  return positions;
}

/**
 * One value in the body. A name that is not a parameter reads as
 * unread rather than as its text, so a pack never mistakes a module
 * constant for something the call site fills in.
 */
function readValue(node: Node, positions: Map<string, number>): HelperValue {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return { as: "text", text: node.getLiteralValue() };
  }
  if (Node.isTemplateExpression(node)) {
    return templateText(node, positions);
  }
  if (Node.isIdentifier(node)) {
    const position = positions.get(node.getText());
    return position === undefined ? UNREAD : { as: "parameter", position };
  }
  if (Node.isPropertyAccessExpression(node)) {
    const target = node.getExpression();
    const position = Node.isIdentifier(target)
      ? positions.get(target.getText())
      : undefined;
    return position === undefined
      ? UNREAD
      : { as: "parameter", position, property: node.getName() };
  }
  if (Node.isObjectLiteralExpression(node)) {
    return objectValue(node, positions);
  }
  if (Node.isCallExpression(node)) {
    return {
      as: "call",
      callee: node.getExpression().getText(),
      arguments: node.getArguments().map((arg) => readValue(arg, positions)),
    };
  }
  return UNREAD;
}

/**
 * A template literal as one string with `{N}` where parameter N was
 * interpolated. An interpolation of anything else leaves the whole
 * template unread: half a path is worse than none.
 */
function templateText(node: Node, positions: Map<string, number>): HelperValue {
  if (!Node.isTemplateExpression(node)) {
    return UNREAD;
  }
  let text = node.getHead().getLiteralText();
  for (const span of node.getTemplateSpans()) {
    const expression = span.getExpression();
    const position = Node.isIdentifier(expression)
      ? positions.get(expression.getText())
      : undefined;
    if (position === undefined) {
      return UNREAD;
    }
    text += `{${position}}${span.getLiteral().getLiteralText()}`;
  }
  return { as: "text", text };
}

function objectValue(node: Node, positions: Map<string, number>): HelperValue {
  if (!Node.isObjectLiteralExpression(node)) {
    return UNREAD;
  }
  const properties: Record<string, HelperValue> = {};
  for (const property of node.getProperties()) {
    if (!Node.isPropertyAssignment(property)) {
      continue;
    }
    const initializer = property.getInitializer();
    if (initializer === undefined) {
      continue;
    }
    properties[propertyKey(property.getNameNode())] = readValue(
      initializer,
      positions,
    );
  }
  return { as: "object", properties };
}

/** What a property is written under, quoted or not. */
function propertyKey(name: Node): string {
  return Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText();
}
