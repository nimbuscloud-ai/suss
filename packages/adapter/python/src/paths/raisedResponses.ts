/**
 * The places a route body ends the request by raising.
 *
 * A pack says which of its library's callables end a request with a
 * status. A `raise` of one of them, and a bare call to one written as a
 * statement of its own, both become a throw terminal the extractor reads
 * as the response the library sends. Any other `raise` becomes a throw
 * terminal with no status, so the outcome is still reported without a
 * status nobody wrote being claimed for it.
 *
 * The match goes through the file's own imports, so a project function
 * spelled `abort` is not mistaken for Flask's.
 */

import { constantOf } from "@suss/values";

import { field, rangeOf, stringLiteralValue } from "../ast.js";
import { evaluatedValue } from "../values/evaluator.js";
import { originOf } from "../values/origin.js";

import type { Database } from "@suss/datalog";
import type { RawTerminal } from "@suss/extractor";
import type { PyStatusCall } from "../pack.js";
import type { PyNode } from "../parser.js";
import type { ModuleBinding } from "../scope.js";

export interface RaisedResponse {
  /** The statement the path engine gives conditions to. */
  statement: PyNode;
  /** True when the statement is no `raise`, so the lowering has to be told it leaves the unit. */
  thrownByCall: boolean;
  terminal: RawTerminal;
}

export interface RaisedResponseOptions {
  readonly calls: readonly PyStatusCall[];
  readonly module: ModuleBinding;
  readonly facts: Database | undefined;
}

/** A body written in one of these belongs to the function it declares. */
const NESTED_DEFINITION_TYPES = new Set(["function_definition", "lambda"]);

/**
 * Every raise this function's own body writes, plus every statement that
 * is a bare call to something the pack declared, in source order.
 */
export function raisedResponses(
  body: PyNode | null,
  options: RaisedResponseOptions,
): RaisedResponse[] {
  if (body === null || options.calls.length === 0) {
    return [];
  }

  const found: RaisedResponse[] = [];
  const walk = (node: PyNode): void => {
    for (const child of node.namedChildren) {
      if (child === null || NESTED_DEFINITION_TYPES.has(child.type)) {
        continue;
      }
      const response = raisedResponseOf(child, options);
      if (response !== null) {
        found.push(response);
      }
      walk(child);
    }
  };
  walk(body);
  return found;
}

/** The expression a statement ends the request with, per statement kind. */
const ENDING_EXPRESSION: Record<string, (statement: PyNode) => PyNode | null> =
  {
    raise_statement: (statement) => statement.namedChildren[0] ?? null,
    expression_statement: (statement) => {
      const only = statement.namedChildren[0];
      return only?.type === "call" ? only : null;
    },
  };

function raisedResponseOf(
  statement: PyNode,
  options: RaisedResponseOptions,
): RaisedResponse | null {
  const expression = ENDING_EXPRESSION[statement.type]?.(statement) ?? null;
  if (expression === null) {
    return null;
  }

  const thrownByCall = statement.type !== "raise_statement";
  const call = expression.type === "call" ? expression : null;
  const callee = calleeOf(expression, call);
  const declared = declaredCallFor(callee, options);
  // A bare call is an outcome only where the pack said the library ends
  // the request with it. Anything else about it is somebody's ordinary call.
  if (declared === undefined && thrownByCall) {
    return null;
  }

  return {
    statement,
    thrownByCall,
    terminal: terminalOf(statement, callee, call, declared, options.facts),
  };
}

/** The name being called, which for a class written without parentheses is the class itself. */
function calleeOf(expression: PyNode, call: PyNode | null): PyNode {
  return call === null ? expression : (field(call, "function") ?? expression);
}

/** The pattern this callee matches, read through what the file imported the name from. */
function declaredCallFor(
  callee: PyNode,
  options: RaisedResponseOptions,
): PyStatusCall | undefined {
  const origin = originOf(callee, options.module);
  if (origin === null) {
    return undefined;
  }

  const qualified = `${origin.module}.${origin.name}`;
  return options.calls.find((call) => call.callee === qualified);
}

function terminalOf(
  statement: PyNode,
  callee: PyNode,
  call: PyNode | null,
  declared: PyStatusCall | undefined,
  facts: Database | undefined,
): RawTerminal {
  return {
    kind: "throw",
    statusCode: declared === undefined ? null : statusOf(declared, call, facts),
    body: null,
    exceptionType: lastSegmentOf(declared?.callee ?? callee.text),
    message: call === null ? null : writtenMessageOf(call),
    ...(declared === undefined ? {} : { producesResponse: true }),
    component: null,
    renderTree: null,
    delegateTarget: null,
    emitEvent: null,
    location: rangeOf(statement),
  };
}

function lastSegmentOf(dotted: string): string | null {
  const segment = dotted.split(".").pop();
  return segment === undefined || segment === "" ? null : segment;
}

/**
 * The status the call ends the request with. An argument that does not
 * come down to a number is reported as the text it was written as, so a
 * reader sees an outcome nobody could resolve rather than a status the
 * running app may not send.
 */
function statusOf(
  declared: PyStatusCall,
  call: PyNode | null,
  facts: Database | undefined,
): RawTerminal["statusCode"] {
  const written = call === null ? null : statusArgumentOf(declared, call);
  if (written === null) {
    return declared.defaultStatusCode === undefined
      ? null
      : { type: "literal", value: declared.defaultStatusCode };
  }

  const value = constantOf(evaluatedValue(written, facts));
  if (typeof value === "number") {
    return { type: "literal", value };
  }
  return { type: "dynamic", sourceText: written.text };
}

function argumentsOf(call: PyNode): PyNode[] {
  return (field(call, "arguments")?.namedChildren ?? []).filter(
    (child): child is PyNode => child !== null,
  );
}

/** The keyword wins over the position, the way a call written both ways runs. */
function statusArgumentOf(declared: PyStatusCall, call: PyNode): PyNode | null {
  const args = argumentsOf(call);
  const keyed = args.find(
    (arg) =>
      arg.type === "keyword_argument" &&
      field(arg, "name")?.text === declared.statusKeyword,
  );
  if (keyed !== undefined) {
    return field(keyed, "value");
  }

  if (declared.statusArgument === undefined) {
    return null;
  }
  const positional = args.filter((arg) => arg.type !== "keyword_argument");
  return positional[declared.statusArgument] ?? null;
}

/**
 * The first string literal the call was given, wherever it was written.
 * Every library spells this differently, and a message read off the
 * wrong argument would still be the message a reader sees.
 */
function writtenMessageOf(call: PyNode): string | null {
  for (const arg of argumentsOf(call)) {
    const value = arg.type === "keyword_argument" ? field(arg, "value") : arg;
    const literal = value === null ? null : stringLiteralValue(value);
    if (literal !== null) {
      return literal;
    }
  }
  return null;
}
