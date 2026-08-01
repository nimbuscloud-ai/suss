import { createEventHandler } from "../lib/createEventHandler";

// SQS consumer built by the subject-naming factory. The config's
// `expected` property is the channel subject, so the unit carries a
// message-bus binding on it and pairs with whoever publishes it.
export const handler = createEventHandler(
  {
    name: "subject-worker",
    expected: "billing.invoicePaid" as const,
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
