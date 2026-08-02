import { makeWidgetHandler } from "../lib/makeWidgetHandler";

const source = "billing";

// Same factory, but the subject is computed. Nothing readable names
// the channel, so the unit keeps its fallback binding rather than
// carrying a guessed one.
export const handler = makeWidgetHandler(
  {
    name: "computed-subject",
    subject: `${source}.refundIssued`,
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
