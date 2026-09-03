/**
 * bin.ts: run the server over stdio.
 *
 * A host starts this as a subprocess and speaks MCP down the pipe, so
 * nothing may go to stdout except the protocol. Anything worth saying
 * to a person goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./index.js";

async function main(): Promise<void> {
  const root = process.argv[2] ?? process.cwd();
  const { server, project } = createServer({ root });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Written once the first build finishes rather than at startup, so
  // the handshake above never waits on a cold extract.
  await project.settled();
  const report = project.lastBuild();
  if (!report.configured) {
    process.stderr.write(
      `[suss] ${root} has no suss.json, so every answer will be empty. Run \`suss init\` there.\n`,
    );
  }
  for (const failure of report.failed) {
    process.stderr.write(`[suss] ${failure}\n`);
  }

  const stop = (): void => {
    project.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[suss] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
