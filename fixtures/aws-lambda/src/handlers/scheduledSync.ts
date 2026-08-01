import type { ScheduledEvent } from "aws-lambda";

// Scheduled job. No HTTP route reaches it, so the pack surfaces it as
// recognized-not-http, and no envelope constrains what it returns: it
// answers its invoker with an arbitrary summary object, and the
// non-HTTP terminal list reads the shape at the return site.
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
  };
};
