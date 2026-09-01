import { makeWidgetHandler } from "../lib/makeWidgetHandler";

// SQS consumer whose export a handler factory built. The subject in
// the config is a field of the message rather than the channel; the
// channel is the queue the template puts in front of this function.
export const handler = makeWidgetHandler(
  {
    name: "subject-worker",
    subject: "billing.invoicePaid" as const,
    createLogger: (name) => ({
      info: (msg: string) => {
        process.stdout.write(`${name}: ${msg}\n`);
      },
    }),
  },
  async ({ parsed }) => {
    await process.stdout.write(JSON.stringify(parsed.data));
  },
);
