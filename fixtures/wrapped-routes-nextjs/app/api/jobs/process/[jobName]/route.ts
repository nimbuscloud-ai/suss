// A route the library's wrapper is applied to directly.

import { withAxiomBodyLog } from "../../../../../lib/axiom/server";

declare function runJob(name: string): Promise<boolean>;

export const POST = withAxiomBodyLog(
  async (req: Request, { params }: { params: Promise<{ jobName: string }> }) => {
    const { jobName } = await params;
    if (!(await runJob(jobName))) {
      return new Response(`unknown job ${jobName}`, { status: 404 });
    }
    return new Response("done", { status: 200 });
  },
);
