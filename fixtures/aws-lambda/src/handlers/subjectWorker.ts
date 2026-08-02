import { makeWidgetHandler } from "../lib/makeWidgetHandler";

// SQS consumer built by the subject-naming factory. The config's
// `subject` property is the channel subject, so the unit carries a
// message-bus binding on it and pairs with whoever publishes it.
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
