/**
 * Runs the server over stdio.
 *
 * A host starts this as a subprocess and talks MCP over the pipe, so
 * nothing but the protocol may go to stdout. Messages for a person go to
 * stderr.
 */

import { startWithEnoughHeap } from "@suss/cli/heap";

import type { BuildReport } from "./project.js";

async function main(): Promise<void> {
  // Loaded only after the heap is settled, so a process that starts
  // itself again has not paid for loading the compiler twice.
  const [{ StdioServerTransport }, { whereReadsCameFrom }, { createServer }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("@suss/cli"),
      import("./index.js"),
    ]);

  const root = process.argv[2] ?? process.cwd();
  const { server, project } = createServer({ root });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Written once the first build finishes rather than at startup, so
  // the handshake above never waits on a cold extract.
  await project.settled();
  const report = project.lastBuild();
  for (const line of startupNotes(root, report, whereReadsCameFrom)) {
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
function startupNotes(
  root: string,
  report: BuildReport,
  whereReadsCameFrom: (root: string, declared: boolean) => string,
): string[] {
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

function serve(): Promise<void> {
  return main().catch((error: unknown) => {
    process.stderr.write(
      `[suss] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

startWithEnoughHeap(serve);
