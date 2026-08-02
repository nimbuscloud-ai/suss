import { createEventHandler } from "../lib/createEventHandler";

// The second consumer of `order.placed`, in its own Lambda behind its
// own queue.
export const handler = createEventHandler(
  {
    name: "order-notifier",
    expected: "order.placed" as const,
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
