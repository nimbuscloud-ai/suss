/**
 * Finds the functions a `"use server"` directive turns into server
 * actions and makes each one an `action` unit. The README describes which
 * functions count.
 */

import { Node } from "ts-morph";

import type { TsDiscoveryContext } from "@suss/adapter-typescript";
import type { DiscoveredCustomUnit, TerminalPattern } from "@suss/extractor";
import type {
  ArrowFunction,
  FunctionDeclaration,
  FunctionExpression,
  MethodDeclaration,
  SourceFile,
  Statement,
} from "ts-morph";

const DIRECTIVE = "use server";

/** Actions return plain values, so the generic terminals apply. */
const ACTION_TERMINALS: TerminalPattern[] = [
  { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
];

type WrittenFunction =
  | FunctionDeclaration
  | MethodDeclaration
  | ArrowFunction
  | FunctionExpression;

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

function bodyStartsWithDirective(fn: WrittenFunction): boolean {
  const body = fn.getBody();
  if (body === undefined || !Node.isBlock(body)) {
    return false;
  }
  return leadingDirectives(body.getStatements()).includes(DIRECTIVE);
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
    // Intent files and keyed pairing find the action by module and export
    // name. The path is absolute here, and the CLI makes it relative to
    // the project along with every other path on the summary.
    functionCallInfo: { module, exportName: name },
  };
}

/**
 * Each function the module exports, under the name it is exported as. A
 * call written as the export, such as a caching helper's, is the closure
 * it gives back when that closure never calls what it was handed, since
 * the closure is what the client's call runs.
 */
function exportedFunctionsOf(
  sf: SourceFile,
  ctx: TsDiscoveryContext,
): { name: string; func: unknown }[] {
  const followed = new Map<string, unknown>(
    ctx.exportedFunctions(sf).map(({ name, func }) => [name, func]),
  );
  const found: { name: string; func: unknown }[] = [];
  for (const [name, [first]] of ctx.resolution.exportsOf(sf)) {
    const func =
      followed.get(name) ??
      (first === undefined
        ? null
        : ctx.resolution.resolveReturnedCallable(first));
    if (func !== null) {
      found.push({ name, func });
    }
  }
  return found;
}

/** Every function the file writes, declared, assigned or written in place, in source order. */
function functionsIn(sf: SourceFile): WrittenFunction[] {
  const found: WrittenFunction[] = [];
  sf.forEachDescendant((node) => {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node)
    ) {
      found.push(node);
    }
  });
  return found;
}

/**
 * A declaration's own name, or the variable or property a function
 * written in place is assigned to. An action passed anonymously, as in
 * `<form action={async () => {...}}>`, gets null here, and the caller
 * numbers it.
 */
function assignedNameOf(fn: WrittenFunction): string | null {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName() ?? null;
  }
  const parent = fn.getParent();
  if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)) {
    return parent.getName();
  }
  return null;
}

export function nextjsServerActions(
  sourceFile: unknown,
  ctx: unknown,
): DiscoveredCustomUnit[] {
  const sf = sourceFile as SourceFile;
  if (!sf.getFullText().includes(DIRECTIVE)) {
    return [];
  }

  const out: DiscoveredCustomUnit[] = [];
  const claimed = new Set<unknown>();
  const module = sf.getFilePath();

  if (leadingDirectives(sf.getStatements()).includes(DIRECTIVE)) {
    for (const { name, func } of exportedFunctionsOf(
      sf,
      ctx as TsDiscoveryContext,
    )) {
      if (claimed.has(func)) {
        continue;
      }
      claimed.add(func);
      out.push(actionUnit(func, name, module));
    }
  }

  let inlineIndex = 0;
  for (const fn of functionsIn(sf)) {
    if (claimed.has(fn) || !bodyStartsWithDirective(fn)) {
      continue;
    }
    claimed.add(fn);
    const name = assignedNameOf(fn);
    if (name === null) {
      out.push(actionUnit(fn, `serverAction#${inlineIndex}`, module));
      inlineIndex += 1;
    } else {
      out.push(actionUnit(fn, name, module));
    }
  }

  return out;
}
