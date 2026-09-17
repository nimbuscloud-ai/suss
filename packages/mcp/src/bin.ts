/**
 * bin.ts: run the server over stdio.
 *
 * A host starts this as a subprocess and speaks MCP down the pipe, so
 * nothing may go to stdout except the protocol. Anything worth saying
 * to a person goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { whereReadsCameFrom } from "@suss/cli";

import { createServer } from "./index.js";

import type { BuildReport } from "./project.js";

async function main(): Promise<void> {
  const root = process.argv[2] ?? process.cwd();
  const { server, project } = createServer({ root });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Written once the first build finishes rather than at startup, so
  // the handshake above never waits on a cold extract.
  await project.settled();
  const report = project.lastBuild();
  for (const line of startupNotes(root, report)) {
    process.stderr.write(`[suss] ${line}\n`);
  }

  const stop = (): void => {
    project.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** What a person should know about where the answers come from. */
function startupNotes(root: string, report: BuildReport): string[] {
  if (report.configured) {
    return report.failed;
  }
  if (report.ran.length + report.failed.length === 0) {
    return [
      `Nothing in ${root} matched a pack, so every answer will be empty. Run \`suss init\` there to see what suss looked for.`,
    ];
  }
  return [whereReadsCameFrom(root, false), ...report.failed];
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[suss] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
