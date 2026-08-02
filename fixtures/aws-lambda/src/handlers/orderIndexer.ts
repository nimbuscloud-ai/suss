import { makeWidgetHandler } from "../lib/makeWidgetHandler";

// One of two consumers of `order.placed`. The subject alone cannot
// tell this handler's subscription from the notifier's, so both sides
// have to name the Lambda they run in.
export const handler = makeWidgetHandler(
  {
    name: "order-indexer",
    subject: "order.placed" as const,
    createLogger: (name) => ({
      info: (msg: string) => {
        process.stdout.write(`${name}: ${msg}\n`);
      },
    }),
  },
  async ({ parsed }) => {
    await process.stdout.write(`index ${JSON.stringify(parsed.data)}\n`);
  },
);
