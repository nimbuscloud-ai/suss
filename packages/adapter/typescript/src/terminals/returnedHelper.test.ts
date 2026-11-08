// returnedHelper.test.ts: a handler that returns the response a project
// function of its own builds.

import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { findTerminals } from "./index.js";

import type { TerminalPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";

/** How the Next.js pack declares `new Response(body, { status })`. */
const NEW_RESPONSE: TerminalPattern = {
  kind: "response",
  match: { type: "functionCall", functionName: "Response" },
  extraction: {
    body: { from: "argument", position: 0 },
    statusCode: { from: "argumentProperty", position: 1, name: "status" },
    defaultStatusCode: 200,
  },
};

/** How the Express pack declares `res.status(n).json(body)` and `res.json(body)`. */
const EXPRESS: TerminalPattern[] = [
  {
    kind: "response",
    match: {
      type: "parameterMethodCall",
      parameterPosition: 1,
      methodChain: ["status", "json"],
    },
    extraction: {
      statusCode: { from: "argument", position: 0 },
      body: { from: "argument", position: 0 },
    },
  },
  {
    kind: "response",
    match: {
      type: "parameterMethodCall",
      parameterPosition: 1,
      methodChain: ["json"],
    },
    extraction: {
      body: { from: "argument", position: 0 },
      defaultStatusCode: 200,
    },
  },
];

/** How the Hono pack declares `c.json(body, status)`. */
const HONO_JSON: TerminalPattern = {
  kind: "response",
  match: {
    type: "parameterMethodCall",
    parameterPosition: 0,
    methodChain: ["json"],
  },
  extraction: {
    statusCode: { from: "argument", position: 1 },
    body: { from: "argument", position: 0 },
    defaultStatusCode: 200,
  },
};

/** How the Fastify pack takes any other returned value as a 200. */
const FASTIFY_RETURN: TerminalPattern = {
  kind: "response",
  match: { type: "returnStatement", excludeCallReturns: true },
  extraction: { defaultStatusCode: 200 },
};

/** How the Fastify pack declares `reply.code(n).send(body)`. */
const FASTIFY_CODE_SEND: TerminalPattern = {
  kind: "response",
  match: {
    type: "parameterMethodCall",
    parameterPosition: 1,
    methodChain: ["code", "send"],
  },
  extraction: {
    statusCode: { from: "argument", position: 0 },
    body: { from: "argument", position: 0 },
  },
};

/** The handler's terminals, with every file given and helpers resolved through the store. */
function terminalsOf(
  files: Record<string, string>,
  patterns: TerminalPattern[],
) {
  const project = createTestProject();
  for (const [path, text] of Object.entries(files)) {
    project.createSourceFile(path, text);
  }
  const handler = project
    .getSourceFiles()
    .flatMap((file) =>
      file.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    )
    .find((fn) => fn.getName() === "handler") as FunctionRoot | undefined;
  if (handler === undefined) {
    throw new Error("the fixture needs a function named handler");
  }
  const store = new ResolutionStore();
  return findTerminals(
    handler,
    patterns,
    undefined,
    store,
    undefined,
    (callee) => store.resolveCallable(callee),
  );
}

function statusesOf(found: ReturnType<typeof terminalsOf>): unknown[] {
  return found.map((one) => one.terminal.statusCode);
}

const LOG_AND_RESPOND = `
  export function logAndRespond(
    body: string | Record<string, unknown>,
    { status = 200, logLevel = "info" }: { status?: number; logLevel?: string } = {},
  ) {
    if (typeof body === "string") {
      console.log(logLevel, body);
      return new Response(body, { status });
    }
    return new Response(JSON.stringify(body), { status });
  }
`;

describe("a return through a project function that builds the response", () => {
  it("reads the status the caller passes and the default it leaves", () => {
    const found = terminalsOf(
      {
        "/utils.ts": LOG_AND_RESPOND,
        "/route.ts": `
          import { logAndRespond } from "./utils";
          export async function handler(req: Request) {
            if (!req.headers.get("signature")) {
              return logAndRespond("No signature.", { status: 401 });
            }
            return logAndRespond("Done.");
          }
        `,
      },
      [NEW_RESPONSE],
    );

    // Each of the helper's two returns at each call site. The assembly
    // pass keeps one per status and line.
    expect(statusesOf(found)).toEqual([
      { type: "literal", value: 401 },
      { type: "literal", value: 401 },
      { type: "literal", value: 200 },
      { type: "literal", value: 200 },
    ]);
    expect(found[0]?.terminal.body?.shape).toEqual({
      type: "literal",
      value: "No signature.",
    });
  });

  it("puts the response at the caller's return, so the call stays an effect", () => {
    const found = terminalsOf(
      {
        "/utils.ts": LOG_AND_RESPOND,
        "/route.ts": `
          import { logAndRespond } from "./utils";
          export async function handler(req: Request) {
            return logAndRespond("Done.");
          }
        `,
      },
      [NEW_RESPONSE],
    );

    const node = found[0]?.node;
    expect(node?.getKind()).toBe(SyntaxKind.ReturnStatement);
    expect(found[0]?.source).toBe(node);
    expect(found[0]?.terminal.location).toEqual({ start: 4, end: 4 });
  });

  it("follows a helper that returns another helper's call", () => {
    const found = terminalsOf(
      {
        "/utils.ts": LOG_AND_RESPOND,
        "/events.ts": `
          import { logAndRespond } from "./utils";
          export async function handleEvent(kind: string) {
            if (kind === "unknown") {
              return logAndRespond("Unsupported.", { status: 400 });
            }
            return logAndRespond("Handled.");
          }
        `,
        "/route.ts": `
          import { handleEvent } from "./events";
          export async function handler(req: Request) {
            return await handleEvent(req.method);
          }
        `,
      },
      [NEW_RESPONSE],
    );

    expect(new Set(statusesOf(found).map((s) => JSON.stringify(s)))).toEqual(
      new Set([
        JSON.stringify({ type: "literal", value: 400 }),
        JSON.stringify({ type: "literal", value: 200 }),
      ]),
    );
  });

  it("reads a status the helper cannot settle as dynamic", () => {
    const found = terminalsOf(
      {
        "/errors.ts": `
          function statusFor(error: unknown): number {
            return error instanceof Error ? 500 : 400;
          }
          export function handleError(error: unknown) {
            const status = statusFor(error);
            return new Response(String(error), { status });
          }
        `,
        "/route.ts": `
          import { handleError } from "./errors";
          export async function handler(req: Request) {
            try {
              return new Response("ok");
            } catch (error) {
              return handleError(error);
            }
          }
        `,
      },
      [NEW_RESPONSE],
    );

    expect(statusesOf(found)).toEqual([
      { type: "literal", value: 200 },
      { type: "dynamic", sourceText: "status" },
    ]);
  });

  it("stops at a helper that returns its own call", () => {
    const found = terminalsOf(
      {
        "/route.ts": `
          function respond(kind: string): Response {
            if (kind === "gone") {
              return new Response("gone", { status: 410 });
            }
            return respond("gone");
          }
          export function handler() {
            return respond("other");
          }
        `,
      },
      [NEW_RESPONSE],
    );

    expect(statusesOf(found)).toEqual([{ type: "literal", value: 410 }]);
  });

  it("reads a helper's write to the response the caller handed it", () => {
    const found = terminalsOf(
      {
        "/route.ts": `
          function sendError(res: any, status: number, message: string) {
            return res.status(status).json({ error: message });
          }
          export function handler(req: any, res: any) {
            if (!req.user) {
              return sendError(res, 404, "missing");
            }
            res.json({ ok: true });
          }
        `,
      },
      EXPRESS,
    );

    expect(statusesOf(found)).toEqual([
      { type: "literal", value: 404 },
      { type: "literal", value: 200 },
    ]);
    expect(found[0]?.terminal.body?.shape).toEqual({
      type: "record",
      properties: { error: { type: "literal", value: "missing" } },
    });
  });

  it("finds the handed response at whichever argument the helper takes it", () => {
    const found = terminalsOf(
      {
        "/route.ts": `
          function notFound(message: string, c: any) {
            return c.json({ message }, 404);
          }
          export function handler(c: any) {
            return notFound("no such order", c);
          }
        `,
      },
      [HONO_JSON],
    );

    expect(statusesOf(found)).toEqual([{ type: "literal", value: 404 }]);
  });

  it("leaves a helper alone when the caller did not hand it the response", () => {
    const found = terminalsOf(
      {
        "/route.ts": `
          function log(res: any) {
            return res.json({ logged: true });
          }
          export function handler(req: any, res: any) {
            return log(req);
          }
        `,
      },
      EXPRESS,
    );

    expect(found).toEqual([]);
  });

  it("leaves a call to a function the caller was given to whoever passed it", () => {
    const found = terminalsOf(
      {
        "/route.ts": `
          export function handler(next: () => Response) {
            return next();
          }
          export const GET = handler(() => new Response("ok"));
        `,
      },
      [NEW_RESPONSE],
    );

    expect(found).toEqual([]);
  });

  it("keeps a returned value as the response when the helper builds none", () => {
    const found = terminalsOf(
      {
        "/route.ts": `
          function findUser(id: string) {
            return { id };
          }
          export function handler(request: any, reply: any) {
            return findUser(request.params.id);
          }
        `,
      },
      [FASTIFY_RETURN],
    );

    expect(statusesOf(found)).toEqual([{ type: "literal", value: 200 }]);
    expect(found[0]?.node.getKind()).toBe(SyntaxKind.ReturnStatement);
  });

  it("reads the helper's reply before a catch-all return takes the call as a 200", () => {
    const found = terminalsOf(
      {
        "/route.ts": `
          function notFound(reply: any) {
            return reply.code(404).send({ error: "not found" });
          }
          export function handler(request: any, reply: any) {
            return notFound(reply);
          }
        `,
      },
      [FASTIFY_CODE_SEND, FASTIFY_RETURN],
    );

    expect(statusesOf(found)).toEqual([{ type: "literal", value: 404 }]);
  });
});
