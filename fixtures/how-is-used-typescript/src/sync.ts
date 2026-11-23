import { Queue, Worker } from "bullmq";

import { send } from "./outbound";
import { enabled } from "./settings";

export const syncQueue = new Queue("sync");

new Worker("sync", async (job) => {
  if (!(await enabled("sync:orders"))) {
    return;
  }
  await send(`https://api.example.com/sync/${job.data.orderId}`, "post");
});
