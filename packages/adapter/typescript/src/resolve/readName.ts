/**
 * What a name-valued expression says, as fixed text with a hole for
 * each part built at run time. A table name, a bucket, a queue URL and
 * a cache key are all built the same handful of ways, and each storage
 * pack had its own copy of this before it existed. The README beside
 * this file says what each shape reads as.
 */

import { Node, SyntaxKind } from "ts-morph";

/** How far this follows a helper that calls a helper. */
const MAX_HELPER_HOPS = 2;

/** What the source calls a part it fills in at run time. */
const UNNAMED_HOLE = "param";

export interface ReadNameOptions {
  /**
   * The expression a value was written as, from the run's facts. A
   * caller with no store passes nothing, and the read runs on what the
   * source spells at the call site.
   */
  resolve?: (value: Node) => Node | null;
}

/** The name an expression states, or null when nothing settles it. */
export function readName(
  expr: Node,
  options: ReadNameOptions = {},
): string | null {
  return read(expr, {
    resolve: options.resolve ?? (() => null),
    bindings: new Map(),
    hops: 0,
    seen: new Set(),
    insideHole: false,
  });
}

/**
 * An argument, with the bindings in force where it was written. A
 * helper calling a helper passes its own parameters on, and reading
 * them where they land would lose what the first caller passed.
 */
interface Bound {
  node: Node;
  scope: Map<string, Bound[]>;
}

interface Context {
  resolve: (value: Node) => Node | null;
  /**
   * What each parameter of the helper being read was called with. A
   * rest parameter takes every argument from its position on, so a
   * binding is a list.
   */
  bindings: Map<string, Bound[]>;
  hops: number;
  seen: Set<Node>;
  /**
   * Whether this is reading a part of a longer name. A part that says
   * nothing becomes a hole, so a fallback there is left alone: what a
   * deployment sets the variable to is the part, and the default is
   * what runs when nobody set it.
   */
  insideHole: boolean;
}

function read(expr: Node, ctx: Context): string | null {
  if (ctx.seen.has(expr)) {
    return null;
  }
  const seen = new Set(ctx.seen).add(expr);
  const inner = { ...ctx, seen };

  if (
    Node.isStringLiteral(expr) ||
    Node.isNoSubstitutionTemplateLiteral(expr)
  ) {
    return expr.getLiteralValue();
  }
  if (Node.isNumericLiteral(expr)) {
    return expr.getLiteralText();
  }
  if (Node.isTemplateExpression(expr)) {
    return fromTemplate(expr, inner);
  }
  if (Node.isParenthesizedExpression(expr)) {
    return read(expr.getExpression(), inner);
  }
  if (Node.isBinaryExpression(expr)) {
    return fromBinary(expr, inner);
  }
  if (Node.isCallExpression(expr)) {
    return fromCall(expr, inner);
  }
  if (Node.isIdentifier(expr)) {
    const only = boundOnce(expr, ctx);
    // A rest parameter standing on its own says nothing. What reads it
    // is `join`, which takes the list.
    if (only !== null) {
      return read(only.node, { ...inner, bindings: only.scope });
    }
  }
  const written = ctx.resolve(expr);
  return written === null || written === expr ? null : read(written, inner);
}

function fromTemplate(expr: Node, ctx: Context): string | null {
  if (!Node.isTemplateExpression(expr)) {
    return null;
  }
  let name = expr.getHead().getLiteralText();
  for (const span of expr.getTemplateSpans()) {
    name += readOrHole(span.getExpression(), { ...ctx, insideHole: true });
    name += span.getLiteral().getLiteralText();
  }
  return name;
}

/**
 * `??` and `||` read as the default, since that is the name a service
 * uses unless a caller says otherwise.
 */
function fromBinary(expr: Node, ctx: Context): string | null {
  if (!Node.isBinaryExpression(expr)) {
    return null;
  }
  const operator = expr.getOperatorToken().getKind();
  if (
    operator === SyntaxKind.BarBarToken ||
    operator === SyntaxKind.QuestionQuestionToken
  ) {
    return ctx.insideHole ? null : read(expr.getRight(), ctx);
  }
  if (operator !== SyntaxKind.PlusToken) {
    return null;
  }
  const parts = { ...ctx, insideHole: true };
  return readOrHole(expr.getLeft(), parts) + readOrHole(expr.getRight(), parts);
}

/**
 * A call reads as what the function it goes to returns. `join` and
 * `String` are read directly, since a key builder is usually one line
 * of one of them.
 */
function fromCall(expr: Node, ctx: Context): string | null {
  if (!Node.isCallExpression(expr)) {
    return null;
  }
  const callee = expr.getExpression();

  if (Node.isPropertyAccessExpression(callee) && callee.getName() === "join") {
    return fromJoin(callee.getExpression(), expr.getArguments(), ctx);
  }
  if (Node.isIdentifier(callee) && callee.getText() === "String") {
    const only = expr.getArguments()[0];
    return only === undefined ? null : readOrHole(only, ctx);
  }
  if (ctx.hops >= MAX_HELPER_HOPS) {
    return null;
  }
  const helper = singleReturnBody(callee, ctx);
  if (helper === null) {
    return null;
  }
  return read(helper.returned, {
    ...ctx,
    hops: ctx.hops + 1,
    bindings: bind(helper.parameters, expr.getArguments(), ctx.bindings),
  });
}

/** `parts.join(":")` over a list, or over a rest parameter. */
function fromJoin(subject: Node, args: Node[], ctx: Context): string | null {
  const separator = args[0];
  if (separator === undefined || !Node.isStringLiteral(separator)) {
    return null;
  }
  const parts = elementsOf(subject, ctx);
  if (parts === null) {
    return null;
  }
  return parts
    .map((part) =>
      readOrHole(part.node, {
        ...ctx,
        bindings: part.scope,
        insideHole: true,
      }),
    )
    .join(separator.getLiteralValue());
}

/**
 * What a value being joined is a list of: an array written where it is
 * used, or a rest parameter the caller filled in.
 */
function elementsOf(subject: Node, ctx: Context): Bound[] | null {
  if (Node.isArrayLiteralExpression(subject)) {
    return subject.getElements().map((element) => here(element, ctx));
  }
  if (Node.isCallExpression(subject)) {
    // `parts.map(String).join(":")` turns each part into its own text,
    // so what matters is the list underneath.
    const callee = subject.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === "map") {
      return elementsOf(callee.getExpression(), ctx);
    }
    return null;
  }
  if (!Node.isIdentifier(subject)) {
    return null;
  }
  const bound = ctx.bindings.get(subject.getText());
  if (bound === undefined) {
    return null;
  }
  const only = bound.length === 1 ? bound[0] : undefined;
  return only !== undefined && Node.isArrayLiteralExpression(only.node)
    ? only.node.getElements().map((element) => here(element, ctx))
    : bound;
}

interface Parameter {
  name: string;
  rest: boolean;
}

interface Helper {
  parameters: Parameter[];
  returned: Node;
}

/** The function a call goes to, when its whole body is one return. */
function singleReturnBody(callee: Node, ctx: Context): Helper | null {
  const declaration = declarationOf(callee, ctx);
  if (declaration === null) {
    return null;
  }
  const parameters = declaration.getParameters().map((parameter) => ({
    name: parameter.getName(),
    rest: parameter.isRestParameter(),
  }));
  const body = declaration.getBody();
  if (body === undefined) {
    return null;
  }
  if (Node.isExpression(body)) {
    return { parameters, returned: body };
  }
  if (!Node.isBlock(body)) {
    return null;
  }
  const statements = body.getStatements();
  const only = statements[0];
  if (
    statements.length !== 1 ||
    only === undefined ||
    !Node.isReturnStatement(only)
  ) {
    return null;
  }
  const returned = only.getExpression();
  return returned === undefined ? null : { parameters, returned };
}

type Callable = {
  getParameters(): Array<{ getName(): string; isRestParameter(): boolean }>;
  getBody(): Node | undefined;
};

/** The function declaration a callee refers to, in this project. */
function declarationOf(callee: Node, ctx: Context): Callable | null {
  const symbol = Node.isPropertyAccessExpression(callee)
    ? callee.getNameNode().getSymbol()
    : callee.getSymbol();
  const declarations =
    symbol?.getAliasedSymbol()?.getDeclarations() ??
    symbol?.getDeclarations() ??
    [];
  for (const declaration of declarations) {
    const callable = asCallable(declaration);
    if (callable !== null) {
      return callable;
    }
  }
  // A helper reached through a const or an import comes back from the
  // fact layer rather than from the symbol.
  const written = ctx.resolve(callee);
  return written === null || written === callee
    ? null
    : declarationOf(written, { ...ctx, resolve: () => null });
}

/** The function a declaration is, when it is one. */
function asCallable(declaration: Node): Callable | null {
  if (
    Node.isFunctionDeclaration(declaration) ||
    Node.isMethodDeclaration(declaration) ||
    Node.isArrowFunction(declaration) ||
    Node.isFunctionExpression(declaration)
  ) {
    return declaration as unknown as Callable;
  }
  if (!Node.isVariableDeclaration(declaration)) {
    return null;
  }
  const initializer = declaration.getInitializer();
  if (
    initializer !== undefined &&
    (Node.isArrowFunction(initializer) ||
      Node.isFunctionExpression(initializer))
  ) {
    return initializer as unknown as Callable;
  }
  return null;
}

/** Each parameter to the arguments the call passed for it. */
function bind(
  parameters: Parameter[],
  args: Node[],
  scope: Map<string, Bound[]>,
): Map<string, Bound[]> {
  const bindings = new Map<string, Bound[]>();
  parameters.forEach((parameter, index) => {
    const passed = parameter.rest
      ? args.slice(index)
      : args.slice(index, index + 1);
    if (passed.length > 0) {
      bindings.set(
        parameter.name,
        passed.map((node) => ({ node, scope })),
      );
    }
  });
  return bindings;
}

/** An expression, bound where it stands. */
function here(node: Node, ctx: Context): Bound {
  return { node, scope: ctx.bindings };
}

/** The single argument an identifier is bound to, if it is bound once. */
function boundOnce(expr: Node, ctx: Context): Bound | null {
  const bound = Node.isIdentifier(expr)
    ? ctx.bindings.get(expr.getText())
    : undefined;
  return bound !== undefined && bound.length === 1 ? (bound[0] as Bound) : null;
}

/** The name a part states, or a hole for a part built at run time. */
function readOrHole(expr: Node, ctx: Context): string {
  const name = read(expr, ctx);
  return name ?? `{${holeName(expr, ctx)}}`;
}

/**
 * What the source calls a part it fills in at run time. A parameter is
 * called whatever the caller passed for it, since that is the name a
 * reader of the call site knows.
 */
function holeName(expr: Node, ctx: Context): string {
  const bound = boundOnce(expr, ctx);
  if (bound !== null) {
    return holeName(bound.node, { ...ctx, bindings: bound.scope });
  }
  if (Node.isIdentifier(expr)) {
    return expr.getText();
  }
  if (Node.isPropertyAccessExpression(expr)) {
    return expr.getName();
  }
  return UNNAMED_HOLE;
}
