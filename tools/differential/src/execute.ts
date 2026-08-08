// execute.ts: run a generated handler in node:vm with a stub req/res.
//
// The stub res mirrors the Express surface the generators emit:
// `status(n)` (chainable), `json(body)`, `send(body)`, `sendStatus(n)`.
// Every terminating call records one observation; a well-formed program
// records exactly one per execution. Zero or multiple recordings are
// harness violations (a generator bug, not an extraction bug) and are
// reported as errors so they can never masquerade as findings.

import vm from "node:vm";

import type { GeneratedRequest } from "./requests.js";

export interface ObservedResponse {
  status: number;
  body: unknown;
}

export type ExecutionResult =
  | { type: "ok"; observed: ObservedResponse }
  | { type: "error"; message: string };

/**
 * Builds the response stub the vm hands the handler as its second
 * parameter: target-specific (Express `res`, Fastify `reply`, …),
 * provided by the `FuzzTarget`.
 */
export type ResponderFactory = (
  record: (observed: ObservedResponse) => void,
) => object;

function cloneRequest(request: GeneratedRequest): GeneratedRequest {
  return {
    params: { ...request.params },
    query: { ...request.query },
    headers: { ...request.headers },
    body: { ...request.body },
  };
}

/**
 * Execute `handlerSource` (an arrow-function expression) against a
 * request, with the target's response stub bound to the handler's
 * second parameter. Synchronous handlers only, the generators never
 * emit `await`, and the harness would misreport a dangling promise.
 */
export function executeHandler(
  handlerSource: string,
  request: GeneratedRequest,
  makeResponder: ResponderFactory,
): ExecutionResult {
  const responses: ObservedResponse[] = [];
  const sandbox = {
    req: cloneRequest(request),
    res: makeResponder((observed) => {
      responses.push(observed);
    }),
  };

  try {
    vm.runInNewContext(
      `const handler = ${handlerSource};\nhandler(req, res);`,
      sandbox,
      { timeout: 1000 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "error", message: `handler threw: ${message}` };
  }

  if (responses.length === 0) {
    return { type: "error", message: "handler produced no response" };
  }
  if (responses.length > 1) {
    return {
      type: "error",
      message: `handler produced ${responses.length} responses`,
    };
  }
  return { type: "ok", observed: responses[0] };
}
