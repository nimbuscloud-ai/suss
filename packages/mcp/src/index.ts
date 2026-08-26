/**
 * index.ts: the MCP server over suss.
 *
 * A model working in a repository can ask what a route serves, what
 * reads a table, and where the two sides of a boundary disagree, at the
 * moment it decides the question is worth asking. That is the point of
 * this over a document: a document is read once at the start of a
 * session, and a tool arrives with the decision.
 *
 * The server keeps the summaries current while it runs, so an answer
 * describes the working tree rather than whatever was last extracted.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { Project } from "./project.js";
import {
  ASK_DESCRIPTION,
  askTool,
  attempt,
  CHECK_DESCRIPTION,
  checkTool,
  INSPECT_DESCRIPTION,
  inspectTool,
  STATUS_DESCRIPTION,
  statusTool,
} from "./tools.js";

import type { ProjectOptions } from "./project.js";

export { Project } from "./project.js";

export type { BuildReport, ProjectOptions } from "./project.js";

/**
 * A server with the tools registered, not yet connected.
 *
 * The caller connects it to a transport, so the same server runs over
 * stdio from the binary or inside a host that speaks something else.
 */
export async function createServer(
  options: ProjectOptions,
): Promise<{ server: McpServer; project: Project }> {
  const project = new Project(options);
  await project.start();

  const server = new McpServer({
    name: "suss",
    version: VERSION,
  });

  server.registerTool(
    "suss_ask",
    {
      title: "Ask about a boundary",
      description: ASK_DESCRIPTION,
      annotations: READ_ONLY,
      inputSchema: {
        question: z
          .string()
          .describe("One of the seven questions, in the words listed above."),
      },
    },
    (args) => attempt("suss_ask", () => askTool(project, args)),
  );

  server.registerTool(
    "suss_check",
    {
      title: "Check both sides of every boundary",
      description: CHECK_DESCRIPTION,
      annotations: READ_ONLY,
      inputSchema: {
        boundary: z
          .string()
          .optional()
          .describe(
            'One boundary, file, or file:line to narrow to, such as "GET /users/:id" or "src/orders.ts". Leave it out for the whole project.',
          ),
      },
    },
    (args) =>
      attempt("suss_check", () =>
        checkTool(
          project,
          args.boundary === undefined ? {} : { boundary: args.boundary },
        ),
      ),
  );

  server.registerTool(
    "suss_boundaries",
    {
      title: "List the boundaries and how they pair",
      description: INSPECT_DESCRIPTION,
      annotations: READ_ONLY,
      inputSchema: {},
    },
    () => attempt("suss_boundaries", () => inspectTool(project)),
  );

  server.registerTool(
    "suss_status",
    {
      title: "What this server is answering from",
      description: STATUS_DESCRIPTION,
      annotations: READ_ONLY,
      inputSchema: {},
    },
    () => attempt("suss_status", () => statusTool(project)),
  );

  return { server, project };
}

/**
 * Every tool here reads.
 *
 * A host decides whether to ask a person before running something, and
 * these say it never has to: nothing changes a file, asking twice gives
 * the same answer, and the server talks to this machine alone.
 */
const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/**
 * Stamped at build time so the server reports the version it was
 * published at. tsup replaces it; the fallback is what a source run
 * reports.
 */
const VERSION = process.env.npm_package_version ?? "0.0.0-dev";
