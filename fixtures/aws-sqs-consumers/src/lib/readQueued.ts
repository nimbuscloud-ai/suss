// A helper typed with the project's alias, in a file that never imports
// aws-lambda itself.

import type { QueuedRecord } from "./queuedRecord";

export function readQueued(record: QueuedRecord): string {
  const { id } = JSON.parse(record.body);
  return id;
}
