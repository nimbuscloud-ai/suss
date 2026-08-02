import { makeWidgetHandler } from "../lib/makeWidgetHandler";

// The second consumer of `order.placed`, in its own Lambda behind its
// own queue.
export const handler = makeWidgetHandler(
  {
    name: "order-notifier",
    subject: "order.placed" as const,
    createLogger: (name) => ({
      info: (msg: string) => {
        process.stdout.write(`${name}: ${msg}\n`);
      },
    }),
  },
  async ({ parsed }) => {
    await process.stdout.write(`notify ${JSON.stringify(parsed.data)}\n`);
  },
);
