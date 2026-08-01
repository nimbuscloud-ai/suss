import type { ScheduledEvent } from "aws-lambda";

interface SyncSummary {
  message: string;
  summary: { processed: number; skipped: number };
  requestId: string;
  success: boolean;
}

// Scheduled job. No HTTP route reaches it, so the pack surfaces it as
// recognized-not-http, and no envelope constrains what it returns: it
// answers its invoker with an arbitrary summary object, and the
// non-HTTP terminal list reads the shape at the return site.
//
// The returned object names its type, the way a job whose result
// another module reads usually does. The wrapper carries the value
// along without changing it, so this is one return and one transition.
export const handler = async (
  event: ScheduledEvent,
  context: { awsRequestId: string },
) => {
  const processed = event.resources.length;
  return {
    message: "sync complete",
    summary: { processed, skipped: 0 },
    requestId: context.awsRequestId,
    success: true,
  } satisfies SyncSummary;
};
