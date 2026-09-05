/**
 * The TypeScript lowering for `@suss/values`: each ts-morph node is
 * turned into the engine's expression or statement shape when the
 * engine asks for it, and the two cross-file questions, what a name was
 * written as and which function a call reaches, go to the resolution
 * store.
 *
 * A function body's block is not on a site path, since the function
 * itself is the root; a block inside an `if` or a loop is not either,
 * since the arm or the body is read as a list of statements. Only a
 * block written on its own is a statement of its own.
 */

import { Node, SyntaxKind } from "ts-morph";

import { peelValue } from "../walk/unwrap.js";

import type {
  Callee,
  Declaration,
  Element,
  Expression,
  Field,
  FunctionShape,
  Lowering,
  Origin,
  Row,
  Site,
  Statement,
} from "@suss/values";
import type { ResolutionStore } from "../facts/store.js";

const ASSIGNMENT_OPERATORS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "??=",
  "||=",
  "&&=",
]);

/** Array methods that write to their receiver; arrays are the one
 * built-in the engine models, so Map and Set writes need no entry. */
const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

export interface LoweringOptions {
  readonly resolution?: ResolutionStore;
  readonly rows: readonly Row[];
}

export function typescriptLowering(options: LoweringOptions): Lowering<Node> {
  const { resolution, rows } = options;
  const rowModules = [
    ...new Set(
      rows.flatMap((row) => (row.kind === "callee" ? [row.origin.module] : [])),
    ),
  ];
  const mutatedByRoot = new Map<Node, Set<string>>();

  const originOf = (callee: Node): Origin | null => {
    const chain = memberChainOf(callee);
    if (chain === null) {
      return null;
    }
    const name = chain.names[chain.names.length - 1] ?? null;
    if (name === null) {
      return null;
    }
    const origins = resolution?.importOriginsOf(chain.root, rowModules) ?? [];
    const first = origins[0];
    if (first !== undefined) {
      return { module: first.module, name };
    }
    const local =
      resolution !== undefined && resolution.resolveCallable(callee) !== null;
    if (chain.names.length > 1 || local) {
      return null;
    }
    return { module: "global", name };
  };

  return {
    expression: (node) => expressionOf(peelValue(node), originOf),
    statement: statementOf,
    siteOf,
    functionOf,
    writtenTo: (node) => {
      if (resolution === undefined) {
        return null;
      }
      const target = peelValue(node);
      return (
        resolution.resolveWrittenValue(target) ??
        resolution.resolveObject(target)
      );
    },
    callable: (node) => {
      const call = peelValue(node);
      if (
        resolution === undefined ||
        (!Node.isCallExpression(call) && !Node.isNewExpression(call))
      ) {
        return null;
      }
      const target = resolution.resolveCallable(call.getExpression());
      return target !== null && Node.isFunctionLikeDeclaration(target)
        ? target
        : null;
    },
    mutatedInNestedFunction: (root, name) => {
      let mutated = mutatedByRoot.get(root);
      if (mutated === undefined) {
        mutated = namesMutatedInNestedFunctions(root);
        mutatedByRoot.set(root, mutated);
      }
      return mutated.has(name);
    },
    freeNamesOf,
    holeNameOf: placeholderName,
    rows,
  };
}

/** The name a hole takes for an expression nothing could read. */
export function placeholderName(expr: Node): string {
  if (Node.isIdentifier(expr)) {
    return expr.getText();
  }
  if (Node.isPropertyAccessExpression(expr)) {
    return expr.getName();
  }
  return "param";
}

function expressionOf(
  node: Node,
  originOf: (callee: Node) => Origin | null,
): Expression<Node> {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return { kind: "literal", value: node.getLiteralValue() };
  }
  if (Node.isNumericLiteral(node)) {
    return { kind: "literal", value: node.getLiteralValue() };
  }
  if (Node.isTrueLiteral(node)) {
    return { kind: "literal", value: true };
  }
  if (Node.isFalseLiteral(node)) {
    return { kind: "literal", value: false };
  }
  if (Node.isNullLiteral(node)) {
    return { kind: "literal", value: null };
  }
  if (Node.isIdentifier(node)) {
    return node.getText() === "undefined"
      ? { kind: "literal", value: undefined }
      : { kind: "name", text: node.getText() };
  }
  if (Node.isTemplateExpression(node)) {
    return {
      kind: "template",
      parts: [
        { text: node.getHead().getLiteralText() },
        ...node
          .getTemplateSpans()
          .flatMap((span) => [
            { expression: span.getExpression() },
            { text: span.getLiteral().getLiteralText() },
          ]),
      ],
    };
  }
  if (Node.isPropertyAccessExpression(node)) {
    return {
      kind: "member",
      object: node.getExpression(),
      name: node.getName(),
    };
  }
  if (Node.isElementAccessExpression(node)) {
    const index = node.getArgumentExpression();
    return index === undefined
      ? { kind: "opaque" }
      : { kind: "element", object: node.getExpression(), index };
  }
  if (Node.isArrayLiteralExpression(node)) {
    return { kind: "array", items: node.getElements().map(elementOf) };
  }
  if (Node.isObjectLiteralExpression(node)) {
    return { kind: "record", fields: node.getProperties().flatMap(fieldOf) };
  }
  if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
    return {
      kind: "call",
      callee: calleeOf(node.getExpression(), originOf),
      args: node.getArguments().map(elementOf),
      constructs: Node.isNewExpression(node),
    };
  }
  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getText();
    return ASSIGNMENT_OPERATORS.has(operator)
      ? { kind: "opaque" }
      : {
          kind: "operator",
          operator,
          operands: [node.getLeft(), node.getRight()],
        };
  }
  if (Node.isPrefixUnaryExpression(node)) {
    const operator = node.getOperatorToken();
    return operator === SyntaxKind.ExclamationToken
      ? { kind: "operator", operator: "!", operands: [node.getOperand()] }
      : { kind: "opaque" };
  }
  if (Node.isConditionalExpression(node)) {
    return {
      kind: "conditional",
      condition: node.getCondition(),
      whenTrue: node.getWhenTrue(),
      whenFalse: node.getWhenFalse(),
    };
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return { kind: "function", node };
  }
  return { kind: "opaque" };
}

function elementOf(node: Node): Element<Node> {
  return Node.isSpreadElement(node)
    ? { kind: "spread", node: node.getExpression() }
    : { kind: "value", node };
}

function fieldOf(property: Node): Field<Node>[] {
  if (Node.isSpreadAssignment(property)) {
    return [{ kind: "spread", node: property.getExpression() }];
  }
  if (Node.isShorthandPropertyAssignment(property)) {
    const nameNode = property.getNameNode();
    return [{ kind: "field", name: nameNode.getText(), value: nameNode }];
  }
  if (!Node.isPropertyAssignment(property)) {
    return [];
  }
  const value = property.getInitializer();
  if (value === undefined) {
    return [];
  }
  const nameNode = property.getNameNode();
  if (Node.isComputedPropertyName(nameNode)) {
    return [{ kind: "computed", name: nameNode.getExpression(), value }];
  }
  const name =
    Node.isStringLiteral(nameNode) || Node.isNumericLiteral(nameNode)
      ? String(nameNode.getLiteralValue())
      : nameNode.getText();
  return [{ kind: "field", name, value }];
}

function calleeOf(
  expression: Node,
  originOf: (callee: Node) => Origin | null,
): Callee<Node> {
  const callee = peelValue(expression);
  if (Node.isPropertyAccessExpression(callee)) {
    return {
      receiver: callee.getExpression(),
      name: callee.getName(),
      origin: () => originOf(callee),
    };
  }
  if (Node.isIdentifier(callee)) {
    return {
      receiver: null,
      name: callee.getText(),
      origin: () => originOf(callee),
    };
  }
  return { receiver: null, name: null, origin: () => null };
}

/** `a.b.c` as its root identifier and the names read off it, in order. */
function memberChainOf(node: Node): { root: Node; names: string[] } | null {
  const names: string[] = [];
  let current = peelValue(node);
  while (Node.isPropertyAccessExpression(current)) {
    names.unshift(current.getName());
    current = peelValue(current.getExpression());
  }
  if (!Node.isIdentifier(current)) {
    return null;
  }
  return { root: current, names: [current.getText(), ...names] };
}

function statementOf(node: Node): Statement<Node> {
  if (Node.isVariableStatement(node)) {
    return {
      kind: "declare",
      bindings: node
        .getDeclarationList()
        .getDeclarations()
        .flatMap((declaration) =>
          declarationsOf(
            declaration.getNameNode(),
            declaration.getInitializer() ?? null,
          ),
        ),
    };
  }
  if (Node.isExpressionStatement(node)) {
    const expression = peelValue(node.getExpression());
    if (Node.isBinaryExpression(expression)) {
      const operator = expression.getOperatorToken().getText();
      if (ASSIGNMENT_OPERATORS.has(operator)) {
        return {
          kind: "assign",
          target: expression.getLeft(),
          operator: operator === "=" ? null : operator.slice(0, -1),
          value: expression.getRight(),
        };
      }
    }
    return { kind: "expression", value: node.getExpression() };
  }
  if (Node.isIfStatement(node)) {
    const otherwise = node.getElseStatement();
    return {
      kind: "branch",
      condition: node.getExpression(),
      arms: [
        armOf(node.getThenStatement()),
        otherwise === undefined ? [] : armOf(otherwise),
      ],
    };
  }
  if (Node.isSwitchStatement(node)) {
    return {
      kind: "branch",
      condition: null,
      arms: node.getClauses().map((clause) => clause.getStatements()),
    };
  }
  if (Node.isIterationStatement(node)) {
    return { kind: "loop", body: armOf(node.getStatement()) };
  }
  if (Node.isReturnStatement(node)) {
    return { kind: "return", value: node.getExpression() ?? null };
  }
  if (Node.isBlock(node)) {
    return { kind: "block", body: node.getStatements() };
  }
  if (Node.isTryStatement(node)) {
    return {
      kind: "block",
      body: [
        ...node.getTryBlock().getStatements(),
        ...(node.getFinallyBlock()?.getStatements() ?? []),
      ],
    };
  }
  return { kind: "opaque" };
}

/** The statements of an `if` arm or a loop body, braced or not. */
function armOf(statement: Node): readonly Node[] {
  return Node.isBlock(statement) ? statement.getStatements() : [statement];
}

function declarationsOf(
  nameNode: Node,
  value: Node | null,
): Declaration<Node>[] {
  if (Node.isIdentifier(nameNode)) {
    return [{ name: nameNode.getText(), value }];
  }
  if (
    Node.isObjectBindingPattern(nameNode) ||
    Node.isArrayBindingPattern(nameNode)
  ) {
    return nameNode
      .getElements()
      .flatMap((element) =>
        Node.isBindingElement(element)
          ? declarationsOf(element.getNameNode(), null)
          : [],
      );
  }
  return [];
}

function isRoot(node: Node): boolean {
  return Node.isSourceFile(node) || Node.isFunctionLikeDeclaration(node);
}

/** Whether a block is a statement of its own rather than the body of something. */
function isStandaloneBlock(node: Node): boolean {
  const parent = node.getParent();
  return (
    parent !== undefined &&
    (Node.isBlock(parent) ||
      Node.isSourceFile(parent) ||
      Node.isModuleBlock(parent) ||
      Node.isCaseClause(parent) ||
      Node.isDefaultClause(parent))
  );
}

function isPathStatement(node: Node): boolean {
  if (Node.isBlock(node)) {
    return isStandaloneBlock(node);
  }
  return Node.isStatement(node) && !Node.isFunctionDeclaration(node);
}

function siteOf(node: Node): Site<Node> | null {
  const path: Node[] = [];
  let current: Node = node;
  for (;;) {
    const parent = current.getParent();
    if (parent === undefined) {
      return null;
    }
    if (isPathStatement(current)) {
      path.unshift(current);
    }
    if (isRoot(parent)) {
      return { root: parent, path };
    }
    current = parent;
  }
}

function functionOf(node: Node): FunctionShape<Node> | null {
  if (Node.isSourceFile(node)) {
    return { parameters: [], body: node.getStatements() };
  }
  if (!Node.isFunctionLikeDeclaration(node)) {
    return null;
  }
  const parameters = node.getParameters().flatMap((parameter) => {
    const nameNode = parameter.getNameNode();
    return Node.isIdentifier(nameNode)
      ? [
          {
            name: nameNode.getText(),
            default: parameter.getInitializer() ?? null,
          },
        ]
      : [];
  });
  const body = Node.isBodied(node)
    ? node.getBody()
    : Node.isBodyable(node)
      ? node.getBody()
      : undefined;
  if (body === undefined) {
    return { parameters, body: [] };
  }
  return Node.isBlock(body)
    ? { parameters, body: body.getStatements() }
    : { parameters, body: { expression: body } };
}

/** The names a function nested somewhere under `root` writes to or mutates. */
function namesMutatedInNestedFunctions(root: Node): Set<string> {
  const mutated = new Set<string>();
  root.forEachDescendant((descendant) => {
    const written = writtenNameOf(descendant);
    if (written !== null && enclosingRootOf(descendant) !== root) {
      mutated.add(written);
    }
  });
  return mutated;
}

function writtenNameOf(node: Node): string | null {
  if (Node.isBinaryExpression(node)) {
    const target = peelValue(node.getLeft());
    return ASSIGNMENT_OPERATORS.has(node.getOperatorToken().getText()) &&
      Node.isIdentifier(target)
      ? target.getText()
      : null;
  }
  if (
    Node.isPostfixUnaryExpression(node) ||
    Node.isPrefixUnaryExpression(node)
  ) {
    const operand = peelValue(node.getOperand());
    return Node.isIdentifier(operand) ? operand.getText() : null;
  }
  if (Node.isCallExpression(node)) {
    const callee = peelValue(node.getExpression());
    if (!Node.isPropertyAccessExpression(callee)) {
      return null;
    }
    const receiver = peelValue(callee.getExpression());
    return MUTATING_METHODS.has(callee.getName()) && Node.isIdentifier(receiver)
      ? receiver.getText()
      : null;
  }
  return null;
}

function enclosingRootOf(node: Node): Node | undefined {
  let current = node.getParent();
  while (current !== undefined && !isRoot(current)) {
    current = current.getParent();
  }
  return current;
}

/** The names a function reads that it does not declare itself. */
function freeNamesOf(fn: Node): readonly string[] {
  const declared = new Set<string>();
  const read = new Set<string>();
  fn.forEachDescendant((descendant) => {
    if (!Node.isIdentifier(descendant)) {
      return;
    }
    const parent = descendant.getParent();
    if (
      Node.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === descendant
    ) {
      return;
    }
    if (
      Node.isVariableDeclaration(parent) ||
      Node.isParameterDeclaration(parent) ||
      Node.isBindingElement(parent) ||
      Node.isFunctionDeclaration(parent)
    ) {
      declared.add(descendant.getText());
      return;
    }
    if (
      Node.isPropertyAssignment(parent) &&
      parent.getNameNode() === descendant
    ) {
      return;
    }
    read.add(descendant.getText());
  });
  return [...read].filter((name) => !declared.has(name));
}
