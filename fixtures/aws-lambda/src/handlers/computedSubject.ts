import { createEventHandler } from "../lib/createEventHandler";

const source = "billing";

// Same factory, but the subject is computed. Nothing readable names
// the channel, so the unit keeps its fallback binding rather than
// carrying a guessed one.
export const handler = createEventHandler(
  {
    name: "computed-subject",
    expected: `${source}.refundIssued`,
    createLogger: () => ({
      info: () => {
        return;
      },
    }),
  },
  async ({ parsed }) => {
    await process.stdout.write(JSON.stringify(parsed.data));
  },
);
