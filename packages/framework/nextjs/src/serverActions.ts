/**
 * Server actions: functions the `"use server"` directive turns into
 * RPC endpoints. The call in a client component reads as a local call
 * while the runtime sends a POST, so the boundary is invisible in the
 * types; discovery makes each action its own unit, and its summary
 * shows what a button press actually runs on the server. A file-level
 * directive makes every exported function an action; a function-level
 * one marks that function alone, exported or not.
 */

import { Node, SyntaxKind } from "ts-morph";

import type { DiscoveredCustomUnit, TerminalPattern } from "@suss/extractor";
import type {
  ArrowFunction,
  Block,
  FunctionDeclaration,
  FunctionExpression,
  SourceFile,
  Statement,
} from "ts-morph";

const DIRECTIVE = "use server";

/** Actions return plain values, so the generic terminals apply. */
const ACTION_TERMINALS: TerminalPattern[] = [
  { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
];

function leadingDirectives(statements: Statement[]): string[] {
  const found: string[] = [];
  for (const statement of statements) {
    if (!Node.isExpressionStatement(statement)) {
      break;
    }
    const expression = statement.getExpression();
    if (!Node.isStringLiteral(expression)) {
      break;
    }
    found.push(expression.getLiteralValue());
  }
  return found;
}

function fileIsServerModule(sourceFile: SourceFile): boolean {
  return leadingDirectives(sourceFile.getStatements()).includes(DIRECTIVE);
}

function bodyStartsWithDirective(
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
): boolean {
  const body = fn.getBody();
  if (body === undefined || !Node.isBlock(body)) {
    return false;
  }
  return leadingDirectives((body as Block).getStatements()).includes(DIRECTIVE);
}

function actionUnit(
  func: unknown,
  name: string,
  module: string,
): DiscoveredCustomUnit {
  return {
    func,
    kind: "action",
    name,
    terminals: ACTION_TERMINALS,
    inputMapping: { type: "allPositional" },
    // The identity intent and the keyed pairing pass refer to the
    // action by. The path is absolute here and the CLI makes it
    // project-relative with every other path on the summary.
    functionCallInfo: { module, exportName: name },
  };
}

/**
 * The name an inline action goes by: the variable or property it is
 * assigned to, and a positional fallback when it is passed anonymously
 * (a `<form action={async () => {...}}>` prop).
 */
function inlineName(fn: ArrowFunction | FunctionExpression): string | null {
  const parent = fn.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  if (parent !== undefined && Node.isPropertyAssignment(parent)) {
    return parent.getName();
  }
  return null;
}

export function nextjsServerActions(
  sourceFile: unknown,
  _ctx: unknown,
): DiscoveredCustomUnit[] {
  const sf = sourceFile as SourceFile;
  if (!sf.getFullText().includes(DIRECTIVE)) {
    return [];
  }

  const out: DiscoveredCustomUnit[] = [];
  const claimed = new Set<unknown>();
  const fileLevel = fileIsServerModule(sf);
  const module = sf.getFilePath();

  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name === undefined || fn.getBody() === undefined) {
      continue;
    }

    if ((fileLevel && fn.isExported()) || bodyStartsWithDirective(fn)) {
      claimed.add(fn);
      out.push(actionUnit(fn, name, module));
    }
  }

  for (const statement of sf.getVariableStatements()) {
    if (!fileLevel || !statement.isExported()) {
      continue;
    }
    for (const decl of statement.getDeclarations()) {
      const init = decl.getInitializer();
      if (
        init !== undefined &&
        (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
      ) {
        claimed.add(init);
        out.push(actionUnit(init, decl.getName(), module));
      }
    }
  }

  let inlineIndex = 0;
  const inlineCandidates: (ArrowFunction | FunctionExpression)[] = [
    ...sf.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ];
  for (const fn of inlineCandidates) {
    if (claimed.has(fn) || !bodyStartsWithDirective(fn)) {
      continue;
    }
    claimed.add(fn);
    const name = inlineName(fn);
    if (name === null) {
      out.push(actionUnit(fn, `serverAction#${inlineIndex}`, module));
      inlineIndex += 1;
    } else {
      out.push(actionUnit(fn, name, module));
    }
  }

  return out;
}
