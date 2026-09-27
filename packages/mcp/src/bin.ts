/**
 * Runs the server over stdio.
 *
 * A host starts this as a subprocess and talks MCP over the pipe, so
 * nothing but the protocol may go to stdout. Messages for a person go to
 * stderr.
 */

import { startWithEnoughHeap } from "@suss/cli/heap";

import type { LiveSocket } from "./liveSocket.js";
import type { BuildReport, Project } from "./project.js";

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
  const { server, project, live } = createServer({ root, live: true });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  stopWhenTheHostLeaves(live, project);

  // Written once the first build finishes rather than at startup, so
  // the handshake above never waits on a cold extract.
  await project.settled();
  const report = project.lastBuild();
  for (const line of startupNotes(root, report, whereReadsCameFrom)) {
    process.stderr.write(`[suss] ${line}\n`);
  }
  await live;
}

/**
 * Gives up the socket and exits when the host closes stdin or sends a
 * signal. A host can drop the pipe without a signal, and the file
 * watcher would otherwise keep the process running with the program.
 */
function stopWhenTheHostLeaves(
  live: Promise<LiveSocket> | null,
  project: Project,
): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void Promise.resolve(live)
      .then(
        (socket) => socket?.close(),
        () => undefined,
      )
      .finally(() => {
        project.close();
        process.exit(0);
      });
  };
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
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
